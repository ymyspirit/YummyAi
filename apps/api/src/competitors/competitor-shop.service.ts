import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  CompetitorShopDraftSchema,
  createEntityId,
  type CapturedShopSummary,
  type CompetitorShopDraft,
  type TenantContext,
} from "@yummyai/contracts";
import {
  competitorShopSnapshots,
  competitorShops,
  type DatabaseConnection,
  type TenantTransaction,
  withTenant,
} from "@yummyai/database";
import { and, desc, eq, inArray } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

interface PersistShopOptions {
  capturedAt: Date;
  capturedBy: string;
  marketplace: string;
  snapshotKind: "listing" | "shop";
  sourceCaptureSnapshotId?: string;
  sourceResearchItemId?: string;
  status: "complete" | "partial" | "failed";
}

@Injectable()
export class CompetitorShopService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async createSnapshot(context: TenantContext, input: CompetitorShopDraft) {
    const draft = CompetitorShopDraftSchema.parse(input);
    const created = await withTenant(this.database.db, context, (tx) =>
      persistCompetitorShopSnapshot(tx, context, draft, {
        capturedAt: new Date(draft.capturedAt),
        capturedBy: context.userId,
        marketplace: draft.marketplace,
        snapshotKind: "shop",
        status: draft.captureStatus,
      }),
    );
    await this.audit.record(context, {
      action: "competitor_shop.snapshot.create",
      resourceType: "competitor_shop_snapshot",
      resourceId: created.snapshotId,
      result: "success",
      metadata: { competitorShopId: created.competitorShopId, status: draft.captureStatus },
    });
    return { ...created, status: draft.captureStatus };
  }

  async list(context: TenantContext) {
    const shops = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(competitorShops).orderBy(desc(competitorShops.lastCapturedAt)).limit(100),
    );
    if (!shops.length) return { items: [] };
    const snapshots = await withTenant(this.database.db, context, (tx) =>
      tx
        .select()
        .from(competitorShopSnapshots)
        .where(inArray(competitorShopSnapshots.competitorShopId, shops.map((shop) => shop.id)))
        .orderBy(desc(competitorShopSnapshots.capturedAt)),
    );
    const latest = new Map<string, (typeof snapshots)[number]>();
    for (const snapshot of snapshots) {
      if (!latest.has(snapshot.competitorShopId)) latest.set(snapshot.competitorShopId, snapshot);
    }
    return {
      items: shops.map((shop) => ({ ...shop, latestSnapshot: latest.get(shop.id) ?? null })),
    };
  }

  async timeline(context: TenantContext, id: string) {
    const [shop] = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(competitorShops).where(eq(competitorShops.id, id)).limit(1),
    );
    if (!shop) throw new NotFoundException("Competitor shop not found");
    const snapshots = await withTenant(this.database.db, context, (tx) =>
      tx
        .select()
        .from(competitorShopSnapshots)
        .where(eq(competitorShopSnapshots.competitorShopId, id))
        .orderBy(desc(competitorShopSnapshots.capturedAt)),
    );
    return { shop, snapshots };
  }
}

export async function persistCompetitorShopSnapshot(
  tx: TenantTransaction,
  context: TenantContext,
  draft: CapturedShopSummary | CompetitorShopDraft,
  options: PersistShopOptions,
) {
  const normalizedUrl = normalizeShopUrl(draft.sourceUrl);
  const [existing] = await tx
    .select()
    .from(competitorShops)
    .where(
      and(
        eq(competitorShops.tenantId, context.tenantId),
        eq(competitorShops.normalizedUrl, normalizedUrl),
      ),
    )
    .limit(1);
  const competitorShopId = existing?.id ?? createEntityId();
  if (existing) {
    await tx
      .update(competitorShops)
      .set({
        externalId: draft.externalId,
        shopName: draft.name,
        latestStatus: options.status,
        lastCapturedAt: options.capturedAt,
      })
      .where(eq(competitorShops.id, competitorShopId));
  } else {
    await tx.insert(competitorShops).values({
      id: competitorShopId,
      tenantId: context.tenantId,
      ownerUserId: context.userId,
      platform: draft.platform,
      marketplace: options.marketplace,
      externalId: draft.externalId,
      normalizedUrl,
      shopName: draft.name,
      latestStatus: options.status,
      firstCapturedAt: options.capturedAt,
      lastCapturedAt: options.capturedAt,
    });
  }

  const full = isFullShopDraft(draft) ? draft : null;
  const snapshotId = createEntityId();
  await tx.insert(competitorShopSnapshots).values({
    id: snapshotId,
    tenantId: context.tenantId,
    competitorShopId,
    capturedBy: options.capturedBy,
    sourceResearchItemId: options.sourceResearchItemId,
    sourceCaptureSnapshotId: options.sourceCaptureSnapshotId,
    sourceUrl: draft.sourceUrl,
    snapshotKind: options.snapshotKind,
    location: draft.location,
    ownerName: draft.ownerName,
    rating: draft.rating?.toFixed(2),
    reviewCount: draft.reviewCount,
    salesCount: draft.salesCount,
    activeListingCount: draft.activeListingCount,
    admirerCount: draft.admirerCount,
    openedYear: draft.openedYear,
    yearsOnPlatform: draft.yearsOnPlatform,
    badges: draft.badges,
    announcement: full?.announcement,
    about: full?.about,
    policies: full?.policies,
    members: full?.members ?? [],
    productionPartners: full?.productionPartners ?? [],
    shopSections: full?.shopSections ?? [],
    draft,
    capturedAt: options.capturedAt,
  });
  return { competitorShopId, snapshotId };
}

function isFullShopDraft(
  draft: CapturedShopSummary | CompetitorShopDraft,
): draft is CompetitorShopDraft {
  return "parserVersion" in draft;
}

function normalizeShopUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.href;
}
