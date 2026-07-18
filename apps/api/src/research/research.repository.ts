import type { TenantContext } from "@yummyai/contracts";
import { captureSnapshots, researchItems, type DatabaseConnection, withTenant } from "@yummyai/database";
import { and, desc, eq, gte, inArray, lt, lte, sql, type SQL } from "drizzle-orm";
import { Inject, Injectable } from "@nestjs/common";

import { DATABASE_CONNECTION } from "../platform.tokens.js";

export interface ResearchFilters {
  captureStatus?: string;
  cursor?: string;
  dateFrom?: string;
  dateTo?: string;
  marketplace?: string;
  owner?: string;
  platform?: "amazon" | "etsy";
  priceMax?: number;
  priceMin?: number;
  project?: string;
  rating?: number;
  tags?: string[];
  limit?: number;
}

@Injectable()
export class ResearchRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}

  async list(context: TenantContext, filters: ResearchFilters = {}) {
    const conditions: SQL[] = [];
    if (filters.platform) conditions.push(eq(researchItems.platform, filters.platform));
    if (filters.marketplace) conditions.push(eq(researchItems.marketplace, filters.marketplace));
    if (filters.captureStatus) conditions.push(eq(researchItems.latestStatus, filters.captureStatus));
    if (filters.owner) conditions.push(eq(researchItems.ownerUserId, filters.owner));
    if (filters.project) conditions.push(eq(researchItems.projectId, filters.project));
    if (filters.dateFrom) conditions.push(gte(researchItems.lastCapturedAt, new Date(filters.dateFrom)));
    if (filters.dateTo) conditions.push(lte(researchItems.lastCapturedAt, new Date(filters.dateTo)));
    if (filters.cursor) conditions.push(lt(researchItems.lastCapturedAt, new Date(filters.cursor)));
    if (filters.tags?.length) conditions.push(sql`${researchItems.tags} @> ${JSON.stringify(filters.tags)}::jsonb`);
    if (filters.priceMin !== undefined) conditions.push(sql`EXISTS (SELECT 1 FROM capture_snapshots s WHERE s.research_item_id = ${researchItems.id} AND s.price_amount >= ${filters.priceMin})`);
    if (filters.priceMax !== undefined) conditions.push(sql`EXISTS (SELECT 1 FROM capture_snapshots s WHERE s.research_item_id = ${researchItems.id} AND s.price_amount <= ${filters.priceMax})`);
    if (filters.rating !== undefined) conditions.push(sql`EXISTS (SELECT 1 FROM capture_snapshots s WHERE s.research_item_id = ${researchItems.id} AND s.rating >= ${filters.rating})`);
    const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);
    const rows = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(researchItems).where(conditions.length ? and(...conditions) : undefined).orderBy(desc(researchItems.lastCapturedAt)).limit(limit + 1),
    );
    const hasNext = rows.length > limit;
    const items = hasNext ? rows.slice(0, limit) : rows;
    const latestSnapshots = items.length
      ? await withTenant(this.database.db, context, (tx) =>
          tx
            .selectDistinctOn([captureSnapshots.researchItemId], {
              draft: captureSnapshots.draft,
              researchItemId: captureSnapshots.researchItemId,
            })
            .from(captureSnapshots)
            .where(inArray(captureSnapshots.researchItemId, items.map((item) => item.id)))
            .orderBy(captureSnapshots.researchItemId, desc(captureSnapshots.capturedAt)),
        )
      : [];
    const shopNames = new Map(
      latestSnapshots.map((snapshot) => [snapshot.researchItemId, snapshot.draft.shop?.name ?? null]),
    );
    return {
      items: items.map((item) => ({ ...item, shopName: shopNames.get(item.id) ?? null })),
      nextCursor: hasNext ? items.at(-1)?.lastCapturedAt.toISOString() : null,
    };
  }

  async timeline(context: TenantContext, researchItemId: string) {
    return withTenant(this.database.db, context, (tx) =>
      tx.select().from(captureSnapshots).where(eq(captureSnapshots.researchItemId, researchItemId)).orderBy(desc(captureSnapshots.capturedAt)),
    );
  }

  async snapshotCount(context: TenantContext, researchItemId: string) {
    const [result] = await withTenant(this.database.db, context, (tx) =>
      tx.select({ count: sql<number>`count(*)::int` }).from(captureSnapshots).where(eq(captureSnapshots.researchItemId, researchItemId)),
    );
    return result?.count ?? 0;
  }
}
