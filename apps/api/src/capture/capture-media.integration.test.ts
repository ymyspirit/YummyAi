import { Permission } from "@yummyai/authz";
import { createEntityId, type CaptureDraft, type TenantContext } from "@yummyai/contracts";
import {
  captureMedia,
  captureSnapshots,
  connectDatabase,
  migrateDatabase,
  researchItems,
  researchProductTypeAliases,
  roles,
  membershipRoles,
  loadCurrentMembershipContext,
  withTenant,
} from "@yummyai/database";
import {
  CaptureMediaJobPayloadSchema,
  createQueue,
  createTraceId,
  QueueName,
  type JobEnvelope,
} from "@yummyai/jobs";
import { checksumSha256, ClamAvScanner, createStorageFromEnvironment } from "@yummyai/storage";
import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWorker } from "../../../worker/src/main.js";
import { CaptureMediaError } from "../../../worker/src/processors/capture-media.download.js";
import {
  CaptureMediaProcessor,
  CaptureMediaScheduler,
} from "../../../worker/src/processors/capture-media.processor.js";
import { AuditService } from "../audit/audit.service.js";
import { ResearchClassificationService } from "../research/research-classification.service.js";
import { ResearchRepository } from "../research/research.repository.js";
import { ResearchArchiveService } from "../research/research-archive.service.js";
import { ResearchStudyService } from "../research/research-study.service.js";
import { ResearchStudyContentSchema } from "@yummyai/contracts/research/creative";
import { CaptureController } from "./capture.controller.js";
import { CaptureService, type CaptureMediaEnqueuer } from "./capture.service.js";
import { RedisMediaEnqueuer } from "./redis-media-enqueuer.js";

if (
  process.env.E2E_ISOLATED_DAILY !== "1" ||
  !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname) ||
  !/^order-daily-e2e-[a-f0-9]{32}$/.test(process.env.S3_PRIVATE_BUCKET ?? "")
)
  throw new Error(
    "Run media acceptance through the disposable --suite=media-archive-integration runner",
  );

describe("capture media durable archival with real RLS, ClamAV, S3 and Redis", () => {
  const database = connectDatabase(),
    storage = createStorageFromEnvironment();
  const tenantId = createEntityId(),
    userId = createEntityId(),
    otherTenant = createEntityId(),
    otherUser = createEntityId();
  const membershipId = createEntityId(),
    roleId = createEntityId();
  const permissions = [
    Permission.CaptureRead,
    Permission.CaptureWrite,
    Permission.AssetRead,
    Permission.ResearchRead,
  ];
  const context: TenantContext = { tenantId, userId, permissions, dataScope: "tenant" };
  const audit = new AuditService(database),
    classification = new ResearchClassificationService(database, audit);
  const enqueuer: CaptureMediaEnqueuer = { async enqueue() {} };
  const service = new CaptureService(database, enqueuer, audit, classification, storage),
    controller = new CaptureController(service);
  const scanner = new ClamAvScanner();
  let image: Buffer;
  beforeAll(async () => {
    await migrateDatabase(database);
    await storage.ensureBucket();
    await database.client.unsafe(
      "insert into organizations(id,name,slug) values($1,'Media acceptance',$2),($3,'Other media acceptance',$4)",
      [tenantId, `media-${tenantId}`, otherTenant, `media-${otherTenant}`],
    );
    await database.client.unsafe(
      "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Media operator'),($4,$5,$6,'Other media operator')",
      [
        userId,
        `media-${userId}`,
        `${userId}@example.test`,
        otherUser,
        `media-${otherUser}`,
        `${otherUser}@example.test`,
      ],
    );
    await database.client.unsafe(
      "insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')",
      [membershipId, tenantId, userId],
    );
    await database.client.unsafe(
      "insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,'Media operator',$3::jsonb,'tenant')",
      [roleId, tenantId, JSON.stringify(permissions)],
    );
    await database.client.unsafe(
      "insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)",
      [tenantId, membershipId, roleId],
    );
    image = await sharp({ create: { width: 40, height: 30, channels: 3, background: "blue" } })
      .png()
      .toBuffer();
  });
  afterAll(async () => {
    // The guarded runner removes/verifies the entire disposable bucket, DB and Redis,
    // including private content-addressed objects and immutable synthetic history.
    // Tenant deletion cannot remove immutable research revisions and is not a
    // substitute for the runner's failure-safe database teardown.
    await database.client.end();
  });

  async function grant(values: readonly string[] = permissions, scope = "tenant") {
    await withTenant(database.db, context, (tx) =>
      tx.update(roles).set({ permissions: values, dataScope: scope }).where(eq(roles.id, roleId)),
    );
  }
  async function additionalRole(values: readonly string[], scope: "self" | "team" | "tenant") {
    const id = createEntityId();
    await withTenant(database.db, context, async (tx) => {
      await tx.insert(roles).values({
        id,
        tenantId,
        name: "Scoped media fixture",
        permissions: values,
        dataScope: scope,
      });
      await tx.insert(membershipRoles).values({ tenantId, membershipId, roleId: id });
    });
    return () =>
      withTenant(database.db, context, async (tx) => {
        await tx.delete(membershipRoles).where(eq(membershipRoles.roleId, id));
        await tx.delete(roles).where(eq(roles.id, id));
      });
  }
  const currentContext = () =>
    withTenant(database.db, context, (tx) => loadCurrentMembershipContext(tx, context));
  async function capture(
    options: {
      kind?: "image" | "video";
      included?: boolean;
      service?: CaptureService;
      media?: CaptureDraft["media"];
    } = {},
  ) {
    const id = createEntityId();
    const draft: CaptureDraft = {
      platform: "amazon",
      marketplace: "www.amazon.com",
      parserVersion: "media-acceptance-v1",
      extensionVersion: "0.0.0",
      sourceUrl: `https://www.amazon.com/dp/${id}`,
      externalId: id,
      title: "Synthetic capture media",
      domain: "research",
      price: null,
      rating: null,
      reviewCount: null,
      listingPublishedAt: null,
      favoriteCount: null,
      shipping: null,
      shop: null,
      taxonomy: [],
      reviewSummary: null,
      reviews: [],
      reviewCollection: {
        collectedCount: 0,
        reportedTotal: null,
        pageCount: 0,
        status: "visible",
        updatedAt: new Date().toISOString(),
      },
      bullets: [],
      media: options.media ?? [
        {
          id: "source",
          kind: options.kind ?? "image",
          sourceUrl: "https://m.media-amazon.com/images/I/synthetic.png",
          included: options.included ?? true,
        },
      ],
      variants: [],
      productInformation: [],
      contentBlocks: [],
      missingFields: [],
      diagnostics: [],
      captureStatus: "complete",
      capturedAt: new Date().toISOString(),
    };
    const receipt = await (options.service ?? service).createSnapshot(context, draft);
    const [media] = await withTenant(database.db, context, (tx) =>
      tx.select().from(captureMedia).where(eq(captureMedia.snapshotId, receipt.snapshotId)),
    );
    if (!media) throw new Error("Media fixture missing");
    // This helper prepares a ready queued task. Explicit future/lease tests
    // still assign their own schedule after this initial fixture is created.
    await withTenant(database.db, context, tx => tx.update(captureMedia)
      .set({ nextAttemptAt: sql`clock_timestamp()-interval '1 second'` })
      .where(and(eq(captureMedia.id, media.id), eq(captureMedia.status, "queued"))));
    return { ...receipt, mediaId: media.id };
  }
  function job(input: { snapshotId: string; mediaId: string }): JobEnvelope {
    return {
      jobId: createEntityId(),
      tenantId,
      requestedBy: userId,
      traceId: createTraceId(),
      correlationId: input.snapshotId,
      idempotencyKey: input.mediaId,
      requestedAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 3,
      payload: { mediaId: input.mediaId, snapshotId: input.snapshotId },
    };
  }
  async function row(id: string) {
    const [record] = await withTenant(database.db, context, (tx) =>
      tx.select().from(captureMedia).where(eq(captureMedia.id, id)),
    );
    if (!record) throw new Error("Media fixture missing");
    return record;
  }
  const fetchImage = () => ({
    download: vi.fn(async () => ({ body: image, mediaType: "image/png" })),
  });

  it("archives a clean image once, exposes only the public projection and authorizes a real short signed read", async () => {
    const fixture = await capture(),
      downloader = fetchImage();
    const probe = await withTenant(database.db, context, async (tx) => ({
      media: await tx
        .select()
        .from(captureMedia)
        .where(eq(captureMedia.id, fixture.mediaId))
        .for("update"),
      snapshots: await tx
        .select({ actor: captureSnapshots.capturedBy })
        .from(captureSnapshots)
        .where(eq(captureSnapshots.id, fixture.snapshotId)),
    }));
    expect(probe.media[0]?.id).toBe(fixture.mediaId);
    expect(probe.snapshots[0]?.actor).toBe(userId);
    const processor = new CaptureMediaProcessor(database, storage, scanner, downloader);
    await expect(processor.process(job(fixture))).resolves.toEqual({ state: "archived" });
    await expect(processor.process(job(fixture))).resolves.toEqual({ state: "skipped" });
    expect(downloader.download).toHaveBeenCalledTimes(1);
    const stored = await row(fixture.mediaId);
    expect(stored).toMatchObject({
      status: "archived",
      attemptCount: 1,
      checksumSha256: checksumSha256(image),
      mediaType: "image/png",
      byteSize: image.length,
      scanResult: { result: "clean", engine: "clamav-clamd" },
    });
    expect(stored.objectKey).toContain(`/research/${checksumSha256(image)}/`);
    const view = await service.getSnapshot(context, fixture.snapshotId);
    expect(view.media[0]).not.toHaveProperty("objectKey");
    expect(view.media[0]).not.toHaveProperty("leaseToken");
    const signed = await controller.readMedia(
      { tenantContext: context } as never,
      fixture.snapshotId,
      fixture.mediaId,
    );
    expect(signed.expiresInSeconds).toBe(60);
    const response = await fetch(signed.url);
    expect(response.status).toBe(200);
    expect(checksumSha256(new Uint8Array(await response.arrayBuffer()))).toBe(
      checksumSha256(image),
    );
    await expect(
      service.signMediaRead(
        { ...context, permissions: [Permission.CaptureRead] },
        fixture.snapshotId,
        fixture.mediaId,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      service.signMediaRead(
        { ...context, tenantId: otherTenant, userId: otherUser },
        fixture.snapshotId,
        fixture.mediaId,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.signMediaRead(
        { ...context, userId: otherUser, dataScope: "self" },
        fixture.snapshotId,
        fixture.mediaId,
      ),
    ).rejects.toMatchObject({ reason: "outside_data_scope" });
  });

  it("projects authorized archive status separately from parser completeness without leaking storage or legacy diagnostics", async () => {
    const queued = await capture({
      service: new CaptureService(
        database,
        {
          enqueue: async () => {
            throw new Error("synthetic queue unavailable");
          },
        },
        audit,
        classification,
        storage,
      ),
    });
    const pending = await service.mediaPreview(context, queued.snapshotId);
    expect(pending).toMatchObject({
      captureStatus: "partial",
      fieldCaptureStatus: "complete",
      counts: { queued: 1 },
      canReadArchive: true,
    });
    await withTenant(database.db, context, (tx) =>
      tx
        .update(captureMedia)
        .set({ status: "failed", failureReason: "https://private.invalid/secret?token=synthetic" })
        .where(eq(captureMedia.id, queued.mediaId)),
    );
    const preview = await service.mediaPreview(
      { ...context, permissions: [Permission.CaptureRead] },
      queued.snapshotId,
    );
    expect(preview).toMatchObject({
      canReadArchive: false,
      counts: { failed: 1 },
      total: 1,
      media: [{ sourceIndex: 0, failureReason: "MEDIA_FAILED" }],
    });
    for (const field of ["sourceUrl", "objectKey", "leaseToken", "scanResult"])
      expect(preview.media[0]).not.toHaveProperty(field);
    expect(JSON.stringify(preview)).not.toContain("private.invalid");
    await expect(
      service.mediaPreview({ ...context, permissions: [] }, queued.snapshotId),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      service.mediaPreview(
        { ...context, tenantId: otherTenant, userId: otherUser },
        queued.snapshotId,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.mediaPreview({ ...context, userId: otherUser, dataScope: "self" }, queued.snapshotId),
    ).rejects.toMatchObject({ reason: "outside_data_scope" });
  });

  it("paginates in pinned source order with full counts and rejects another snapshot's cursor", async () => {
    const fixture = await capture({
      media: Array.from({ length: 101 }, (_, index) => ({
        id: `original-${index}`,
        kind: index % 2 ? ("video" as const) : ("image" as const),
        sourceUrl: `https://m.media-amazon.com/images/I/position-${index}.png`,
        included: false,
      })),
    });
    const first = await service.mediaPreview(context, fixture.snapshotId);
    expect(first).toMatchObject({
      total: 101,
      counts: { excluded: 101 },
      kinds: { image: 51, video: 50 },
    });
    expect(first.media.map((entry) => entry.sourceIndex)).toEqual(
      Array.from({ length: 100 }, (_, index) => index),
    );
    expect(first.nextCursor).toBe(first.media[99]!.id);
    const next = await service.mediaPreview(context, fixture.snapshotId, first.nextCursor!);
    expect(next.media.map((entry) => entry.sourceIndex)).toEqual([100]);
    expect(next.nextCursor).toBeNull();
    expect(next.total).toBe(101);
    const other = await capture({ included: false });
    await expect(
      service.mediaPreview(context, fixture.snapshotId, other.mediaId),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("keeps reverse UUID order and legacy unpinned rows distinct, and enforces source pins in the database", async () => {
    const fixture = await capture({
      media: [0, 1].map((index) => ({
        id: `pin-${index}`,
        kind: "image",
        sourceUrl: `https://m.media-amazon.com/images/I/pin-${index}.png`,
        included: false,
      })),
    });
    const [original] = await withTenant(database.db, context, (tx) =>
      tx.select().from(captureSnapshots).where(eq(captureSnapshots.id, fixture.snapshotId)),
    );
    const snapshotId = createEntityId(),
      ids = [createEntityId(), createEntityId()].sort().reverse(),
      legacy = createEntityId();
    await withTenant(database.db, context, async (tx) => {
      await tx.insert(captureSnapshots).values({ ...original!, id: snapshotId });
      await tx.insert(captureMedia).values(
        ids.map((id, sourceIndex) => ({
          id,
          tenantId,
          snapshotId,
          sourceIndex,
          kind: "image",
          sourceUrl: original!.draft.media[sourceIndex]!.sourceUrl,
          status: "excluded",
        })),
      );
      await tx.insert(captureMedia).values({
        id: legacy,
        tenantId,
        snapshotId,
        kind: "image",
        sourceUrl: original!.draft.media[0]!.sourceUrl,
        status: "excluded",
      });
    });
    const preview = await service.mediaPreview(context, snapshotId);
    expect(preview.media.map((entry) => entry.id)).toEqual([...ids, legacy]);
    expect(preview.media.map((entry) => entry.sourceIndex)).toEqual([0, 1, null]);
    expect(
      (await service.mediaPreview(context, snapshotId, ids[0])).media.map((entry) => entry.id),
    ).toEqual([ids[1], legacy]);
    expect((await service.mediaPreview(context, snapshotId, legacy)).media).toEqual([]);
    await expect(
      withTenant(database.db, context, (tx) =>
        tx.update(captureMedia).set({ sourceIndex: 0 }).where(eq(captureMedia.id, legacy)),
      ),
    ).rejects.toThrow();
    for (const sourceIndex of [0, 1, 9]) {
      await expect(
        withTenant(database.db, context, (tx) =>
          tx.insert(captureMedia).values({
            id: createEntityId(),
            tenantId,
            snapshotId,
            sourceIndex,
            kind: "image",
            sourceUrl: original!.draft.media[0]!.sourceUrl,
            status: "excluded",
          }),
        ),
      ).rejects.toThrow();
    }
  });

  it("serves exact archived byte ranges and refuses new reads after research archival", async () => {
    const fixture = await capture();
    await new CaptureMediaProcessor(database, storage, scanner, fetchImage()).process(job(fixture));
    const lease = await service.signMediaRead(context, fixture.snapshotId, fixture.mediaId);
    expect(lease).toMatchObject({
      byteSize: image.length,
      checksumSha256: checksumSha256(image),
      mediaType: "image/png",
    });
    const response = await fetch(lease.url, { headers: { range: "bytes=0-15" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 0-15/${image.length}`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(image.subarray(0, 16));
    await withTenant(database.db, context, (tx) =>
      tx
        .update(researchItems)
        .set({ archivedAt: new Date() })
        .where(eq(researchItems.id, fixture.researchItemId)),
    );
    expect(await service.mediaPreview(context, fixture.snapshotId)).toMatchObject({
      archivedItem: true,
      canReadArchive: false,
    });
    await expect(
      service.signMediaRead(context, fixture.snapshotId, fixture.mediaId),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("deduplicates content across immutable source records without creating an authorized asset", async () => {
    const a = await capture(),
      b = await capture();
    const processor = new CaptureMediaProcessor(database, storage, scanner, fetchImage());
    await processor.process(job(a));
    await processor.process(job(b));
    expect((await row(a.mediaId)).status).toBe("archived");
    expect((await row(b.mediaId)).status).toBe("archived");
    expect(a.mediaId).not.toBe(b.mediaId);
    expect((await row(a.mediaId)).objectKey).toBe((await row(b.mediaId)).objectKey);
    await expect(
      database.client.unsafe("select count(*)::int as count from asset_files where tenant_id=$1", [
        tenantId,
      ]),
    ).resolves.toMatchObject([{ count: 0 }]);
  });

  it("keeps videos distinct and stores their original container bytes", async () => {
    const fixture = await capture({ kind: "video" }),
      mp4 = Buffer.alloc(40);
    mp4.writeUInt32BE(24, 0);
    mp4.write("ftypisom", 4);
    const processor = new CaptureMediaProcessor(database, storage, scanner, {
      download: async () => ({ body: mp4, mediaType: "video/mp4" }),
    });
    await expect(processor.process(job(fixture))).resolves.toEqual({ state: "archived" });
    expect(await row(fixture.mediaId)).toMatchObject({
      kind: "video",
      mediaType: "video/mp4",
      checksumSha256: checksumSha256(mp4),
    });
  });

  it("does not fetch excluded, cross-tenant, mismatched-snapshot or forged-actor jobs", async () => {
    const excluded = await capture({ included: false }),
      included = await capture(),
      downloader = fetchImage();
    const processor = new CaptureMediaProcessor(database, storage, scanner, downloader);
    await processor.process(job(excluded));
    await processor.process({ ...job(included), tenantId: otherTenant, requestedBy: otherUser });
    await processor.process({ ...job(included), requestedBy: otherUser });
    await processor.process(job({ mediaId: included.mediaId, snapshotId: excluded.snapshotId }));
    expect(downloader.download).not.toHaveBeenCalled();
    expect((await row(included.mediaId)).attemptCount).toBe(0);
    await processor.process(job(included));
    expect((await row(included.mediaId)).status).toBe("archived");
  });

  it("rejects revoked execution permission before any download", async () => {
    const fixture = await capture(),
      downloader = fetchImage();
    try {
      await grant([Permission.CaptureRead]);
      await new CaptureMediaProcessor(database, storage, scanner, downloader).process(job(fixture));
      expect(downloader.download).not.toHaveBeenCalled();
      expect(await row(fixture.mediaId)).toMatchObject({
        status: "failed",
        failureReason: "MEDIA_ACCESS_REVOKED",
        objectKey: null,
      });
    } finally {
      await grant();
    }
  });

  it("rechecks permissions after download before writing object storage", async () => {
    const fixture = await capture(),
      putPrivate = vi.fn(storage.putPrivate.bind(storage));
    try {
      const processor = new CaptureMediaProcessor(database, { putPrivate }, scanner, {
        download: async () => {
          await grant([]);
          return { body: image, mediaType: "image/png" };
        },
      });
      await expect(processor.process(job(fixture))).resolves.toEqual({ state: "failed" });
      expect(putPrivate).not.toHaveBeenCalled();
      expect((await row(fixture.mediaId)).failureReason).toBe("MEDIA_ACCESS_REVOKED");
    } finally {
      await grant();
    }
  });

  it("rechecks permissions before commit and cannot expose an uncommitted private object", async () => {
    const fixture = await capture();
    try {
      const processor = new CaptureMediaProcessor(
        database,
        {
          putPrivate: async (...args) => {
            const result = await storage.putPrivate(...args);
            await grant([]);
            return result;
          },
        },
        scanner,
        fetchImage(),
      );
      await expect(processor.process(job(fixture))).resolves.toEqual({ state: "failed" });
      expect(await row(fixture.mediaId)).toMatchObject({ status: "failed", objectKey: null });
      await expect(
        service.signMediaRead(context, fixture.snapshotId, fixture.mediaId),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      await grant();
    }
  });

  it("blocks a real antivirus test signature before image parsing or storage", async () => {
    const fixture = await capture(),
      putPrivate = vi.fn(storage.putPrivate.bind(storage));
    const eicar = Buffer.from(
      "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
    );
    const processor = new CaptureMediaProcessor(database, { putPrivate }, scanner, {
      download: async () => ({ body: eicar, mediaType: "image/png" }),
    });
    await expect(processor.process(job(fixture))).resolves.toEqual({ state: "failed" });
    expect(await row(fixture.mediaId)).toMatchObject({
      failureReason: "MEDIA_SCAN_INFECTED",
      objectKey: null,
    });
    expect(putPrivate).not.toHaveBeenCalled();
  });

  it("records bounded retries and a safe diagnostic when the scanner or transport is unavailable", async () => {
    const fixture = await capture();
    const processor = new CaptureMediaProcessor(database, storage, scanner, {
      download: async () => {
        throw new Error("unsafe raw transport diagnostic token=do-not-persist");
      },
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await expect(processor.process(job(fixture))).resolves.toEqual({
        state: attempt < 3 ? "queued" : "failed",
      });
      const current = await row(fixture.mediaId);
      expect(current.attemptCount).toBe(attempt);
      expect(current.failureReason).toBe("MEDIA_ARCHIVE_UNAVAILABLE");
      if (attempt < 3)
        await withTenant(database.db, context, (tx) =>
          tx
            .update(captureMedia)
            .set({ nextAttemptAt: sql`clock_timestamp() - interval '1 second'` })
            .where(eq(captureMedia.id, fixture.mediaId)),
        );
    }
    expect((await row(fixture.mediaId)).objectKey).toBeNull();
    const unavailable = await capture();
    await expect(
      new CaptureMediaProcessor(
        database,
        storage,
        {
          scan: async () => {
            throw new Error("scanner offline");
          },
        },
        fetchImage(),
      ).process(job(unavailable)),
    ).resolves.toEqual({ state: "queued" });
    await expect(
      service.signMediaRead(context, unavailable.snapshotId, unavailable.mediaId),
    ).rejects.toMatchObject({ status: 409 });
    // Finish the synthetic pending task so it cannot interfere with scheduler acceptance.
    await withTenant(database.db, context, (tx) =>
      tx
        .update(captureMedia)
        .set({ nextAttemptAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(captureMedia.id, unavailable.mediaId)),
    );
    await new CaptureMediaProcessor(database, storage, scanner, fetchImage()).process(
      job(unavailable),
    );
  });

  it("fences a stale worker after lease recovery and preserves the replacement archive", async () => {
    const fixture = await capture(),
      started = deferredSignal(),
      release = deferredSignal();
    const slow = new CaptureMediaProcessor(database, storage, scanner, {
      download: async () => {
        started.resolve();
        await release.promise;
        return { body: image, mediaType: "image/png" };
      },
    });
    const pending = slow.process(job(fixture));
    try {
      await started.promise;
      await expect(slow.process(job(fixture))).resolves.toEqual({ state: "skipped" });
      await withTenant(database.db, context, (tx) =>
        tx
          .update(captureMedia)
          .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(captureMedia.id, fixture.mediaId)),
      );
      await expect(
        new CaptureMediaProcessor(database, storage, scanner, fetchImage()).process(job(fixture)),
      ).resolves.toEqual({ state: "archived" });
    } finally {
      release.resolve();
    }
    await expect(pending).resolves.toEqual({ state: "fenced" });
    expect(await row(fixture.mediaId)).toMatchObject({
      status: "archived",
      attemptCount: 2,
      leaseToken: null,
    });
  });

  it("uses database time when the Worker clock is ahead or behind", async () => {
    const fixture = await capture(),
      downloader = {
        download: vi.fn(async () => {
          throw new CaptureMediaError("MEDIA_HTTP_FAILED", true);
        }),
      };
    const processor = new CaptureMediaProcessor(database, storage, scanner, downloader),
      hostNow = Date.now();
    await withTenant(database.db, context, (tx) =>
      tx
        .update(captureMedia)
        .set({ nextAttemptAt: sql`clock_timestamp() + interval '5 minutes'` })
        .where(eq(captureMedia.id, fixture.mediaId)),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(hostNow + 2 * 3600_000);
      await expect(processor.process(job(fixture))).resolves.toEqual({ state: "skipped" });
      expect(downloader.download).not.toHaveBeenCalled();
      await withTenant(database.db, context, (tx) =>
        tx
          .update(captureMedia)
          .set({ nextAttemptAt: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(captureMedia.id, fixture.mediaId)),
      );
      vi.setSystemTime(hostNow - 2 * 3600_000);
      await expect(processor.process(job(fixture))).resolves.toEqual({ state: "queued" });
      const current = await row(fixture.mediaId);
      const times = await withTenant(database.db, context, (tx) =>
        tx.execute(
          sql<{
            seconds: number;
          }>`select extract(epoch from (${current.nextAttemptAt.toISOString()}::timestamptz - clock_timestamp()))::int as seconds`,
        ),
      );
      expect(times[0]!.seconds).toBeGreaterThan(50);
      expect(times[0]!.seconds).toBeLessThanOrEqual(60);
    } finally {
      vi.useRealTimers();
    }
    await withTenant(database.db, context, (tx) =>
      tx
        .update(captureMedia)
        .set({ nextAttemptAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(captureMedia.id, fixture.mediaId)),
    );
    await new CaptureMediaProcessor(database, storage, scanner, fetchImage()).process(job(fixture));
  });

  it("dispatches the registered API producer with IDs only and consumes its real Redis job", async () => {
    const producer = new RedisMediaEnqueuer(),
      queue = createQueue(QueueName.Media),
      observed: JobEnvelope[] = [];
    const processor = new CaptureMediaProcessor(database, storage, scanner, fetchImage());
    const worker = createWorker(QueueName.Media, (envelope) => {
      observed.push(envelope);
      return processor.process(envelope);
    });
    try {
      await worker.waitUntilReady();
      const fixture = await capture({
        service: new CaptureService(database, producer, audit, classification, storage),
      });
      await vi.waitFor(async () => expect((await row(fixture.mediaId)).status).toBe("archived"), {
        timeout: 20_000,
      });
      expect(
        observed.find(
          (envelope) =>
            CaptureMediaJobPayloadSchema.safeParse(envelope.payload).data?.mediaId ===
            fixture.mediaId,
        )?.payload,
      ).toEqual({ mediaId: fixture.mediaId, snapshotId: fixture.snapshotId });
      expect((await queue.getJob(fixture.mediaId))?.data.payload).toEqual({
        mediaId: fixture.mediaId,
        snapshotId: fixture.snapshotId,
      });
    } finally {
      await worker.close();
      await producer.onModuleDestroy();
      await queue.close();
    }
  });

  it("recovers a committed intent after queue failure through a real BullMQ Worker", async () => {
    const failedService = new CaptureService(
      database,
      {
        enqueue: async () => {
          throw new Error("queue secret must not be persisted");
        },
      },
      audit,
      classification,
      storage,
    );
    const fixture = await capture({ service: failedService });
    const neighboring = await capture({ service: failedService });
    expect(fixture.status).toBe("partial");
    expect(await row(fixture.mediaId)).toMatchObject({
      status: "queued",
      failureReason: "MEDIA_QUEUE_UNAVAILABLE",
    });
    const queue = createQueue(QueueName.Media),
      observed: JobEnvelope[] = [];
    const scheduler = new CaptureMediaScheduler(database, queue);
    const competing = new CaptureMediaScheduler(database, createQueue(QueueName.Media));
    const processor = new CaptureMediaProcessor(database, storage, scanner, fetchImage());
    const worker = createWorker(QueueName.Media, (envelope) => {
      observed.push(envelope);
      return processor.process(envelope);
    });
    try {
      await worker.waitUntilReady();
      const originalAdd = queue.add.bind(queue);
      let fixtureRejected = false;
      const failOnce = vi.spyOn(queue, "add").mockImplementation(async (...args) => {
        if (args[1].payload.mediaId === fixture.mediaId && !fixtureRejected) {
          fixtureRejected = true;
          throw new Error("do not persist the raw queue failure");
        }
        return originalAdd(...args);
      });
      try {
        expect((await scheduler.dispatch()).failed).toBe(1);
        expect(fixtureRejected).toBe(true);
      } finally {
        failOnce.mockRestore();
      }
      expect((await row(fixture.mediaId)).lastDispatchedAt).toBeNull();
      expect((await row(fixture.mediaId)).dispatchCount).toBe(1);
      await vi.waitFor(
        async () => expect((await row(neighboring.mediaId)).status).toBe("archived"),
        { timeout: 20_000 },
      );
      const dispatched = await Promise.all([scheduler.dispatch(), competing.dispatch()]);
      expect(dispatched.reduce((sum, item) => sum + item.queued, 0)).toBeGreaterThanOrEqual(1);
      expect(dispatched.reduce((sum, item) => sum + item.failed, 0)).toBe(0);
      await vi.waitFor(async () => expect((await row(fixture.mediaId)).status).toBe("archived"), {
        timeout: 20_000,
      });
      expect((await row(fixture.mediaId)).dispatchCount).toBe(2);
      expect(
        observed.find(
          (envelope) =>
            CaptureMediaJobPayloadSchema.safeParse(envelope.payload).data?.mediaId ===
            fixture.mediaId,
        )?.payload,
      ).toEqual({ mediaId: fixture.mediaId, snapshotId: fixture.snapshotId });
      expect(JSON.stringify(observed)).not.toContain("https://");
      await scheduler.dispatch();
      expect((await row(fixture.mediaId)).dispatchCount).toBe(2);
      expect((await row(fixture.mediaId)).status).toBe("archived");
    } finally {
      await scheduler.close();
      await competing.close();
      await worker.close();
    }
  });

  it("rejects source rewrites, incomplete archive metadata and archived-result rewrites at the database boundary", async () => {
    const fixture = await capture();
    await expect(
      withTenant(database.db, context, (tx) =>
        tx
          .update(captureMedia)
          .set({ sourceUrl: "https://m.media-amazon.com/changed.png" })
          .where(eq(captureMedia.id, fixture.mediaId)),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(database.db, context, (tx) =>
        tx
          .update(captureMedia)
          .set({
            status: "archived",
            objectKey: `tenants/${tenantId}/research/${"a".repeat(64)}/capture.png`,
            archivedAt: new Date(),
          })
          .where(eq(captureMedia.id, fixture.mediaId)),
      ),
    ).rejects.toThrow();
    await new CaptureMediaProcessor(database, storage, scanner, fetchImage()).process(job(fixture));
    await expect(
      withTenant(database.db, context, (tx) =>
        tx
          .update(captureMedia)
          .set({ failureReason: "rewrite" })
          .where(eq(captureMedia.id, fixture.mediaId)),
      ),
    ).rejects.toThrow();
  });

  it("refuses current archived research and narrowed ownership scopes", async () => {
    const archived = await capture(),
      scoped = await capture(),
      downloader = fetchImage();
    await withTenant(database.db, context, async (tx) => {
      await tx
        .update(researchItems)
        .set({ archivedAt: new Date() })
        .where(eq(researchItems.id, archived.researchItemId));
      await tx
        .update(researchItems)
        .set({ ownerUserId: otherUser })
        .where(eq(researchItems.id, scoped.researchItemId));
    });
    try {
      await new CaptureMediaProcessor(database, storage, scanner, downloader).process(
        job(archived),
      );
      await grant(permissions, "self");
      await new CaptureMediaProcessor(database, storage, scanner, downloader).process(job(scoped));
      expect(downloader.download).not.toHaveBeenCalled();
      expect((await row(archived.mediaId)).failureReason).toBe("MEDIA_RESEARCH_UNAVAILABLE");
      expect((await row(scoped.mediaId)).failureReason).toBe("MEDIA_ACCESS_REVOKED");
    } finally {
      await grant();
    }
  });

  it.each(["self", "team"])(
    "scoped authority does not borrow tenant research reads for %s background capture writes",
    async (scope) => {
      const fixture = await capture(),
        downloader = fetchImage();
      await withTenant(database.db, context, (tx) =>
        tx
          .update(researchItems)
          .set({ ownerUserId: otherUser })
          .where(eq(researchItems.id, fixture.researchItemId)),
      );
      const remove = await additionalRole([Permission.ResearchRead], "tenant");
      try {
        await grant(permissions, scope);
        await new CaptureMediaProcessor(database, storage, scanner, downloader).process(
          job(fixture),
        );
        expect(downloader.download).not.toHaveBeenCalled();
        expect((await row(fixture.mediaId)).failureReason).toBe("MEDIA_ACCESS_REVOKED");
      } finally {
        await grant();
        await remove();
      }
    },
  );

  it("scoped authority requires both capture and asset owner scope before a private read", async () => {
    const fixture = await capture();
    await new CaptureMediaProcessor(database, storage, scanner, fetchImage()).process(job(fixture));
    await withTenant(database.db, context, (tx) =>
      tx
        .update(researchItems)
        .set({ ownerUserId: otherUser })
        .where(eq(researchItems.id, fixture.researchItemId)),
    );
    const remove = await additionalRole([Permission.CaptureRead], "tenant"),
      signRead = vi.fn(async () => "http://localhost/synthetic-unreturned-lease");
    const privateService = new CaptureService(database, enqueuer, audit, classification, {
      signRead,
    } as unknown as typeof storage);
    try {
      await grant(permissions, "self");
      const current = await currentContext();
      expect
        .soft((await privateService.mediaPreview(current, fixture.snapshotId)).canReadArchive)
        .toBe(false);
      await expect(
        privateService.signMediaRead(current, fixture.snapshotId, fixture.mediaId),
      ).rejects.toMatchObject({ status: 403 });
      expect(signRead).not.toHaveBeenCalled();
    } finally {
      await grant();
      await remove();
    }
  });

  it("scoped authority cannot use broad capture writes to read another owner's snapshots", async () => {
    const fixture = await capture();
    await withTenant(database.db, context, (tx) =>
      tx
        .update(researchItems)
        .set({ ownerUserId: otherUser })
        .where(eq(researchItems.id, fixture.researchItemId)),
    );
    const remove = await additionalRole([Permission.CaptureWrite], "tenant");
    try {
      await grant(permissions, "self");
      const current = await currentContext();
      await expect(service.getSnapshot(current, fixture.snapshotId)).rejects.toMatchObject({
        status: 403,
      });
      await expect(service.mediaPreview(current, fixture.snapshotId)).rejects.toMatchObject({
        status: 403,
      });
    } finally {
      await grant();
      await remove();
    }
  });

  it.each(["self", "team"])(
    "scoped authority filters %s research lists, totals, timelines and archive commands",
    async (scope) => {
      const fixture = await capture();
      await withTenant(database.db, context, (tx) =>
        tx
          .update(researchItems)
          .set({ ownerUserId: otherUser })
          .where(eq(researchItems.id, fixture.researchItemId)),
      );
      const remove = await additionalRole([Permission.CaptureWrite], "tenant");
      try {
        await grant([...permissions, Permission.ResearchWrite], scope);
        const current = await currentContext(),
          repository = new ResearchRepository(database);
        expect(await repository.list(current, { item: fixture.researchItemId })).toMatchObject({
          items: [],
          total: 0,
        });
        expect(await repository.timeline(current, fixture.researchItemId)).toEqual([]);
        expect(await repository.snapshotCount(current, fixture.researchItemId)).toBe(0);
        await expect(
          new ResearchArchiveService(database, audit).setArchived(current, {
            itemIds: [fixture.researchItemId],
            archived: true,
          }),
        ).rejects.toMatchObject({ status: 404 });
      } finally {
        await grant();
        await remove();
      }
    },
  );

  it.each(["permission", "owner", "archive"])(
    "scoped authority rechecks %s after signing before returning a private lease",
    async (change) => {
      const fixture = await capture();
      await new CaptureMediaProcessor(database, storage, scanner, fetchImage()).process(
        job(fixture),
      );
      try {
        await grant(permissions, "self");
        const current = await currentContext(),
          signRead = vi.fn(async () => {
            if (change === "permission")
              await grant(
                permissions.filter((permission) => permission !== Permission.AssetRead),
                "self",
              );
            else
              await withTenant(database.db, context, (tx) =>
                tx
                  .update(researchItems)
                  .set(change === "owner" ? { ownerUserId: otherUser } : { archivedAt: new Date() })
                  .where(eq(researchItems.id, fixture.researchItemId)),
              );
            return "http://localhost/synthetic-unreturned-lease";
          });
        const privateService = new CaptureService(database, enqueuer, audit, classification, {
          signRead,
        } as unknown as typeof storage);
        await expect(
          privateService.signMediaRead(current, fixture.snapshotId, fixture.mediaId),
        ).rejects.toMatchObject({ status: change === "archive" ? 404 : 403 });
        expect(signRead).toHaveBeenCalledTimes(1);
      } finally {
        await grant();
      }
    },
  );

  it.each(["download", "storage"])(
    "scoped authority fences a narrowed capture write during %s",
    async (boundary) => {
      const fixture = await capture();
      await withTenant(database.db, context, (tx) =>
        tx
          .update(researchItems)
          .set({ ownerUserId: otherUser })
          .where(eq(researchItems.id, fixture.researchItemId)),
      );
      const remove = await additionalRole([Permission.ResearchRead], "tenant");
      const putPrivate = vi.fn(async (...args: Parameters<typeof storage.putPrivate>) => {
        const result = await storage.putPrivate(...args);
        if (boundary === "storage") await grant(permissions, "self");
        return result;
      });
      try {
        await new CaptureMediaProcessor(database, { putPrivate }, scanner, {
          download: async () => {
            if (boundary === "download") await grant(permissions, "self");
            return { body: image, mediaType: "image/png" };
          },
        }).process(job(fixture));
        expect(putPrivate).toHaveBeenCalledTimes(boundary === "storage" ? 1 : 0);
        expect(await row(fixture.mediaId)).toMatchObject({
          status: "failed",
          failureReason: "MEDIA_ACCESS_REVOKED",
          objectKey: null,
        });
      } finally {
        await grant();
        await remove();
      }
    },
  );

  it("scoped authority checks current write access before replaying a saved study", async () => {
    const fixture = await capture(),
      studies = new ResearchStudyService(database, audit);
    const remove = await additionalRole([Permission.ResearchRead], "tenant");
    try {
      await grant([...permissions, Permission.ResearchWrite]);
      const current = await currentContext(),
        input = {
          requestId: createEntityId(),
          snapshotId: fixture.snapshotId,
          expectedVersion: 0,
          content: ResearchStudyContentSchema.parse({ theme: "Original private study" }),
        };
      const first = await studies.save(current, fixture.researchItemId, input);
      await withTenant(database.db, context, (tx) =>
        tx
          .update(researchItems)
          .set({ ownerUserId: otherUser })
          .where(eq(researchItems.id, fixture.researchItemId)),
      );
      await grant([...permissions, Permission.ResearchWrite], "self");
      await expect(studies.save(current, fixture.researchItemId, input)).rejects.toMatchObject({
        status: 404,
      });
      expect((await studies.workspace(current, fixture.researchItemId)).revision?.id).toBe(
        first.id,
      );
      expect(
        await studies.resolve(current, [
          { researchItemId: fixture.researchItemId, snapshotId: fixture.snapshotId },
        ]),
      ).toHaveLength(1);
      await remove();
      await expect(studies.workspace(current, fixture.researchItemId)).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        studies.resolve(current, [
          { researchItemId: fixture.researchItemId, snapshotId: fixture.snapshotId },
        ]),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await grant();
      await remove();
    }
  });

  it("scoped authority keeps self classification from changing shared aliases or another owner's items", async () => {
    const own = await capture(),
      other = await capture(),
      key = "scope-" + createEntityId();
    await withTenant(database.db, context, async (tx) => {
      await tx
        .update(researchItems)
        .set({
          classificationStatus: "suggested",
          classificationSource: "marketplace_taxonomy",
          classificationEvidenceSource: "marketplace_taxonomy",
          classificationEvidenceKey: key,
          classificationEvidenceLabel: "Synthetic public category",
          productTypeKey: "original",
          productTypeName: "Original category",
        })
        .where(sql`${researchItems.id} in (${own.researchItemId},${other.researchItemId})`);
      await tx
        .update(researchItems)
        .set({ ownerUserId: otherUser })
        .where(eq(researchItems.id, other.researchItemId));
      await tx.insert(researchProductTypeAliases).values({
        tenantId,
        platform: "amazon",
        evidenceSource: "marketplace_taxonomy",
        evidenceKey: key,
        evidenceLabel: "Synthetic public category",
        productTypeKey: "shared-baseline",
        productTypeName: "Shared baseline",
        updatedBy: userId,
      });
    });
    const remove = await additionalRole([Permission.ResearchRead], "tenant");
    try {
      await grant([...permissions, Permission.ResearchWrite], "self");
      const current = await currentContext();
      expect(
        await classification.assign(current, {
          itemIds: [own.researchItemId],
          productTypeName: "My private category",
        }),
      ).toMatchObject({ updated: 1, cascaded: 0 });
      const rows = await withTenant(database.db, context, (tx) =>
        tx
          .select()
          .from(researchItems)
          .where(sql`${researchItems.id} in (${own.researchItemId},${other.researchItemId})`),
      );
      expect(rows.find((row) => row.id === own.researchItemId)?.productTypeName).toBe(
        "My private category",
      );
      expect(rows.find((row) => row.id === other.researchItemId)?.productTypeName).toBe(
        "Original category",
      );
      const [alias] = await withTenant(database.db, context, (tx) =>
        tx
          .select()
          .from(researchProductTypeAliases)
          .where(eq(researchProductTypeAliases.evidenceKey, key)),
      );
      expect(alias?.productTypeName).toBe("Shared baseline");
      await expect(
        classification.assign(current, {
          itemIds: [own.researchItemId, other.researchItemId],
          productTypeName: "Unauthorized batch",
        }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await grant();
      await remove();
    }
  });

  it("scoped authority limits legacy project references and counts by the design read scope", async () => {
    const fixture = await capture(),
      projectId = createEntityId();
    // Minimal legacy reference: the scope boundary must protect its metadata too.
    await withTenant(database.db, context, (tx) =>
      tx.execute(
        sql`insert into creative_design_batches(id,tenant_id,name,item_count,request_checksum,created_by,execution_mode,canvas_workflow) values(${projectId},${tenantId},'Private legacy reference',1,${"a".repeat(64)},${otherUser},'infinite_canvas',${JSON.stringify({ stepIndex: 0, requirements: { researchItemIds: [fixture.researchItemId] } })}::jsonb)`,
      ),
    );
    const remove = await additionalRole([Permission.ResearchRead], "tenant");
    try {
      await grant([...permissions, Permission.DesignRead], "self");
      const current = await currentContext(),
        studies = new ResearchStudyService(database, audit),
        repository = new ResearchRepository(database);
      expect((await studies.workspace(current, fixture.researchItemId)).projects).toEqual([]);
      expect(
        (await repository.list(current, { item: fixture.researchItemId })).items[0]?.study
          ?.creativeCount,
      ).toBe(0);
      await grant([...permissions, Permission.DesignRead]);
      expect(
        (await studies.workspace(await currentContext(), fixture.researchItemId)).projects,
      ).toEqual([{ id: projectId, name: "Private legacy reference" }]);
      expect(
        (await repository.list(await currentContext(), { item: fixture.researchItemId })).items[0]
          ?.study?.creativeCount,
      ).toBe(1);
    } finally {
      await grant();
      await remove();
    }
  });

  it("reports a permanent transport policy error without retrying it", async () => {
    const fixture = await capture();
    const processor = new CaptureMediaProcessor(database, storage, scanner, {
      download: async () => {
        throw new CaptureMediaError("MEDIA_ADDRESS_UNSAFE");
      },
    });
    await expect(processor.process(job(fixture))).resolves.toEqual({ state: "failed" });
    expect(await row(fixture.mediaId)).toMatchObject({
      attemptCount: 1,
      failureReason: "MEDIA_ADDRESS_UNSAFE",
    });
  });
});

function deferredSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
