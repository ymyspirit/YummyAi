import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { CaptureDraftSchema, createEntityId, type TenantContext } from "@yummyai/contracts";
import { ResearchStudyContentSchema } from "@yummyai/contracts/research/creative";
import {
  connectDatabase,
  migrateDatabase,
  researchStudyRevisions,
  withTenant,
} from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { CaptureService } from "../capture/capture.service.js";
import { CanvasBridgeService } from "../design/canvas-bridge.service.js";
import { DesignService, DrizzleDesignRepository } from "../design/design.service.js";
import { PodBatchWorkflowService } from "../design/pod-batch-workflow.service.js";
import { ResearchClassificationService } from "./research-classification.service.js";
import { ResearchStudyService } from "./research-study.service.js";
import { ResearchRepository } from "./research.repository.js";
import { ResearchArchiveService } from "./research-archive.service.js";

describe("research study versions and creative handoff", () => {
  const database = connectDatabase(),
    storage = createStorageFromEnvironment();
  const a: TenantContext = {
    tenantId: createEntityId(),
    userId: createEntityId(),
    permissions: Object.values(Permission),
    dataScope: "tenant",
  };
  const b: TenantContext = { ...a, tenantId: createEntityId(), userId: createEntityId() };
  const audit = new AuditService(database);
  const archive = new ResearchArchiveService(database, audit);
  const studies = new ResearchStudyService(database, audit),
    repository = new ResearchRepository(database);
  const capture = new CaptureService(
    database,
    { enqueue: async () => undefined },
    audit,
    new ResearchClassificationService(database, audit),
  );
  const enqueue = {
    enqueueCreativeCandidate: vi.fn(),
    enqueueCreativeAdaptation: vi.fn(),
    enqueueTemplateCompile: vi.fn(),
    enqueueMockupRender: vi.fn(),
  };
  const bridge = new CanvasBridgeService(
    database,
    storage,
    audit,
    new PodBatchWorkflowService(
      database,
      enqueue,
      audit,
      new DesignService(new DrizzleDesignRepository(database, storage)),
    ),
  );
  const draft = (id: string, title = "Synthetic research", time = new Date().toISOString()) =>
    CaptureDraftSchema.parse({
      platform: "etsy",
      parserVersion: "etsy@1.0.0",
      extensionVersion: "0.0.0",
      marketplace: "www.etsy.com",
      sourceUrl: `https://www.etsy.com/listing/${id}/synthetic`,
      externalId: id,
      title,
      domain: "research",
      capturedAt: time,
      price: { raw: "$20", amount: 20, currency: "USD" },
      rating: null,
      reviewCount: null,
      taxonomy: [],
      listingPublishedAt: null,
      favoriteCount: null,
      shipping: null,
      shop: null,
      reviewSummary: null,
      reviews: [],
      reviewCollection: {
        collectedCount: 0,
        reportedTotal: null,
        pageCount: 0,
        status: "visible",
        updatedAt: time,
      },
      bullets: [],
      variants: [],
      productInformation: [],
      contentBlocks: [],
      missingFields: [],
      diagnostics: [],
      captureStatus: "complete",
      media: [
        {
          id: "one",
          kind: "image",
          sourceUrl: "https://images.example.test/one.png",
          included: true,
        },
        {
          id: "excluded",
          kind: "image",
          sourceUrl: "https://images.example.test/excluded.png",
          included: false,
        },
        {
          id: "two",
          kind: "image",
          sourceUrl: "https://images.example.test/two.png",
          included: true,
        },
      ],
    });
  const content = () =>
    ResearchStudyContentSchema.parse({
      status: "analyzed",
      theme: "原创纪念花园",
      differentiation: "原创花卉构图，定制名字留白",
      audience: "纪念礼物购买者",
      annotations: [{ mediaIndex: 2, note: "文字对比度需要改善" }],
    });
  beforeAll(async () => {
    await migrateDatabase(database);
    for (const context of [a, b]) {
      await database.client.unsafe(
        "insert into organizations(id,name,slug) values($1,'Synthetic research handoff',$2)",
        [context.tenantId, `research-${context.tenantId}`],
      );
      await database.client.unsafe(
        "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic researcher')",
        [context.userId, `research-${context.userId}`, `${context.userId}@example.test`],
      );
    }
  });
  afterAll(async () => database.client.end());

  it("appends immutable revisions, replays retries, and rejects stale or invalid annotations", async () => {
    const captured = await capture.createSnapshot(a, draft("9001000001"));
    const input = {
      requestId: randomUUID(),
      snapshotId: captured.snapshotId,
      expectedVersion: 0,
      content: content(),
    };
    const [first, retry] = await Promise.all([
      studies.save(a, captured.researchItemId, input),
      studies.save(a, captured.researchItemId, input),
    ]);
    expect(first.id).toBe(retry.id);
    await expect(
      studies.save(a, captured.researchItemId, { ...input, requestId: randomUUID() }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      studies.save(a, captured.researchItemId, {
        ...input,
        content: { ...input.content, theme: "changed" },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      studies.save(a, captured.researchItemId, {
        ...input,
        requestId: randomUUID(),
        expectedVersion: 1,
        content: { ...input.content, annotations: [{ mediaIndex: 1, note: "excluded" }] },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      withTenant(database.db, a, (tx) =>
        tx
          .update(researchStudyRevisions)
          .set({ content: content() })
          .where(eq(researchStudyRevisions.id, first.id)),
      ),
    ).rejects.toThrow();
    const second = await studies.save(a, captured.researchItemId, {
      ...input,
      requestId: randomUUID(),
      expectedVersion: 1,
      content: { ...input.content, theme: "新的原创方向" },
    });
    expect(second.version).toBe(2);
    expect(
      (await studies.workspace(a, captured.researchItemId, first.id)).revision?.content.theme,
    ).toBe("原创纪念花园");
    expect(
      (await repository.list(a, { item: captured.researchItemId, researchStatus: "analyzed" }))
        .items[0],
    ).toMatchObject({
      thumbnailUrl: "https://images.example.test/one.png",
      priceRaw: "$20",
      study: { status: "analyzed", version: 2 },
    });
    expect(
      (await repository.list(a, { item: captured.researchItemId, researchStatus: "unreviewed" }))
        .items,
    ).toEqual([]);
  });
  it("isolates source, snapshot and revision lookups by tenant and source item", async () => {
    const left = await capture.createSnapshot(a, draft("9001000002")),
      right = await capture.createSnapshot(a, draft("9001000003"));
    const revision = await studies.save(a, left.researchItemId, {
      requestId: randomUUID(),
      snapshotId: left.snapshotId,
      expectedVersion: 0,
      content: content(),
    });
    await expect(studies.workspace(b, left.researchItemId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      studies.resolve(b, [{ researchItemId: left.researchItemId }]),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      studies.resolve(a, [{ researchItemId: right.researchItemId, studyRevisionId: revision.id }]),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      studies.resolve(a, [{ researchItemId: right.researchItemId, snapshotId: left.snapshotId }]),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      studies.save(b, left.researchItemId, {
        requestId: randomUUID(),
        snapshotId: left.snapshotId,
        expectedVersion: 0,
        content: content(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      studies.save({ ...a, permissions: [Permission.ResearchRead] }, left.researchItemId, {}),
    ).rejects.toThrow();
    expect(
      await withTenant(database.db, b, (tx) => tx.select().from(researchStudyRevisions)),
    ).toEqual([]);
  });
  it("pins reviewed research into a creative brief and preserves it after recapture, edits and retries", async () => {
    const captured = await capture.createSnapshot(
      a,
      draft("9001000004", "Original captured title"),
    );
    const revision = await studies.save(a, captured.researchItemId, {
      requestId: randomUUID(),
      snapshotId: captured.snapshotId,
      expectedVersion: 0,
      content: content(),
    });
    const sources = await studies.resolve(a, [{ researchItemId: captured.researchItemId }]);
    expect(sources[0]).toMatchObject({
      snapshotId: captured.snapshotId,
      studyRevisionId: revision.id,
      mediaCount: 2,
    });
    const input = {
      requestId: randomUUID(),
      name: "Synthetic researched creative",
      prompt: "Make original artwork",
      requirements: { mode: "fixed", researchItemIds: [captured.researchItemId] },
    };
    const first = await bridge.create(a, input);
    expect(first.workflow?.researchReferences).toEqual(sources);
    expect(first.designInstructions).toContain("媒体 3 批注：文字对比度需要改善");
    expect(first.referenceAssets).toEqual([]);
    const recaptured = await capture.createSnapshot(
      a,
      draft("9001000004", "Changed captured title", new Date(Date.now() + 1000).toISOString()),
    );
    await studies.save(a, captured.researchItemId, {
      requestId: randomUUID(),
      snapshotId: recaptured.snapshotId,
      expectedVersion: 1,
      content: { ...content(), theme: "Later research direction" },
    });
    expect((await bridge.get(a, first.id)).workflow?.researchReferences).toEqual(sources);
    expect((await bridge.create(a, input)).id).toBe(first.id);
    const copy = await bridge.create(a, {
      ...input,
      requestId: randomUUID(),
      researchSources: [
        {
          researchItemId: captured.researchItemId,
          snapshotId: captured.snapshotId,
          studyRevisionId: revision.id,
        },
      ],
    });
    expect(copy.workflow?.researchReferences).toEqual(sources);
    const latest = await bridge.create(a, { ...input, requestId: randomUUID() });
    expect(latest.workflow?.researchReferences?.[0]?.content?.theme).toBe(
      "Later research direction",
    );
    expect((await studies.workspace(a, captured.researchItemId)).projects).toHaveLength(3);
    expect(
      (await repository.list(a, { item: captured.researchItemId })).items[0]?.study?.creativeCount,
    ).toBe(3);
    expect(
      (await bridge.list(a)).find((row) => row.id === first.id)?.workflow?.researchReferences,
    ).toBeUndefined();
    expect(enqueue.enqueueCreativeCandidate).not.toHaveBeenCalled();
  });

  it("archives only the tenant index and restores it without changing evidence or creative references", async () => {
    const captured = await capture.createSnapshot(a, draft("9001000005", "Archive fixture"));
    const original = await repository.timeline(a, captured.researchItemId);
    const brief = await bridge.create(a, {
      requestId: randomUUID(),
      name: "Archive research references",
      prompt: "Original design",
      requirements: { mode: "fixed", researchItemIds: [captured.researchItemId] },
    });
    const input = { itemIds: [captured.researchItemId], archived: true };
    await expect(archive.setArchived(b, input)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      archive.setArchived({ ...a, permissions: [Permission.ResearchRead] }, input),
    ).rejects.toThrow();
    await expect(
      archive.setArchived(a, { ...input, itemIds: [...input.itemIds, createEntityId()] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect((await repository.list(a, { q: "Archive fixture" })).total).toBe(1);
    await archive.setArchived(a, input);
    const archived = await repository.list(a, { q: "Archive fixture", visibility: "archived" });
    expect(archived.total).toBe(1);
    expect(archived.items[0]?.archivedAt).toBeTruthy();
    expect((await repository.list(a, { q: "Archive fixture" })).total).toBe(0);
    expect((await repository.list(b, { visibility: "all" })).items).toEqual([]);
    expect((await repository.list(a, { item: captured.researchItemId })).total).toBe(1);
    expect(await repository.timeline(a, captured.researchItemId)).toEqual(original);
    expect((await bridge.get(a, brief.id)).workflow?.researchReferences).toEqual(
      brief.workflow?.researchReferences,
    );
    await archive.setArchived(a, input);
    expect(
      (await repository.list(a, { q: "Archive fixture", visibility: "all" })).items[0]?.archivedAt,
    ).toBe(archived.items[0]?.archivedAt);
    await archive.setArchived(a, { ...input, archived: false });
    expect((await repository.list(a, { q: "Archive fixture" })).total).toBe(1);
    expect((await repository.list(a, { q: "Archive fixture", visibility: "archived" })).total).toBe(
      0,
    );
  });
});
