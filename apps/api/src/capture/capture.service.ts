import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  CaptureDraftSchema,
  createEntityId,
  type CaptureDraft,
  type TenantContext,
} from "@yummyai/contracts";
import {
  captureMedia,
  captureSnapshots,
  researchItems,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import { and, eq } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { persistCompetitorShopSnapshot } from "../competitors/competitor-shop.service.js";
import { CAPTURE_MEDIA_ENQUEUER, DATABASE_CONNECTION } from "../platform.tokens.js";

export interface CaptureReceipt {
  researchItemId: string;
  snapshotId: string;
  status: "complete" | "partial";
}

export interface CaptureMediaEnqueuer {
  enqueue(input: {
    mediaId: string;
    snapshotId: string;
    tenantId: string;
    sourceUrl: string;
    requestedBy: string;
  }): Promise<void>;
}

@Injectable()
export class CaptureService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(CAPTURE_MEDIA_ENQUEUER) private readonly mediaJobs: CaptureMediaEnqueuer,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async createSnapshot(context: TenantContext, input: CaptureDraft): Promise<CaptureReceipt> {
    const draft = CaptureDraftSchema.parse(input);
    const normalizedUrl = normalizeMarketplaceUrl(draft.sourceUrl);
    const created = await withTenant(this.database.db, context, async (tx) => {
      const [existing] = await tx
        .select()
        .from(researchItems)
        .where(
          and(
            eq(researchItems.tenantId, context.tenantId),
            eq(researchItems.normalizedUrl, normalizedUrl),
          ),
        )
        .limit(1);
      const itemId = existing?.id ?? createEntityId();
      if (!existing) {
        await tx.insert(researchItems).values({
          id: itemId,
          tenantId: context.tenantId,
          ownerUserId: context.userId,
          platform: draft.platform,
          marketplace: draft.marketplace,
          normalizedUrl,
          latestTitle: draft.title,
          latestStatus: "normalizing",
          firstCapturedAt: new Date(draft.capturedAt),
          lastCapturedAt: new Date(draft.capturedAt),
        });
      } else {
        await tx
          .update(researchItems)
          .set({
            latestTitle: draft.title,
            latestStatus: "normalizing",
            lastCapturedAt: new Date(draft.capturedAt),
          })
          .where(eq(researchItems.id, itemId));
      }

      const snapshotId = createEntityId();
      await tx.insert(captureSnapshots).values({
        id: snapshotId,
        tenantId: context.tenantId,
        researchItemId: itemId,
        capturedBy: context.userId,
        sourceUrl: draft.sourceUrl,
        title: draft.title,
        priceAmount: draft.price?.amount?.toFixed(2),
        priceCurrency: draft.price?.currency,
        rating: draft.rating?.toFixed(2),
        status: "normalizing",
        domain: draft.domain,
        draft,
        capturedAt: new Date(draft.capturedAt),
      });
      const competitor = draft.shop
        ? await persistCompetitorShopSnapshot(tx, context, draft.shop, {
            capturedAt: new Date(draft.capturedAt),
            capturedBy: context.userId,
            marketplace: draft.marketplace,
            snapshotKind: "listing",
            sourceCaptureSnapshotId: snapshotId,
            sourceResearchItemId: itemId,
            status: "partial",
          })
        : null;
      const media = draft.media.map((entry) => ({
        id: createEntityId(),
        tenantId: context.tenantId,
        snapshotId,
        sourceUrl: entry.sourceUrl,
        kind: entry.kind,
        status: entry.included ? ("queued" as const) : ("excluded" as const),
      }));
      if (media.length) await tx.insert(captureMedia).values(media);
      return { itemId, snapshotId, media, competitorShopId: competitor?.competitorShopId };
    });

    let failed = 0;
    for (const media of created.media.filter((entry) => entry.status === "queued")) {
      try {
        await this.mediaJobs.enqueue({
          mediaId: media.id,
          snapshotId: created.snapshotId,
          tenantId: context.tenantId,
          sourceUrl: media.sourceUrl,
          requestedBy: context.userId,
        });
      } catch (error) {
        failed += 1;
        await withTenant(this.database.db, context, (tx) =>
          tx
            .update(captureMedia)
            .set({
              status: "failed",
              failureReason:
                error instanceof Error ? error.message.slice(0, 500) : "Media enqueue failed",
            })
            .where(eq(captureMedia.id, media.id)),
        );
      }
    }
    const status = failed > 0 || draft.captureStatus !== "complete" ? "partial" : "complete";
    await withTenant(this.database.db, context, async (tx) => {
      await tx
        .update(captureSnapshots)
        .set({ status })
        .where(eq(captureSnapshots.id, created.snapshotId));
      await tx
        .update(researchItems)
        .set({ latestStatus: status })
        .where(eq(researchItems.id, created.itemId));
    });
    await this.audit.record(context, {
      action: "capture.snapshot.create",
      resourceType: "capture_snapshot",
      resourceId: created.snapshotId,
      result: "success",
      metadata: {
        researchItemId: created.itemId,
        status,
        failedMedia: failed,
        competitorShopId: created.competitorShopId,
      },
    });
    return { researchItemId: created.itemId, snapshotId: created.snapshotId, status };
  }

  async getSnapshot(context: TenantContext, id: string) {
    const [snapshot] = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(captureSnapshots).where(eq(captureSnapshots.id, id)).limit(1),
    );
    if (!snapshot) throw new NotFoundException("Capture snapshot not found");
    const media = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(captureMedia).where(eq(captureMedia.snapshotId, id)),
    );
    return { ...snapshot, media };
  }
}

export function normalizeMarketplaceUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.href;
}
