import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { CaptureMediaArchiveViewSchema, CaptureStatusSchema } from "@yummyai/contracts/capture";
import {
  CaptureMediaPageSchema,
  CaptureMediaReadLeaseSchema,
  captureMediaFailureCode,
} from "@yummyai/contracts/capture/media-preview";
import type { Storage } from "@yummyai/storage";
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
  type TenantTransaction,
  withTenant,
} from "@yummyai/database";
import { and, asc, count, eq, gt, isNull, or, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { persistCompetitorShopSnapshot } from "../competitors/competitor-shop.service.js";
import {
  CAPTURE_MEDIA_ENQUEUER,
  DATABASE_CONNECTION,
  PRIVATE_STORAGE,
} from "../platform.tokens.js";
import { ResearchClassificationService } from "../research/research-classification.service.js";
import {
  currentResearchAuthority,
  requireResearchResource,
  canReadResearchResource,
} from "../research/research-access.js";

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
    @Inject(ResearchClassificationService)
    private readonly classifications: ResearchClassificationService,
    @Optional() @Inject(PRIVATE_STORAGE) private readonly storage?: Storage,
  ) {}

  async createSnapshot(context: TenantContext, input: CaptureDraft): Promise<CaptureReceipt> {
    authorize(context, Permission.CaptureWrite);
    const draft = CaptureDraftSchema.parse(input);
    const normalizedUrl = normalizeMarketplaceUrl(draft.sourceUrl);
    const created = await withTenant(this.database.db, context, async (tx) => {
      const current = await currentResearchAuthority(tx, context);
      authorize(current, Permission.CaptureWrite);
      const [existing] = await tx
        .select()
        .from(researchItems)
        .where(
          and(
            eq(researchItems.tenantId, context.tenantId),
            eq(researchItems.normalizedUrl, normalizedUrl),
          ),
        )
        .limit(1)
        .for("update");
      if (existing)
        requireResearchResource(context, current, Permission.CaptureWrite, existing.ownerUserId);
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
      await this.classifications.suggestFromCapture(
        tx,
        context,
        itemId,
        draft,
        existing
          ? {
              classificationSource: existing.classificationSource,
              classificationStatus: existing.classificationStatus,
            }
          : undefined,
      );
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
      const media = draft.media.map((entry, sourceIndex) => ({
        id: createEntityId(),
        tenantId: context.tenantId,
        snapshotId,
        sourceUrl: entry.sourceUrl,
        kind: entry.kind,
        sourceIndex,
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
        await withTenant(this.database.db, context, (tx) =>
          tx
            .update(captureMedia)
            .set({ lastDispatchedAt: sql`clock_timestamp()` })
            .where(
              and(
                eq(captureMedia.id, media.id),
                eq(captureMedia.status, "queued"),
                eq(captureMedia.dispatchCount, 0),
              ),
            ),
        );
      } catch {
        failed += 1;
        await withTenant(this.database.db, context, (tx) =>
          tx
            .update(captureMedia)
            .set({
              // The row is the durable intent; the Worker dispatcher can recover it.
              failureReason: "MEDIA_QUEUE_UNAVAILABLE",
            })
            .where(and(eq(captureMedia.id, media.id), eq(captureMedia.status, "queued"))),
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

  async mediaPreview(context: TenantContext, snapshotId: string, after?: string) {
    authorize(context, Permission.CaptureRead);
    return withTenant(this.database.db, context, async (tx) => {
      const current = await currentResearchAuthority(tx, context);
      const [basis] = await tx
        .select({
          researchItemId: captureSnapshots.researchItemId,
          status: captureSnapshots.status,
          fieldCaptureStatus: sql<unknown>`${captureSnapshots.draft}->>'captureStatus'`,
          ownerId: researchItems.ownerUserId,
          archivedAt: researchItems.archivedAt,
        })
        .from(captureSnapshots)
        .innerJoin(researchItems, eq(researchItems.id, captureSnapshots.researchItemId))
        .where(eq(captureSnapshots.id, snapshotId))
        .limit(1)
        .for("share", { of: researchItems });
      if (!basis) throw new NotFoundException("Capture snapshot not found");
      requireResearchResource(context, current, Permission.CaptureRead, basis.ownerId);
      let cursor: { id: string; sourceIndex: number | null } | undefined;
      if (after) {
        [cursor] = await tx
          .select({ id: captureMedia.id, sourceIndex: captureMedia.sourceIndex })
          .from(captureMedia)
          .where(and(eq(captureMedia.snapshotId, snapshotId), eq(captureMedia.id, after)))
          .limit(1);
        if (!cursor) throw new BadRequestException("Media cursor does not belong to this snapshot");
      }
      const afterPosition = !cursor
        ? undefined
        : cursor.sourceIndex === null
          ? and(isNull(captureMedia.sourceIndex), gt(captureMedia.id, cursor.id))
          : or(
              gt(captureMedia.sourceIndex, cursor.sourceIndex),
              and(eq(captureMedia.sourceIndex, cursor.sourceIndex), gt(captureMedia.id, cursor.id)),
              isNull(captureMedia.sourceIndex),
            );
      const groups = await tx
        .select({ status: captureMedia.status, kind: captureMedia.kind, value: count() })
        .from(captureMedia)
        .where(eq(captureMedia.snapshotId, snapshotId))
        .groupBy(captureMedia.status, captureMedia.kind);
      const counts = { queued: 0, processing: 0, archived: 0, excluded: 0, failed: 0 },
        kinds = { image: 0, video: 0 };
      for (const group of groups) {
        counts[CaptureMediaArchiveViewSchema.shape.status.parse(group.status)] += group.value;
        kinds[CaptureMediaArchiveViewSchema.shape.kind.parse(group.kind)] += group.value;
      }
      const media = await tx
        .select()
        .from(captureMedia)
        .where(and(eq(captureMedia.snapshotId, snapshotId), afterPosition))
        .orderBy(asc(captureMedia.sourceIndex), asc(captureMedia.id))
        .limit(101);
      return CaptureMediaPageSchema.parse({
        snapshotId,
        researchItemId: basis.researchItemId,
        captureStatus: basis.status,
        fieldCaptureStatus: CaptureStatusSchema.safeParse(basis.fieldCaptureStatus).success
          ? basis.fieldCaptureStatus
          : null,
        archivedItem: Boolean(basis.archivedAt),
        canReadArchive:
          !basis.archivedAt &&
          canReadResearchResource(context, current, Permission.AssetRead, basis.ownerId),
        total: kinds.image + kinds.video,
        counts,
        kinds,
        nextCursor: media.length > 100 ? media[99]!.id : null,
        media: media.slice(0, 100).map((entry) => ({
          ...entry,
          failureReason: captureMediaFailureCode(entry.failureReason),
          archivedAt: entry.archivedAt?.toISOString() ?? null,
          createdAt: entry.createdAt.toISOString(),
        })),
      });
    });
  }

  async getSnapshot(context: TenantContext, id: string) {
    authorize(context, Permission.CaptureRead);
    return withTenant(this.database.db, context, async (tx) => {
      const current = await currentResearchAuthority(tx, context);
      const [source] = await tx
        .select({ snapshot: captureSnapshots, ownerId: researchItems.ownerUserId })
        .from(captureSnapshots)
        .innerJoin(researchItems, eq(researchItems.id, captureSnapshots.researchItemId))
        .where(eq(captureSnapshots.id, id))
        .limit(1)
        .for("share", { of: researchItems });
      if (!source) throw new NotFoundException("Capture snapshot not found");
      requireResearchResource(context, current, Permission.CaptureRead, source.ownerId);
      const media = await tx
        .select()
        .from(captureMedia)
        .where(eq(captureMedia.snapshotId, id))
        .orderBy(asc(captureMedia.sourceIndex), asc(captureMedia.id));
      return {
        ...source.snapshot,
        media: media.map((entry) =>
          CaptureMediaArchiveViewSchema.parse({
            ...entry,
            failureReason: captureMediaFailureCode(entry.failureReason),
            archivedAt: entry.archivedAt?.toISOString() ?? null,
            createdAt: entry.createdAt.toISOString(),
          }),
        ),
      };
    });
  }

  async signMediaRead(context: TenantContext, snapshotId: string, mediaId: string) {
    authorize(context, Permission.CaptureRead);
    authorize(context, Permission.AssetRead);
    if (!this.storage)
      throw new ServiceUnavailableException("Private media storage is unavailable");
    const media = await withTenant(this.database.db, context, (tx) =>
      this.mediaForRead(tx, context, snapshotId, mediaId),
    );
    const url = await this.storage.signRead(
      context,
      {
        id: media.id,
        tenantId: context.tenantId,
        assetDomain: "research",
        objectKey: media.objectKey!,
      },
      { requiredDomain: "research", expiresInSeconds: 60 },
    );
    await withTenant(this.database.db, context, async (tx) => {
      const current = await this.mediaForRead(tx, context, snapshotId, mediaId);
      if (current.objectKey !== media.objectKey || current.checksumSha256 !== media.checksumSha256)
        throw new ConflictException("Capture archive changed during read");
      await this.audit.recordInTransaction(tx, context, {
        action: "capture.media.read_url.create",
        resourceType: "capture_media",
        resourceId: media.id,
        result: "success",
        metadata: { snapshotId, domain: "research" },
      });
    });
    return CaptureMediaReadLeaseSchema.parse({
      url,
      expiresInSeconds: 60,
      mediaType: media.mediaType,
      byteSize: media.byteSize,
      checksumSha256: media.checksumSha256,
    });
  }

  private async mediaForRead(
    tx: TenantTransaction,
    context: TenantContext,
    snapshotId: string,
    mediaId: string,
  ) {
    const current = await currentResearchAuthority(tx, context);
    const [row] = await tx
      .select({
        media: captureMedia,
        ownerId: researchItems.ownerUserId,
        archivedAt: researchItems.archivedAt,
      })
      .from(captureMedia)
      .innerJoin(captureSnapshots, eq(captureSnapshots.id, captureMedia.snapshotId))
      .innerJoin(researchItems, eq(researchItems.id, captureSnapshots.researchItemId))
      .where(and(eq(captureMedia.id, mediaId), eq(captureMedia.snapshotId, snapshotId)))
      .limit(1)
      .for("share", { of: researchItems });
    if (!row || row.archivedAt) throw new NotFoundException("Capture media not found");
    requireResearchResource(context, current, Permission.CaptureRead, row.ownerId);
    requireResearchResource(context, current, Permission.AssetRead, row.ownerId);
    if (
      row.media.status !== "archived" ||
      !row.media.objectKey ||
      row.media.scanResult?.result !== "clean"
    )
      throw new ConflictException("Capture media has no clean archive");
    const metadata = CaptureMediaReadLeaseSchema.omit({
      url: true,
      expiresInSeconds: true,
    }).safeParse(row.media);
    if (
      !metadata.success ||
      !metadata.data.mediaType.startsWith(`${row.media.kind}/`) ||
      (row.media.kind === "image" && metadata.data.byteSize > 12 * 1024 * 1024)
    )
      throw new ConflictException("Capture media archive metadata is incomplete");
    return row.media;
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
