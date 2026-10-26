import { authorize, Permission } from "@yummyai/authz";
import { catalogPlanFilter, currentCatalogContext } from "@yummyai/catalog-core";
import type { TenantContext } from "@yummyai/contracts";
import { KnowledgeSearchSchema, KnowledgeSearchResultSchema } from "@yummyai/contracts/knowledge";
import {
  knowledgeEntries as entries, knowledgeVersions as versions, spus, productPlans, withTenant,
  type DatabaseConnection, type TenantTransaction,
} from "@yummyai/database";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { knowledgeEvidenceIssues, knowledgeBlockingConflicts } from "./governance.js";
import { knowledgeEligible, knowledgeExcerpt, knowledgeToday, scoreKnowledge } from "./knowledge-retriever.js";

export class KnowledgeSearchOwnerError extends Error {
  readonly status = 404;
  readonly statusCode = 404;
  readonly code = "knowledge_search_scope_not_found";
  constructor(readonly body: string) {
    super(body);
    this.name = "KnowledgeSearchOwnerError";
  }
}

/** Current object access, independent of an immutable answer's historical pins. */
export async function knowledgeProductsVisible(
  tx: TenantTransaction, context: TenantContext, ids: readonly string[], options: { lock?: boolean } = {},
) {
  if (!ids.length) return true;
  if (!context.permissions.includes(Permission.ProductRead)) return false;
  const selected = [...new Set(ids.map(id => id.toLowerCase()))];
  const query = tx.select({ id: spus.id }).from(spus)
    .innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
    .where(and(inArray(spus.id, selected), catalogPlanFilter(context, Permission.ProductRead)));
  const visible = await (options.lock ? query.for("share", { of: [spus, productPlans] }) : query);
  return visible.length === selected.length;
}

/** The original published-knowledge owner; it performs no model or write operation. */
export class KnowledgeSearchOwner {
  constructor(private readonly database: DatabaseConnection) {}

  async search(context: TenantContext, raw: unknown) {
    authorize(context, Permission.WorkflowRead);
    const input = KnowledgeSearchSchema.parse(raw),
      today = knowledgeToday();
    if (input.spuIds.length) authorize(context, Permission.ProductRead);
    return withTenant(this.database.db, context, async (tx) => {
      const current = await currentCatalogContext(tx, context);
      authorize(current, Permission.WorkflowRead);
      if (input.spuIds.length) {
        authorize(current, Permission.ProductRead);
        if (!await knowledgeProductsVisible(tx, current, input.spuIds, { lock: true }))
          throw new KnowledgeSearchOwnerError("适用 SPU 不存在或不可访问");
      }
      const rows = await tx
        .select({ entry: entries, version: versions })
        .from(entries)
        .innerJoin(
          versions,
          and(eq(versions.entryId, entries.id), eq(versions.version, entries.activeVersion)),
        )
        .where(
          and(
            isNull(entries.archivedAt),
            isNotNull(entries.activeVersion),
            input.topic === "all" ? undefined : sql`${versions.fields}->>'topic'=${input.topic}`,
            sql`(${versions.fields}->>'platform'='all' OR ${versions.fields}->>'platform'=${input.platform})`,
            sql`(${versions.fields}->>'market'='ALL' OR ${versions.fields}->>'market'=${input.market})`,
            input.spuIds.length
              ? sql`(${versions.scopeSpuId} IS NULL OR ${versions.scopeSpuId} IN (${sql.join(
                  input.spuIds.map((id) => sql`${id}::uuid`),
                  sql`, `,
                )}))`
              : isNull(versions.scopeSpuId),
          ),
        )
        .orderBy(desc(entries.updatedAt), desc(entries.id))
        .limit(501);
      const diagnostics: string[] = [];
      // A truncated corpus cannot masquerade as a complete search result.
      if (rows.length > 500)
        return KnowledgeSearchResultSchema.parse({
          references: [],
          diagnostics: ["匹配知识超过 500 条，请归档或缩小范围后再检索"],
          retrievedAt: new Date().toISOString(),
          mode: "keyword",
          scanned: 500,
        });
      const overdue = rows.filter((row) => row.version.fields.reviewDueOn < today);
      if (overdue.length) diagnostics.push(`${overdue.length} 条知识已到复查期，本次未使用`);
      const eligible = [];
      for (const row of rows) {
        const issues = await knowledgeEvidenceIssues(tx, row.version.fields);
        const blocked = await knowledgeBlockingConflicts(tx, row.version.id);
        if (issues.length || blocked.length) {
          diagnostics.push(
            `“${row.version.fields.title}”未使用：${issues.join("；")}${blocked.length ? "存在未裁决的阻断级冲突" : ""}`,
          );
          continue;
        }
        eligible.push(row);
      }
      const ranked = eligible
        .filter((row) => knowledgeEligible(row.version.fields, input, today))
        .map((row) => ({ ...row, score: scoreKnowledge(row.version.fields, input.query) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
        .slice(0, 6);
      if (!ranked.length)
        diagnostics.push("未找到符合本次范围的有效已发布知识；请补充资料或调整检索词");
      return KnowledgeSearchResultSchema.parse({
        references: ranked.map(({ entry, version, score }) => ({
          sourceId: `knowledge:${version.id}`,
          entryId: entry.id,
          versionId: version.id,
          version: version.version,
          title: version.fields.title,
          excerpt: knowledgeExcerpt(version.fields.body, input.query),
          sourceLabel: version.fields.sourceLabel,
          sourceUrl: version.fields.sourceUrl,
          verifiedOn: version.fields.verifiedOn,
          reviewDueOn: version.fields.reviewDueOn,
          checksum: version.checksum,
          href: `/knowledge?entry=${entry.id}&version=${version.version}`,
          score,
        })),
        diagnostics,
        retrievedAt: new Date().toISOString(),
        mode: "keyword",
        scanned: rows.length,
      });
    });
  }
}
