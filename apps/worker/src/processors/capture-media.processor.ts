import { authorize, ForbiddenError, Permission, summarizeRoleGrants } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  captureMedia,
  captureSnapshots,
  researchItems,
  memberships,
  membershipRoles,
  roles,
  organizations,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import {
  CaptureMediaJobPayloadSchema,
  createQueue,
  createTraceId,
  enqueueJob,
  QueueName,
  type JobEnvelope,
} from "@yummyai/jobs";
import { checksumSha256, ClamAvScanner, type Storage } from "@yummyai/storage";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Queue } from "bullmq";
import {
  CaptureMediaDownloader,
  CaptureMediaError,
  inspectCaptureMedia,
} from "./capture-media.download.js";

const LEASE_MS = 5 * 60_000;
type Media = typeof captureMedia.$inferSelect;
type Claim = { media: Media; context: TenantContext; token: string; platform: string };

export class CaptureMediaProcessor {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly storage: Pick<Storage, "putPrivate">,
    private readonly scanner: Pick<ClamAvScanner, "scan"> = new ClamAvScanner(),
    private readonly downloader: Pick<
      CaptureMediaDownloader,
      "download"
    > = new CaptureMediaDownloader(),
  ) {}

  async process(envelope: JobEnvelope) {
    const payload = CaptureMediaJobPayloadSchema.parse(envelope.payload);
    const context: TenantContext = {
      tenantId: envelope.tenantId,
      userId: envelope.requestedBy,
      permissions: [],
      dataScope: "tenant",
    };
    const claim = await this.claim(context, payload.mediaId, payload.snapshotId);
    if (!claim) return { state: "skipped" };
    try {
      const fetched = await this.downloader.download(
        claim.media.sourceUrl,
        claim.platform,
        claim.media.kind,
      );
      const maxBytes = claim.media.kind === "video" ? 50 * 1024 * 1024 : 12 * 1024 * 1024;
      if (!fetched.body.byteLength || fetched.body.byteLength > maxBytes)
        throw new CaptureMediaError("MEDIA_SIZE_INVALID");
      const scan = await this.scanner.scan({
        body: fetched.body,
        fileName: `capture.${claim.media.kind}`,
        mediaType: fetched.mediaType,
      });
      if (scan.result === "infected") throw new CaptureMediaError("MEDIA_SCAN_INFECTED");
      if (
        scan.result !== "clean" ||
        !scan.signatureVersion ||
        ["unavailable", "unknown"].includes(scan.signatureVersion)
      )
        throw new CaptureMediaError("MEDIA_SCAN_UNAVAILABLE", true);
      const inspected = await inspectCaptureMedia(
        fetched.body,
        fetched.mediaType,
        claim.media.kind,
      );
      if (!(await this.stillAuthorized(claim))) return { state: "fenced" };
      const stored = await this.storage.putPrivate(claim.context, {
        body: fetched.body,
        domain: "research",
        fileName: `capture.${inspected.extension}`,
        mediaType: inspected.type,
      });
      const checksum = checksumSha256(fetched.body);
      if (
        stored.checksumSha256 !== checksum ||
        stored.objectKey !==
          `tenants/${context.tenantId}/research/${checksum}/capture.${inspected.extension}`
      )
        throw new CaptureMediaError("MEDIA_STORAGE_IDENTITY_INVALID");
      const committed = await withTenant(this.database.db, context, async (tx) => {
        const [current] = await tx
          .select()
          .from(captureMedia)
          .where(eq(captureMedia.id, claim.media.id))
          .for("update");
        const now = await databaseNow(tx);
        if (!ownsLease(current, claim.token, now)) return false;
        await captureMediaAuthority(tx, context, claim.media.snapshotId);
        await tx
          .update(captureMedia)
          .set({
            status: "archived",
            objectKey: stored.objectKey,
            checksumSha256: checksum,
            mediaType: inspected.type,
            byteSize: fetched.body.byteLength,
            scanResult: scan,
            archivedAt: now,
            failureReason: null,
            leaseToken: null,
            leaseExpiresAt: null,
          })
          .where(eq(captureMedia.id, claim.media.id));
        return true;
      });
      return { state: committed ? "archived" : "fenced" };
    } catch (error) {
      const failure =
        error instanceof CaptureMediaError
          ? error
          : error instanceof ForbiddenError
            ? new CaptureMediaError("MEDIA_ACCESS_REVOKED")
            : new CaptureMediaError("MEDIA_ARCHIVE_UNAVAILABLE", true);
      return this.fail(claim, failure);
    }
  }

  private async claim(
    context: TenantContext,
    id: string,
    snapshotId: string,
  ): Promise<Claim | null> {
    return withTenant(this.database.db, context, async (tx) => {
      const [media] = await tx
        .select()
        .from(captureMedia)
        .where(and(eq(captureMedia.id, id), eq(captureMedia.snapshotId, snapshotId)))
        .for("update");
      if (!media || ["archived", "excluded", "failed"].includes(media.status)) return null;
      const [snapshot] = await tx
        .select()
        .from(captureSnapshots)
        .where(eq(captureSnapshots.id, snapshotId))
        .limit(1);
      if (!snapshot || snapshot.capturedBy !== context.userId) return null;
      const now = await databaseNow(tx);
      if (media.status === "processing" && media.leaseExpiresAt && media.leaseExpiresAt > now)
        return null;
      if (media.status === "queued" && media.nextAttemptAt > now) return null;
      if (media.attemptCount >= 3) {
        await tx
          .update(captureMedia)
          .set({
            status: "failed",
            failureReason: "MEDIA_ATTEMPTS_EXHAUSTED",
            leaseToken: null,
            leaseExpiresAt: null,
          })
          .where(eq(captureMedia.id, id));
        return null;
      }
      let current: { context: TenantContext; platform: string };
      try {
        current = await captureMediaAuthority(tx, context, snapshotId);
      } catch (error) {
        if (!(error instanceof ForbiddenError || error instanceof CaptureMediaError)) throw error;
        await tx
          .update(captureMedia)
          .set({
            status: "failed",
            failureReason: error instanceof CaptureMediaError ? error.code : "MEDIA_ACCESS_REVOKED",
            leaseToken: null,
            leaseExpiresAt: null,
          })
          .where(eq(captureMedia.id, id));
        return null;
      }
      const token = createEntityId();
      await tx
        .update(captureMedia)
        .set({
          status: "processing",
          attemptCount: media.attemptCount + 1,
          failureReason: null,
          leaseToken: token,
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        })
        .where(eq(captureMedia.id, id));
      return {
        media: { ...media, attemptCount: media.attemptCount + 1 },
        context: current.context,
        platform: current.platform,
        token,
      };
    });
  }

  private async stillAuthorized(claim: Claim) {
    return withTenant(this.database.db, claim.context, async (tx) => {
      const [current] = await tx
        .select()
        .from(captureMedia)
        .where(eq(captureMedia.id, claim.media.id))
        .limit(1);
      if (!ownsLease(current, claim.token, await databaseNow(tx))) return false;
      await captureMediaAuthority(tx, claim.context, claim.media.snapshotId);
      return true;
    });
  }

  private async fail(claim: Claim, failure: CaptureMediaError) {
    return withTenant(this.database.db, claim.context, async (tx) => {
      const [current] = await tx
        .select()
        .from(captureMedia)
        .where(eq(captureMedia.id, claim.media.id))
        .for("update");
      const now = await databaseNow(tx);
      if (!ownsLease(current, claim.token, now)) return { state: "fenced" };
      const state = failure.retryable && current!.attemptCount < 3 ? "queued" : "failed";
      await tx
        .update(captureMedia)
        .set({
          status: state,
          failureReason: failure.code,
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: new Date(
            now.getTime() + 60_000 * 2 ** Math.max(0, current!.attemptCount - 1),
          ),
        })
        .where(eq(captureMedia.id, claim.media.id));
      return { state };
    });
  }
}

function ownsLease(media: Media | undefined, token: string, now: Date) {
  return (
    media?.status === "processing" &&
    media.leaseToken === token &&
    Boolean(media.leaseExpiresAt && media.leaseExpiresAt > now)
  );
}

async function databaseNow(tx: TenantTransaction) {
  const rows = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
  return new Date(rows[0]!.now);
}

export async function captureMediaAuthority(
  tx: TenantTransaction,
  base: TenantContext,
  snapshotId: string,
  options: { lock?: boolean } = {},
) {
  const grantsQuery = tx
    .select({ permissions: roles.permissions, scope: roles.dataScope })
    .from(memberships)
    .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
    .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
    .where(and(eq(memberships.userId, base.userId), eq(memberships.status, "active")));
  const grants = await (options.lock === false ? grantsQuery : grantsQuery.for("share"));
  const context: TenantContext = { ...base, ...summarizeRoleGrants(grants) };
  authorize(context, Permission.CaptureWrite);
  const sourceQuery = tx
    .select({
      platform: researchItems.platform,
      ownerId: researchItems.ownerUserId,
      archivedAt: researchItems.archivedAt,
    })
    .from(captureSnapshots)
    .innerJoin(researchItems, eq(researchItems.id, captureSnapshots.researchItemId))
    .where(and(eq(captureSnapshots.id, snapshotId), eq(captureSnapshots.capturedBy, base.userId)))
    .limit(1);
  const [source] = await (options.lock === false
    ? sourceQuery
    : sourceQuery.for("share", { of: researchItems }));
  if (!source || source.archivedAt) throw new CaptureMediaError("MEDIA_RESEARCH_UNAVAILABLE");
  authorize(context, Permission.CaptureWrite, { ownerId: source.ownerId });
  return { context, platform: source.platform };
}

export class CaptureMediaScheduler {
  private stopping = false;
  private pending?: Promise<{ queued: number; failed: number }>;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly identity = createEntityId();
  constructor(
    private readonly database: DatabaseConnection,
    private readonly queue: Queue = createQueue(QueueName.Media),
  ) {}
  start() {
    if (this.timer || this.stopping) return;
    const dispatch = () =>
      void this.dispatch().catch(() => process.stderr.write("Capture media dispatch failed\n"));
    this.timer = setInterval(dispatch, 60_000);
    this.timer.unref();
    dispatch();
  }
  dispatch() {
    if (this.running || this.stopping) return Promise.resolve({ queued: 0, failed: 0 });
    const pending = this.dispatchOnce();
    this.pending = pending;
    void pending
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      })
      .catch(() => undefined);
    return pending;
  }
  private async dispatchOnce() {
    if (this.running) return { queued: 0, failed: 0 };
    this.running = true;
    let queued = 0,
      failed = 0;
    try {
      // Only organization identity is enumerated outside RLS. Every media read/write is tenant-bound.
      const tenants = await this.database.db.select({ id: organizations.id }).from(organizations);
      for (const tenant of tenants) {
        const context: TenantContext = {
          tenantId: tenant.id,
          userId: this.identity,
          permissions: [],
          dataScope: "tenant",
        };
        const pending = await withTenant(this.database.db, context, async (tx) => {
          const rows = await tx
            .select()
            .from(captureMedia)
            .where(
              and(
                sql`((${captureMedia.status} = 'queued' AND ${captureMedia.nextAttemptAt} <= now()) OR (${captureMedia.status} = 'processing' AND ${captureMedia.leaseExpiresAt} <= now()))`,
                sql`(${captureMedia.lastDispatchedAt} IS NULL OR ${captureMedia.lastDispatchedAt} <= now() - interval '1 minute')`,
              ),
            )
            .orderBy(asc(captureMedia.nextAttemptAt))
            .limit(100)
            .for("update", { skipLocked: true });
          const reserved = [];
          for (const media of rows) {
            const [snapshot] = await tx
              .select({ actor: captureSnapshots.capturedBy })
              .from(captureSnapshots)
              .where(eq(captureSnapshots.id, media.snapshotId))
              .limit(1);
            if (!snapshot?.actor) {
              await tx
                .update(captureMedia)
                .set({
                  status: "failed",
                  failureReason: "MEDIA_ACCESS_REVOKED",
                  leaseToken: null,
                  leaseExpiresAt: null,
                })
                .where(eq(captureMedia.id, media.id));
              continue;
            }
            const generation = media.dispatchCount + 1;
            await tx
              .update(captureMedia)
              .set({ dispatchCount: generation, lastDispatchedAt: sql`clock_timestamp()` })
              .where(eq(captureMedia.id, media.id));
            reserved.push({
              id: media.id,
              snapshotId: media.snapshotId,
              actor: snapshot.actor,
              generation,
            });
          }
          return reserved;
        });
        for (const media of pending) {
          try {
            const jobId = createEntityId();
            await enqueueJob(this.queue, "capture-media.archive", {
              jobId,
              tenantId: tenant.id,
              requestedBy: media.actor,
              idempotencyKey: jobId,
              correlationId: media.snapshotId,
              traceId: createTraceId(),
              requestedAt: new Date().toISOString(),
              attempt: 0,
              maxAttempts: 3,
              payload: { mediaId: media.id, snapshotId: media.snapshotId },
            });
            queued++;
          } catch {
            failed++;
            await withTenant(this.database.db, context, (tx) =>
              tx
                .update(captureMedia)
                .set({ lastDispatchedAt: null, failureReason: "MEDIA_QUEUE_UNAVAILABLE" })
                .where(
                  and(
                    eq(captureMedia.id, media.id),
                    eq(captureMedia.dispatchCount, media.generation),
                    eq(captureMedia.status, "queued"),
                  ),
                ),
            );
          }
        }
      }
      return { queued, failed };
    } finally {
      this.running = false;
    }
  }
  async close() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    try {
      await this.pending;
    } finally {
      await this.queue.close();
    }
  }
}
