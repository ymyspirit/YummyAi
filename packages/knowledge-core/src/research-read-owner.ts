import { Permission } from "@yummyai/authz";
import type {
ResearchClassificationEvidenceSource,
ResearchClassificationSource,
ResearchClassificationStatus,
ResearchItemClassification,
TenantContext,
} from "@yummyai/contracts";
import {
captureSnapshots,
researchItems,
withTenant,
type DatabaseConnection,
} from "@yummyai/database";
import {
and,
asc,
desc,
eq,
getTableColumns,
gte,
inArray,
isNotNull,
isNull,
lt,
lte,
sql,
type SQL,
} from "drizzle-orm";




import { currentResearchAuthority,researchOwnerFilter } from "./research-access.js";


import { authorize,ForbiddenError } from "@yummyai/authz";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import { ResearchStudyContentSchema,type ResearchSourceReference,type ResearchSourceSelection } from "@yummyai/contracts/research/creative";
import { creativeDesignBatches,researchStudyRevisions,type TenantTransaction } from "@yummyai/database";
export interface ResearchFilters {
  visibility?: "active" | "archived" | "all";
  item?: string;
  researchStatus?: "unreviewed" | "analyzed" | "parked";
  captureStatus?: string;
  classificationStatus?: ResearchClassificationStatus;
  cursor?: string;
  dateFrom?: string;
  dateTo?: string;
  marketplace?: string;
  owner?: string;
  platform?: "amazon" | "etsy";
  priceMax?: number;
  priceMin?: number;
  productType?: string;
  project?: string;
  q?: string;
  rating?: number;
  tags?: string[];
  limit?: number;
}


export class ResearchReadOwner {
constructor(private readonly database: DatabaseConnection) {}
async list(context: TenantContext, filters: ResearchFilters = {}) {
    return withTenant(this.database.db, context, async (tx) => {
      const current = await currentResearchAuthority(tx, context),
        scope = researchOwnerFilter(context, current, Permission.ResearchRead);
      const pageConditions = researchConditions(filters, true);
      const totalConditions = researchConditions(filters, false);
      const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);
      const rows = await tx
        .select()
        .from(researchItems)
        .where(and(scope, ...pageConditions))
        .orderBy(desc(researchItems.lastCapturedAt))
        .limit(limit + 1)
        .for("share");
      const [count] = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(researchItems)
        .where(and(scope, ...totalConditions));
      const total = count?.value ?? 0;
      const hasNext = rows.length > limit;
      const items = hasNext ? rows.slice(0, limit) : rows;
      const latestSnapshots = items.length
        ? await tx
            .selectDistinctOn([captureSnapshots.researchItemId], {
              researchItemId: captureSnapshots.researchItemId,
              shopName: sql<string | null>`${captureSnapshots.draft} #>> '{shop,name}'`,
              id: captureSnapshots.id,
              priceRaw: sql<string | null>`${captureSnapshots.draft} #>> '{price,raw}'`,
              thumbnailUrl: sql<
                string | null
              >`jsonb_path_query_first(${captureSnapshots.draft}, '$.media[*] ? (@.kind == "image" && @.included == true).sourceUrl') #>> '{}'`,
            })
            .from(captureSnapshots)
            .where(
              inArray(
                captureSnapshots.researchItemId,
                items.map((item) => item.id),
              ),
            )
            .orderBy(captureSnapshots.researchItemId, desc(captureSnapshots.capturedAt))
        : [];
      const snapshotMap = new Map(
        latestSnapshots.map((snapshot) => [snapshot.researchItemId, snapshot]),
      );
      const studies = await researchStudySummaries(
        tx,
        items.map((item) => item.id),
        context,
        current,
      );
      return {
        items: items.map((item) => ({
          id: item.id,
          archivedAt: item.archivedAt?.toISOString() ?? null,
          lastCapturedAt: item.lastCapturedAt.toISOString(),
          latestStatus: item.latestStatus,
          latestTitle: item.latestTitle,
          marketplace: item.marketplace,
          normalizedUrl: item.normalizedUrl,
          platform: item.platform as "amazon" | "etsy",
          shopName: snapshotMap.get(item.id)?.shopName ?? null,
          thumbnailUrl: snapshotMap.get(item.id)?.thumbnailUrl ?? null,
          priceRaw: snapshotMap.get(item.id)?.priceRaw ?? null,
          latestSnapshotId: snapshotMap.get(item.id)?.id,
          study: studies.get(item.id),
          classification: classificationView(item),
        })),
        nextCursor: hasNext ? (items.at(-1)?.lastCapturedAt.toISOString() ?? null) : null,
        total,
      };
    });
  }
async productTypes(context: TenantContext, visibility: ResearchFilters["visibility"] = "active") {
    const items = await withTenant(this.database.db, context, async (tx) => {
      const current = await currentResearchAuthority(tx, context),
        scope = researchOwnerFilter(context, current, Permission.ResearchRead);
      return tx
        .select({
          confirmed: sql<number>`count(*) filter (where ${researchItems.classificationStatus} = 'confirmed')::int`,
          key: researchItems.productTypeKey,
          name: researchItems.productTypeName,
          suggested: sql<number>`count(*) filter (where ${researchItems.classificationStatus} = 'suggested')::int`,
          total: sql<number>`count(*)::int`,
        })
        .from(researchItems)
        .where(
          and(
            sql`${researchItems.productTypeKey} is not null`,
            ...visibilityConditions(visibility),
            scope,
          ),
        )
        .groupBy(researchItems.productTypeKey, researchItems.productTypeName)
        .orderBy(asc(researchItems.productTypeName));
    });
    return {
      items: items.flatMap((item) =>
        item.key && item.name
          ? [
              {
                confirmed: item.confirmed,
                key: item.key,
                name: item.name,
                suggested: item.suggested,
                total: item.total,
              },
            ]
          : [],
      ),
    };
  }
async timeline(context: TenantContext, researchItemId: string) {
    return withTenant(this.database.db, context, async (tx) => {
      const current = await currentResearchAuthority(tx, context),
        scope = researchOwnerFilter(context, current, Permission.ResearchRead);
      return tx
        .select(getTableColumns(captureSnapshots))
        .from(captureSnapshots)
        .innerJoin(researchItems, eq(researchItems.id, captureSnapshots.researchItemId))
        .where(and(eq(captureSnapshots.researchItemId, researchItemId), scope))
        .orderBy(desc(captureSnapshots.capturedAt));
    });
  }
async snapshotCount(context: TenantContext, researchItemId: string) {
    const [result] = await withTenant(this.database.db, context, async (tx) => {
      const current = await currentResearchAuthority(tx, context),
        scope = researchOwnerFilter(context, current, Permission.ResearchRead);
      return tx
        .select({ count: sql<number>`count(*)::int` })
        .from(captureSnapshots)
        .innerJoin(researchItems, eq(researchItems.id, captureSnapshots.researchItemId))
        .where(and(eq(captureSnapshots.researchItemId, researchItemId), scope));
    });
    return result?.count ?? 0;
  }
async resolve(context:TenantContext,sources:ResearchSourceSelection[]){authorize(context,Permission.ResearchRead);return withTenant(this.database.db,context,tx=>resolveResearchSources(tx,context,sources));}
}
function researchConditions(filters: ResearchFilters, includeCursor: boolean) {
  const conditions: SQL[] = [];
  // A pinned history link remains readable after its index entry is archived.
  if (!filters.item) conditions.push(...visibilityConditions(filters.visibility));
  if (filters.item) conditions.push(eq(researchItems.id, filters.item));
  if (filters.researchStatus)
    conditions.push(
      sql`coalesce((select s.content->>'status' from research_study_revisions s where s.research_item_id = ${researchItems.id} order by s.version desc limit 1), 'unreviewed') = ${filters.researchStatus}`,
    );
  if (filters.platform) conditions.push(eq(researchItems.platform, filters.platform));
  if (filters.marketplace) conditions.push(eq(researchItems.marketplace, filters.marketplace));
  if (filters.captureStatus) conditions.push(eq(researchItems.latestStatus, filters.captureStatus));
  if (filters.classificationStatus) {
    conditions.push(eq(researchItems.classificationStatus, filters.classificationStatus));
  }
  if (filters.productType) conditions.push(eq(researchItems.productTypeKey, filters.productType));
  if (filters.q?.trim()) {
    const escaped = filters.q.trim().replace(/[\\%_]/g, (value) => `\\${value}`);
    conditions.push(sql`${researchItems.latestTitle} ILIKE ${`%${escaped}%`} ESCAPE '\\'`);
  }
  if (filters.owner) conditions.push(eq(researchItems.ownerUserId, filters.owner));
  if (filters.project) conditions.push(eq(researchItems.projectId, filters.project));
  if (filters.dateFrom)
    conditions.push(gte(researchItems.lastCapturedAt, new Date(filters.dateFrom)));
  if (filters.dateTo) conditions.push(lte(researchItems.lastCapturedAt, new Date(filters.dateTo)));
  if (includeCursor && filters.cursor) {
    conditions.push(lt(researchItems.lastCapturedAt, new Date(filters.cursor)));
  }
  if (filters.tags?.length) {
    conditions.push(sql`${researchItems.tags} @> ${JSON.stringify(filters.tags)}::jsonb`);
  }
  if (filters.priceMin !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM capture_snapshots s WHERE s.research_item_id = ${researchItems.id} AND s.price_amount >= ${filters.priceMin})`,
    );
  }
  if (filters.priceMax !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM capture_snapshots s WHERE s.research_item_id = ${researchItems.id} AND s.price_amount <= ${filters.priceMax})`,
    );
  }
  if (filters.rating !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM capture_snapshots s WHERE s.research_item_id = ${researchItems.id} AND s.rating >= ${filters.rating})`,
    );
  }
  return conditions;
}

function visibilityConditions(visibility: ResearchFilters["visibility"] = "active"): SQL[] {
  return visibility === "all"
    ? []
    : [
        visibility === "archived"
          ? isNotNull(researchItems.archivedAt)
          : isNull(researchItems.archivedAt),
      ];
}

function classificationView(item: typeof researchItems.$inferSelect): ResearchItemClassification {
  return {
    productType:
      item.productTypeKey && item.productTypeName
        ? { key: item.productTypeKey, name: item.productTypeName }
        : null,
    status: item.classificationStatus as ResearchClassificationStatus,
    source: item.classificationSource as ResearchClassificationSource | null,
    evidenceSource:
      item.classificationEvidenceSource as ResearchClassificationEvidenceSource | null,
    evidenceLabel: item.classificationEvidenceLabel,
    updatedAt: item.classificationUpdatedAt?.toISOString() ?? null,
  };
}

export function designReferenceScope(context: TenantContext, current: TenantContext) {
  try {
    return {
      filter: researchOwnerFilter(
        context,
        current,
        Permission.DesignRead,
        creativeDesignBatches.createdBy,
      ),
    };
  } catch (error) {
    if (error instanceof ForbiddenError) return null;
    throw error;
  }
}
export async function resolveResearchSources(
  tx: TenantTransaction,
  context: TenantContext,
  selections: ResearchSourceSelection[],
): Promise<ResearchSourceReference[]> {
  if (!selections.length) return [];
  authorize(context, Permission.ResearchRead);
  const current = await currentResearchAuthority(tx, context),
    scope = researchOwnerFilter(context, current, Permission.ResearchRead);
  if (new Set(selections.map((source) => source.researchItemId)).size !== selections.length)
    throw new OriginalOwnerError(400, "研究来源不可重复");
  const references: ResearchSourceReference[] = [];
  for (const selection of selections) {
    const [item] = await tx
      .select()
      .from(researchItems)
      .where(and(eq(researchItems.id, selection.researchItemId), scope))
      .limit(1)
      .for("share");
    if (!item) throw new OriginalOwnerError(404, "研究来源不存在");
    const [study] =
      selection.studyRevisionId === null
        ? []
        : await tx
            .select()
            .from(researchStudyRevisions)
            .where(
              and(
                eq(researchStudyRevisions.researchItemId, item.id),
                selection.studyRevisionId
                  ? eq(researchStudyRevisions.id, selection.studyRevisionId)
                  : undefined,
              ),
            )
            .orderBy(desc(researchStudyRevisions.version))
            .limit(1);
    if (selection.studyRevisionId && !study) throw new OriginalOwnerError(404, "研究结论版本不存在");
    const snapshotId = selection.snapshotId ?? study?.snapshotId;
    const [snapshot] = await tx
      .select()
      .from(captureSnapshots)
      .where(
        and(
          eq(captureSnapshots.researchItemId, item.id),
          snapshotId ? eq(captureSnapshots.id, snapshotId) : undefined,
        ),
      )
      .orderBy(desc(captureSnapshots.capturedAt), desc(captureSnapshots.id))
      .limit(1);
    if (!snapshot) throw new OriginalOwnerError(404, "研究快照不存在");
    if (selection.studyRevisionId && study?.snapshotId !== snapshot.id)
      throw new OriginalOwnerError(400, "研究结论与所选快照不匹配");
    const pinnedStudy = study?.snapshotId === snapshot.id ? study : undefined;
    references.push({
      domain: "research",
      researchItemId: item.id,
      snapshotId: snapshot.id,
      studyRevisionId: pinnedStudy?.id ?? null,
      studyVersion: pinnedStudy?.version ?? 0,
      title: snapshot.title ?? item.latestTitle ?? "未识别标题",
      sourceUrl: item.normalizedUrl,
      platform: item.platform as "amazon" | "etsy",
      capturedAt: snapshot.capturedAt.toISOString(),
      thumbnailUrl:
        snapshot.draft.media.find((media) => media.kind === "image" && media.included)?.sourceUrl ??
        null,
      mediaCount: snapshot.draft.media.filter((media) => media.included).length,
      content: pinnedStudy ? ResearchStudyContentSchema.parse(pinnedStudy.content) : null,
    });
  }
  return references;
}
export async function researchStudySummaries(
  tx: TenantTransaction,
  ids: string[],
  context: TenantContext,
  current: TenantContext,
) {
  if (!ids.length)
    return new Map<
      string,
      { status: string; theme: string; version: number; snapshotId: string; creativeCount: number }
    >();
  const revisions = await tx
    .selectDistinctOn([researchStudyRevisions.researchItemId])
    .from(researchStudyRevisions)
    .where(inArray(researchStudyRevisions.researchItemId, ids))
    .orderBy(researchStudyRevisions.researchItemId, desc(researchStudyRevisions.version));
  const designScope = designReferenceScope(context, current);
  const projects = designScope
    ? await tx
        .select({
          ids: sql<
            string[]
          >`${creativeDesignBatches.canvasWorkflow}->'requirements'->'researchItemIds'`,
        })
        .from(creativeDesignBatches)
        .where(
          and(
            designScope.filter,
            sql`${creativeDesignBatches.canvasWorkflow}->'requirements'->'researchItemIds' ?| ARRAY[${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )}]::text[] AND (${creativeDesignBatches.canvasWorkflow}->>'stepIndex')::integer = 0`,
          ),
        )
    : [];
  return new Map(
    ids.map((id) => {
      const revision = revisions.find((row) => row.researchItemId === id);
      return [
        id,
        {
          status: revision?.content.status ?? "unreviewed",
          theme: revision?.content.theme ?? "",
          version: revision?.version ?? 0,
          snapshotId: revision?.snapshotId ?? "",
          creativeCount: projects.filter((project) => project.ids?.includes(id)).length,
        },
      ];
    }),
  );
}
