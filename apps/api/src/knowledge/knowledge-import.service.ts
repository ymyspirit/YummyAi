import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { KnowledgeSearchSchema, type KnowledgeReference } from "@yummyai/contracts/knowledge";
import {
  ImportKnowledgeSchema,
  ConfirmKnowledgeRedactionSchema,
  DecideKnowledgeCandidateSchema,
  KnowledgeDocumentViewSchema,
} from "@yummyai/contracts/knowledge/governance";
import {
  knowledgeDocuments as documents,
  knowledgeCandidates as candidates,
  knowledgeVersions as versions,
  knowledgeEntries as entries,
  knowledgeGovernanceEvents as events,
  marketplaceAccounts as stores,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import {
  knowledgeChecksum,
  knowledgeDay,
  knowledgeCandidatesFromText,
  parseKnowledgeDocument,
  redactKnowledgeText,
  knowledgeScopeMatches,
} from "@yummyai/knowledge-core";
import type { ClamAvScanner } from "@yummyai/storage";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  DATABASE_CONNECTION,
  KNOWLEDGE_EVIDENCE_VAULT,
  KNOWLEDGE_DOCUMENT_SCANNER,
} from "../platform.tokens.js";
import { KnowledgeService } from "./knowledge.service.js";
import { knowledgeExcerpt, scoreKnowledge } from "./knowledge-retriever.js";

export function authorizeKnowledgeAccount(context: TenantContext, ownerId?: string) {
  authorize(context, Permission.StoreRead, ownerId ? { ownerId } : undefined);
  authorize(context, Permission.FinanceRead, ownerId ? { ownerId } : undefined);
}
export async function recordKnowledgeGovernanceEvent(
  tx: TenantTransaction,
  context: TenantContext,
  resourceId: string,
  action: string,
  reason: string,
  detail: Record<string, unknown> = {},
) {
  await tx
    .insert(events)
    .values({
      id: createEntityId(),
      tenantId: context.tenantId,
      resourceId,
      action,
      reason,
      detail,
      createdBy: context.userId,
    });
}
@Injectable()
export class KnowledgeImportService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(KNOWLEDGE_EVIDENCE_VAULT) private readonly vault: SecretVault,
    @Inject(KNOWLEDGE_DOCUMENT_SCANNER) private readonly scanner: Pick<ClamAvScanner, "scan">,
    @Inject(KnowledgeService) private readonly knowledge: KnowledgeService,
  ) {}
  async upload(context: TenantContext, raw: unknown) {
    authorize(context, Permission.WorkflowManage);
    const input = ImportKnowledgeSchema.parse(raw),
      digest = knowledgeChecksum(input);
    if (input.fields.spuId) {
      authorize(context, Permission.ProductRead);
      if (!(await this.knowledge.workspace(context)).spus.some((s) => s.id === input.fields.spuId))
        throw new NotFoundException("资料适用产品不存在或已归档");
    }
    const metadataText = [input.fields.title, input.fields.summary, input.fields.sourceLabel].join(
      "\n",
    );
    if (redactKnowledgeText(metadataText).text !== metadataText)
      throw new BadRequestException("资料标题、摘要或来源名称含身份或凭证字段，请先移除");
    if (input.account) {
      authorizeKnowledgeAccount(context);
      await withTenant(this.database.db, context, async (tx) => {
        const [store] = await tx.select().from(stores).where(eq(stores.id, input.account!.storeId));
        if (!store) throw new NotFoundException("店铺不存在");
        authorizeKnowledgeAccount(context, store.createdBy ?? undefined);
        if (input.fields.platform !== store.platform || input.fields.market === "ALL")
          throw new BadRequestException("账户证据须指定所属店铺平台和具体站点");
      });
      if (input.account.periodUntil > knowledgeDay())
        throw new BadRequestException("账户证据报告期间不能在未来");
    }
    const [prior] = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(documents).where(eq(documents.requestId, input.requestId)),
    );
    if (prior) {
      if (prior.requestChecksum !== digest) throw new ConflictException("同一导入请求的资料已变化");
      return { id: prior.id };
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64) || input.base64.length % 4)
      throw new BadRequestException("文件编码无效");
    const bytes = Buffer.from(input.base64, "base64");
    if (!bytes.length || bytes.length > 5 * 1024 * 1024)
      throw new BadRequestException("单份资料最多 5 MB");
    let parsed: { text: string; mediaType: string; diagnostics: string[] } | null = null,
      diagnostics: string[] = [],
      scanClean = false;
    try {
      const scan = await this.scanner.scan({
        body: bytes,
        fileName: input.fileName,
        mediaType: "application/octet-stream",
      });
      if (scan.result !== "clean")
        throw new Error(
          scan.result === "infected"
            ? "资料安全扫描发现风险，本次未保留原件或生成候选卡"
            : "资料安全扫描失败，本次未生成候选卡",
        );
      scanClean = true;
      parsed = await parseKnowledgeDocument(bytes, input.fileName);
      diagnostics = parsed.diagnostics;
    } catch (error) {
      diagnostics = [
        error instanceof Error && /^(资料|Word|PDF|支持|解析|不接受|候选卡)/.test(error.message)
          ? error.message
          : "资料解析失败，请核对格式、编码或密码保护；未生成候选卡",
      ];
    }
    const redacted = parsed ? redactKnowledgeText(parsed.text) : { text: "", findings: [] };
    if (redacted.findings.length)
      diagnostics.push(
        `检测并替换：${redacted.findings.join("、")}；还需人工检查未识别的身份字段。`,
      );
    const referenceCandidates =
      parsed && !input.account ? knowledgeCandidatesFromText(redacted.text, input.fields) : [];
    try {
      return await withTenant(this.database.db, context, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-import:${context.tenantId}`},0))`,
        );
        const [existing] = await tx
          .select()
          .from(documents)
          .where(eq(documents.requestId, input.requestId));
        if (existing) {
          if (existing.requestChecksum !== digest) throw new ConflictException("导入请求冲突");
          return { id: existing.id };
        }
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(documents)
          .where(sql`${documents.state}<>'archived'`);
        if (count!.n >= 200) throw new BadRequestException("资料超过 200 份，请归档不再使用的资料");
        const id = createEntityId();
        await tx
          .insert(documents)
          .values({
            id,
            tenantId: context.tenantId,
            kind: input.account ? "account" : "reference",
            fileName: input.fileName,
            mediaType: parsed?.mediaType ?? "application/octet-stream",
            checksum: knowledgeChecksum(input.base64),
            encryptedOriginal: scanClean ? this.vault.encrypt(input.base64) : null,
            encryptedParsed: input.account && parsed ? this.vault.encrypt(parsed.text) : null,
            rawExpiresAt: new Date(Date.now() + input.retentionDays * 86400_000),
            safeText: input.account ? "" : redacted.text,
            state: parsed ? (input.account ? "preview" : "confirmed") : "failed",
            diagnostics,
            fields: input.account
              ? {
                  ...input.fields,
                  body: "账户原文只在加密资料域保留；检索使用人工确认的脱敏证据。",
                }
              : input.fields,
            account: input.account,
            storeId: input.account?.storeId ?? null,
            createdBy: context.userId,
            requestId: input.requestId,
            requestChecksum: digest,
          });
        for (const candidate of referenceCandidates)
          await tx
            .insert(candidates)
            .values({
              id: createEntityId(),
              tenantId: context.tenantId,
              documentId: id,
              ...candidate,
              fields: { ...candidate.fields, documentIds: [id] },
            });
        await recordKnowledgeGovernanceEvent(
          tx,
          context,
          id,
          "document.import",
          "导入资料，候选卡未发布",
          {
            kind: input.account ? "account" : "reference",
            candidateCount: referenceCandidates.length,
            scanClean,
          },
        );
        return { id };
      });
    } finally {
      bytes.fill(0);
    }
  }
  private authorizeDocument(
    context: TenantContext,
    row: typeof documents.$inferSelect,
    write = false,
  ) {
    authorize(context, write ? Permission.WorkflowManage : Permission.WorkflowRead);
    if (row.kind === "account") authorizeKnowledgeAccount(context, row.createdBy);
    if (row.fields.spuId) authorize(context, Permission.ProductRead);
  }
  async document(context: TenantContext, id: string) {
    return withTenant(this.database.db, context, async (tx) => {
      const [row] = await tx.select().from(documents).where(eq(documents.id, id));
      if (!row) throw new NotFoundException("资料不存在");
      this.authorizeDocument(context, row);
      const cards = await tx
        .select()
        .from(candidates)
        .where(eq(candidates.documentId, id))
        .orderBy(candidates.createdAt, candidates.id);
      const known = await tx
        .select({ id: entries.id, fields: versions.fields })
        .from(entries)
        .innerJoin(
          versions,
          and(eq(versions.entryId, entries.id), eq(versions.version, entries.latestVersion)),
        )
        .where(isNull(entries.archivedAt));
      let safeText = row.safeText;
      if (
        row.kind === "account" &&
        row.state === "preview" &&
        row.encryptedParsed &&
        row.rawExpiresAt > new Date()
      )
        safeText = this.vault.withSecret(
          row.encryptedParsed,
          (text) => redactKnowledgeText(text).text,
        );
      return KnowledgeDocumentViewSchema.parse({
        ...row,
        safeText,
        hasOriginal: !!row.encryptedOriginal && row.rawExpiresAt > new Date(),
        rawExpiresAt: row.rawExpiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        candidates: cards.map((card) => ({
          ...card,
          duplicateIds: known
            .filter(
              (k) =>
                (!k.fields.spuId || context.permissions.includes(Permission.ProductRead)) &&
                (k.fields.title === card.fields.title ||
                  knowledgeChecksum(k.fields.body) === knowledgeChecksum(card.fields.body)),
            )
            .map((k) => k.id),
        })),
      });
    });
  }
  async confirmAccount(context: TenantContext, id: string, raw: unknown) {
    const input = ConfirmKnowledgeRedactionSchema.parse(raw);
    return withTenant(this.database.db, context, async (tx) => {
      const [row] = await tx.select().from(documents).where(eq(documents.id, id)).for("update");
      if (!row) throw new NotFoundException("资料不存在");
      this.authorizeDocument(context, row, true);
      if (
        row.kind !== "account" ||
        row.state !== "preview" ||
        row.revision !== input.expectedRevision
      )
        throw new ConflictException("资料已变化或不是待确认的账户证据");
      if (!row.encryptedParsed || row.rawExpiresAt <= new Date())
        throw new ConflictException("原资料保留期已到，需重新导入进行核对");
      const checked = redactKnowledgeText(input.text);
      if (checked.text !== input.text)
        throw new BadRequestException("确认正文仍含可识别的身份字段或凭证，请先修订脱敏结果");
      await tx
        .update(documents)
        .set({ safeText: input.text, state: "confirmed", revision: row.revision + 1 })
        .where(eq(documents.id, id));
      await recordKnowledgeGovernanceEvent(
        tx,
        context,
        id,
        "account.confirm_redaction",
        input.reason,
        { safeChecksum: knowledgeChecksum(input.text), period: row.account },
      );
      return { id };
    });
  }
  async decideCandidate(context: TenantContext, id: string, raw: unknown) {
    const input = DecideKnowledgeCandidateSchema.parse(raw),
      digest = knowledgeChecksum(input);
    return withTenant(this.database.db, context, async (tx) => {
      const [row] = await tx.select().from(candidates).where(eq(candidates.id, id)).for("update");
      if (!row) throw new NotFoundException("候选卡不存在");
      const [doc] = await tx.select().from(documents).where(eq(documents.id, row.documentId));
      if (!doc) throw new NotFoundException("原资料不存在");
      this.authorizeDocument(context, doc, true);
      if (row.requestId === input.requestId) {
        if (row.requestChecksum !== digest) throw new ConflictException("确认请求内容已变化");
        return { id: row.entryId };
      }
      if (
        row.revision !== input.expectedRevision ||
        row.decision !== "pending" ||
        doc.kind !== "reference" ||
        doc.state !== "confirmed"
      )
        throw new ConflictException("候选卡已处理或原资料不可用");
      const fields =
        input.decision === "reject"
          ? row.fields
          : {
              ...input.fields,
              documentIds: [...new Set([...(input.fields.documentIds ?? []), row.documentId])],
            };
      const created =
        input.decision === "accept"
          ? await this.knowledge.saveInTransaction(tx, context, input.targetEntryId, {
              fields,
              expectedRevision: input.targetRevision,
              reason: input.reason,
              requestId: input.requestId,
            })
          : null;
      await tx
        .update(candidates)
        .set({
          decision: input.decision === "accept" ? "accepted" : "rejected",
          revision: row.revision + 1,
          entryId: created?.id ?? null,
          requestId: input.requestId,
          requestChecksum: digest,
          fields,
        })
        .where(eq(candidates.id, id));
      await recordKnowledgeGovernanceEvent(
        tx,
        context,
        row.documentId,
        `candidate.${input.decision}`,
        input.reason,
        { candidateId: id, entryId: created?.id ?? null },
      );
      return { id: created?.id ?? null };
    });
  }
  async dispose(context: TenantContext, id: string, action: "purge" | "archive") {
    return withTenant(this.database.db, context, async (tx) => {
      const [row] = await tx.select().from(documents).where(eq(documents.id, id)).for("update");
      if (!row) throw new NotFoundException("资料不存在");
      this.authorizeDocument(context, row, true);
      await tx
        .update(documents)
        .set({
          encryptedOriginal: null,
          encryptedParsed: null,
          revision: row.revision + 1,
          ...(action === "archive" ? { state: "archived" as const } : {}),
        })
        .where(eq(documents.id, id));
      await recordKnowledgeGovernanceEvent(
        tx,
        context,
        id,
        `document.${action}`,
        action === "purge"
          ? "提前删除加密原件；保留已确认的脱敏证据和引用审计"
          : "归档资料，停止新检索并清除原件",
      );
      return { id };
    });
  }
  async original(context: TenantContext, id: string) {
    authorize(context, Permission.WorkflowApprove);
    return withTenant(this.database.db, context, async (tx) => {
      const [row] = await tx.select().from(documents).where(eq(documents.id, id));
      if (!row) throw new NotFoundException("资料不存在");
      this.authorizeDocument(context, row, true);
      if (row.createdBy !== context.userId) throw new NotFoundException("原件仅供导入人核对");
      if (!row.encryptedOriginal || row.rawExpiresAt <= new Date())
        throw new NotFoundException("原件已到保留期或已删除");
      await recordKnowledgeGovernanceEvent(
        tx,
        context,
        id,
        "document.original_read",
        "导入人读取加密原件",
      );
      return this.vault.withSecret(row.encryptedOriginal, (base64) => ({
        fileName: row.fileName,
        mediaType: row.mediaType,
        base64,
      }));
    });
  }
  async searchAccount(
    context: TenantContext,
    storeId: string,
    raw: unknown,
  ): Promise<KnowledgeReference[]> {
    authorizeKnowledgeAccount(context);
    const scope = KnowledgeSearchSchema.parse(raw);
    return withTenant(this.database.db, context, async (tx) => {
      const [store] = await tx.select().from(stores).where(eq(stores.id, storeId));
      if (!store) throw new NotFoundException("店铺不存在");
      authorizeKnowledgeAccount(context, store.createdBy ?? undefined);
      const rows = await tx
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.kind, "account"),
            eq(documents.storeId, storeId),
            eq(documents.state, "confirmed"),
          ),
        )
        .orderBy(desc(documents.createdAt))
        .limit(200);
      return rows
        .filter(
          (row) =>
            (context.dataScope !== "self" || row.createdBy === context.userId) &&
            knowledgeScopeMatches(row.fields, scope) &&
            row.fields.verifiedOn <= knowledgeDay() &&
            row.fields.reviewDueOn >= knowledgeDay(),
        )
        .map((row) => ({
          row,
          score: scoreKnowledge({ ...row.fields, body: row.safeText }, scope.query),
        }))
        .filter((v) => v.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2)
        .map(({ row, score }) => ({
          sourceId: `account:${row.id}:r${row.revision}`,
          entryId: row.id,
          versionId: row.id,
          version: row.revision,
          title: row.fields.title,
          excerpt: `账户案例，仅适用于 ${row.account!.periodFrom} 至 ${row.account!.periodUntil}，${row.account!.currency}，归因：${row.account!.attribution}\n${knowledgeExcerpt(row.safeText, scope.query)}`,
          sourceLabel: `脱敏账户证据 · ${store.displayName}`,
          sourceUrl: "",
          verifiedOn: row.fields.verifiedOn,
          reviewDueOn: row.fields.reviewDueOn,
          checksum: knowledgeChecksum(row.safeText),
          href: `/knowledge?tab=imports&document=${row.id}`,
          score,
        }));
    });
  }
}
