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
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  isNotNull,
  lt,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import { Inject, Injectable } from "@nestjs/common";

import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { researchStudySummaries } from "./research-study.service.js";

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

@Injectable()
export class ResearchRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}

  async list(context: TenantContext, filters: ResearchFilters = {}) {
    const pageConditions = researchConditions(filters, true);
    const totalConditions = researchConditions(filters, false);
    const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);
    const [rows, total] = await withTenant(this.database.db, context, async (tx) => {
      const listed = await tx
        .select()
        .from(researchItems)
        .where(pageConditions.length ? and(...pageConditions) : undefined)
        .orderBy(desc(researchItems.lastCapturedAt))
        .limit(limit + 1);
      const [count] = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(researchItems)
        .where(totalConditions.length ? and(...totalConditions) : undefined);
      return [listed, count?.value ?? 0] as const;
    });
    const hasNext = rows.length > limit;
    const items = hasNext ? rows.slice(0, limit) : rows;
    const latestSnapshots = items.length
      ? await withTenant(this.database.db, context, (tx) =>
          tx
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
            .orderBy(captureSnapshots.researchItemId, desc(captureSnapshots.capturedAt)),
        )
      : [];
    const snapshotMap = new Map(
      latestSnapshots.map((snapshot) => [snapshot.researchItemId, snapshot]),
    );
    const studies = await withTenant(this.database.db, context, (tx) =>
      researchStudySummaries(
        tx,
        items.map((item) => item.id),
      ),
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
  }

  async productTypes(context: TenantContext, visibility: ResearchFilters["visibility"] = "active") {
    const items = await withTenant(this.database.db, context, (tx) =>
      tx
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
          ),
        )
        .groupBy(researchItems.productTypeKey, researchItems.productTypeName)
        .orderBy(asc(researchItems.productTypeName)),
    );
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
    return withTenant(this.database.db, context, (tx) =>
      tx
        .select()
        .from(captureSnapshots)
        .where(eq(captureSnapshots.researchItemId, researchItemId))
        .orderBy(desc(captureSnapshots.capturedAt)),
    );
  }

  async snapshotCount(context: TenantContext, researchItemId: string) {
    const [result] = await withTenant(this.database.db, context, (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(captureSnapshots)
        .where(eq(captureSnapshots.researchItemId, researchItemId)),
    );
    return result?.count ?? 0;
  }
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
