import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type ProductionEditorDocument, type TenantContext } from "@yummyai/contracts";
import { CANVAS_BRIDGE } from "@yummyai/contracts/pod/canvas-bridge";
import { assetFiles, canvasProductionHandoffs, connectDatabase, creativeDesignBatches, creativeDesignCandidates, creativeDesignVersions, creativeStudioEntries, creativeStudioRevisions, migrateDatabase, productionEditorProjects, withTenant } from "@yummyai/database";
import { CreativeRequirementsSchema } from "@yummyai/contracts/catalog/artwork";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { CanvasBridgeService } from "./canvas-bridge.service.js";
import { DesignService, DrizzleDesignRepository } from "./design.service.js";
import { PodBatchWorkflowService } from "./pod-batch-workflow.service.js";
import { CanvasWorkflowService } from "./canvas-workflow.service.js";
import { ProductionEditorService } from "./production-editor.service.js";
import { AmazonOrderReportService } from "../orders/amazon-order-report.service.js";
import { OrderService } from "../orders/order.service.js";

describe("Infinite Canvas bridge with tenant database and private storage", () => {
  const database = connectDatabase(), storage = createStorageFromEnvironment();
  const tenantA = createEntityId(), tenantB = createEntityId(), userA = createEntityId(), userB = createEntityId();
  const a: TenantContext = { tenantId: tenantA, userId: userA, permissions: Object.values(Permission), dataScope: "tenant" };
  const b: TenantContext = { ...a, tenantId: tenantB, userId: userB };
  const enqueue = { enqueueCreativeCandidate: vi.fn(), enqueueCreativeAdaptation: vi.fn(), enqueueTemplateCompile: vi.fn(), enqueueMockupRender: vi.fn() };
  const audit = new AuditService(database), designs = new PodBatchWorkflowService(database, enqueue, audit, new DesignService(new DrizzleDesignRepository(database, storage)));
  const vault = new SecretVault(Buffer.alloc(32, 122));
  const scanner = { scan: vi.fn(async () => ({ result: "clean" as const, engine: "synthetic", signatureVersion: "synthetic-1", scannedAt: new Date().toISOString() })) };
  const bridge = new CanvasBridgeService(database, storage, audit, designs, scanner);
  const reports = new AmazonOrderReportService(database, vault, new OrderService(database, vault, audit), audit, { download: async () => { throw new Error("No remote orders in canvas tests"); }, scan: scanner.scan }, { schedule: async () => undefined }, { schedule: async () => undefined });
  const production = new ProductionEditorService(database, vault, storage, reports, audit, { enqueue: vi.fn() }, scanner);
  const workflow = new CanvasWorkflowService(database, storage, bridge, designs, production, audit);
  let image: Buffer, referenceId: string, rejectedId: string, privateId: string;
  const draft = (referenceAssetIds = [referenceId]) => ({ requestId: randomUUID(), name: "Synthetic canvas brief", prompt: "Synthetic geometric artwork", referenceAssetIds });
  const result = () => ({ submissionId: randomUUID(), protocolVersion: 1, pluginVersion: CANVAS_BRIDGE.pluginVersion, upstreamVersion: CANVAS_BRIDGE.upstreamVersion, sourceNodeId: "synthetic-node", title: "Synthetic result", contentBase64: image.toString("base64"), rightsAttested: true, sourceKind: "owned", sourceReference: "Synthetic test artwork" });

  async function seedAsset(context: TenantContext, rightsStatus: string, sourceKind: string) {
    const id = createEntityId(), fileName = `synthetic-${id}.png`;
    const stored = await storage.putPrivate(context, { body: image, domain: "authorized", fileName, mediaType: "image/png" });
    await withTenant(database.db, context, (tx) => tx.insert(assetFiles).values({ id, tenantId: context.tenantId, ownerUserId: context.userId, objectKey: stored.objectKey, assetDomain: "authorized", fileName, mediaType: "image/png", byteSize: image.length, checksumSha256: stored.checksumSha256, rightsStatus, rightsMetadata: { source: { kind: sourceKind } } }));
    return id;
  }
  beforeAll(async () => {
    await migrateDatabase(database); await storage.ensureBucket();
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Canvas integration A',$2),($3,'Canvas integration B',$4)", [tenantA, `canvas-a-${tenantA}`, tenantB, `canvas-b-${tenantB}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Canvas integration A'),($4,$5,$6,'Canvas integration B')", [userA, `canvas-${userA}`, `${userA}@example.test`, userB, `canvas-${userB}`, `${userB}@example.test`]);
    image = await sharp({ create: { width: 64, height: 48, channels: 4, background: "#1e40af" } }).png().toBuffer();
    referenceId = await seedAsset(a, "approved", "owned"); rejectedId = await seedAsset(a, "unverified", "owned"); privateId = await seedAsset(a, "approved", "customer_provided");
  }, 60_000);
  afterAll(async () => database.client.end());

  it("revises a project without rewriting approved output and carries only the member's saved drafts", async () => {
    const originalInput = draft(), original = await bridge.create(a, originalInput);
    const receipt = await bridge.submit(a, original.id, result());
    await designs.reviewCreativeVersion(a, receipt.versionId, { decision: "approve" });
    const document = { studioDocument: true, data: JSON.stringify({ nodes: [{ id: "kept-node", text: "Original artwork" }] }) };
    await withTenant(database.db, a, async tx => {
      for (const ownerId of [userA, userB]) await tx.insert(creativeStudioEntries).values({ id: createEntityId(), tenantId: tenantA, ownerId, scope: original.id, namespace: "app_state", key: "infinite-canvas:canvas_store", revision: 2, value: document });
      await tx.insert(creativeStudioEntries).values({ id: createEntityId(), tenantId: tenantA, ownerId: userA, scope: original.id, namespace: "image_files", key: "saved-reference", revision: 1, assetId: referenceId });
    });
    const revised = await bridge.revise(a, original.id, { ...draft(), name: "Changed project", prompt: "Operator corrected the direction", expectedRevision: 1, changeNote: "Corrected brief", requirements: CreativeRequirementsSchema.parse({ mode: "fixed", audience: "Gift buyers" }) });
    expect(revised.id).not.toBe(original.id);
    expect(revised).toMatchObject({ name: "Changed project", prompt: "Operator corrected the direction", projectRevision: 2, resultCount: 0, workflow: { rootBatchId: original.id, parentBatchId: null, revision: { number: 2, sourceBriefId: original.id } } });
    expect(revised.revisions.map(r => r.number)).toEqual([2, 1]);
    expect(await bridge.get(a, original.id)).toMatchObject({ name: original.name, prompt: original.prompt, resultCount: 1, workflow: original.workflow, latestBriefId: revised.id });
    expect((await designs.getCreativeVersion(a, receipt.versionId)).status).toBe("approved");
    expect((await bridge.create(a, originalInput)).id).toBe(original.id);
    const copies = await withTenant(database.db, a, tx => tx.select().from(creativeStudioEntries).where(eq(creativeStudioEntries.scope, revised.id)));
    expect(copies).toHaveLength(2); expect(copies.every(c => c.ownerId === userA && c.revision === 1)).toBe(true);
    expect(copies.find(c => c.namespace === "app_state")?.value).toEqual(document);
    expect(copies.find(c => c.namespace === "image_files")?.assetId).toBe(referenceId);
    const copiedDocument = copies.find(c => c.namespace === "app_state")!;
    await withTenant(database.db, a, tx => tx.update(creativeStudioEntries).set({ value: { changed: true }, revision: 2 }).where(eq(creativeStudioEntries.id, copiedDocument.id)));
    const sourceEntries = await withTenant(database.db, a, tx => tx.select().from(creativeStudioEntries).where(eq(creativeStudioEntries.scope, original.id)));
    expect(sourceEntries.find(c => c.ownerId === userA && c.namespace === "app_state")?.value).toEqual(document);
    expect(await withTenant(database.db, a, tx => tx.select().from(creativeStudioRevisions).where(eq(creativeStudioRevisions.entryId, copiedDocument.id)))).toHaveLength(1);
    await expect(bridge.submit(a, original.id, result())).rejects.toBeInstanceOf(ConflictException);
    expect(enqueue.enqueueCreativeCandidate).not.toHaveBeenCalled();
  });

  it("serializes competing edits and safely replays a lost save response without making another revision", async () => {
    const original = await bridge.create(a, draft());
    const input = { ...draft(), expectedRevision: 1, name: "Revision A" };
    const attempts = await Promise.allSettled([bridge.revise(a, original.id, input), bridge.revise(a, original.id, { ...input, requestId: randomUUID(), name: "Revision B" })]);
    expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(r => r.status === "rejected")).toHaveLength(1);
    const current = await bridge.get(a, original.id);
    const winner = attempts.find(r => r.status === "fulfilled")!;
    if (winner.status !== "fulfilled") throw new Error("Missing successful revision");
    expect(current.projectRevision).toBe(2); expect(current.revisions).toHaveLength(2);
    if (winner.value.name === "Revision A") {
      expect((await bridge.revise(a, original.id, input)).id).toBe(winner.value.id);
      await expect(bridge.revise(a, original.id, { ...input, prompt: "Different retry" })).rejects.toBeInstanceOf(ConflictException);
    }
    const nextInput = { ...draft(), expectedRevision: 2 };
    const next = await bridge.revise(a, winner.value.id, nextInput);
    expect((await bridge.revise(a, winner.value.id, nextInput)).id).toBe(next.id);
    expect((await bridge.get(a, original.id)).revisions).toHaveLength(3);
    await expect(withTenant(database.db, a, tx => tx.update(creativeDesignBatches).set({ canvasWorkflow: null }).where(eq(creativeDesignBatches.id, original.id)))).rejects.toThrow();
  });

  it("authorizes every revision and preserves tenant, reference and specification boundaries", async () => {
    const original = await bridge.create(a, draft());
    const input = { ...draft(), expectedRevision: 1 };
    await expect(bridge.revise(b, original.id, input)).rejects.toBeInstanceOf(NotFoundException);
    await expect(bridge.revise({ ...a, permissions: [Permission.DesignRead, Permission.AssetRead] }, original.id, input)).rejects.toThrow();
    await expect(bridge.revise(a, original.id, { ...input, referenceAssetIds: [privateId] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(bridge.revise(a, original.id, { ...input, referenceAssetIds: [rejectedId] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(bridge.revise(a, original.id, { ...input, requirements: CreativeRequirementsSchema.parse({ mode: "fixed", specificationVersionIds: [createEntityId()] }) })).rejects.toThrow();
    expect((await bridge.get(a, original.id)).projectRevision).toBe(1);
  });
  it("keeps revision numbers monotonic after a working revision is cancelled and archived", async () => {
    const original = await bridge.create(a, draft());
    const next = await bridge.revise(a, original.id, { ...draft(), expectedRevision: 1 });
    await designs.cancelDesignBatch(a, next.id);
    await designs.archiveDesignBatch(a, next.id, { archived: true, reason: "Synthetic archive" });
    const current = await bridge.get(a, original.id);
    expect(current.projectRevision).toBe(2);
    expect(current.revisions.find(r => r.id === next.id)?.archived).toBe(true);
    expect((await bridge.revise(a, original.id, { ...draft(), expectedRevision: current.projectRevision })).projectRevision).toBe(3);
  });

  it("pins approved references, prevents duplicate briefs and does not start AI generation", async () => {
    const input = draft(), [first, second] = await Promise.all([bridge.create(a, input), bridge.create(a, input)]);
    expect(first.id).toBe(second.id); expect(first.referenceAssets.map((asset) => asset.id)).toEqual([referenceId]);
    const read = await bridge.readReference(a, first.id, referenceId);
    expect(read.contentBase64).toBe(image.toString("base64")); expect(enqueue.enqueueCreativeCandidate).not.toHaveBeenCalled();
    await expect(bridge.create(a, { ...input, prompt: "Changed payload" })).rejects.toBeInstanceOf(ConflictException);
  });
  it("isolates tenant reads and submissions and blocks unauthorized reference domains", async () => {
    const brief = await bridge.create(a, draft());
    await expect(bridge.get(b, brief.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(bridge.submit(b, brief.id, result())).rejects.toBeInstanceOf(NotFoundException);
    await expect(bridge.create(b, draft())).rejects.toBeInstanceOf(NotFoundException);
    await expect(bridge.create(a, draft([rejectedId]))).rejects.toBeInstanceOf(BadRequestException);
    await expect(bridge.create(a, draft([privateId]))).rejects.toBeInstanceOf(BadRequestException);
    await expect(bridge.readReference(a, brief.id, rejectedId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(bridge.create({ ...a, permissions: [] }, draft())).rejects.toThrow();
  });
  it("atomically saves a new pending review version and safely replays a concurrent retry", async () => {
    const brief = await bridge.create(a, draft()), input = result();
    const [left, right] = await Promise.all([bridge.submit(a, brief.id, input), bridge.submit(a, brief.id, input)]);
    expect(left.versionId).toBe(right.versionId); expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    const candidates = await withTenant(database.db, a, (tx) => tx.select().from(creativeDesignCandidates).where(eq(creativeDesignCandidates.itemId, brief.itemId)));
    expect(candidates).toHaveLength(1);
    const version = await designs.getCreativeVersion(a, left.versionId); expect(version.status).toBe("pending_review");
    const [asset] = await withTenant(database.db, a, (tx) => tx.select().from(assetFiles).where(eq(assetFiles.id, left.assetId)));
    expect(asset.rightsStatus).toBe("unverified");
    expect(Buffer.from(await storage.readPrivate(a, { ...asset, assetDomain: "authorized" }, { requiredDomain: "authorized" }))).toEqual(image);
    expect((await bridge.get(a, brief.id)).resultCount).toBe(1);
    await expect(bridge.submit(a, brief.id, { ...input, title: "Another title" })).rejects.toBeInstanceOf(ConflictException);
    await designs.reviewCreativeVersion(a, left.versionId, { decision: "approve" });
    expect((await designs.getCreativeVersion(a, left.versionId)).status).toBe("approved");
    const next = await bridge.submit(a, brief.id, result());
    expect(next.versionId).not.toBe(left.versionId);
    expect((await designs.getCreativeVersion(a, left.versionId)).status).toBe("approved");
    expect((await bridge.get(a, brief.id)).resultCount).toBe(2);
  });
  it("rejects invalid image bytes, unsupported versions, missing attestation and changed references", async () => {
    const brief = await bridge.create(a, draft());
    await expect(bridge.submit(a, brief.id, { ...result(), contentBase64: Buffer.from("<svg/>").toString("base64") })).rejects.toBeInstanceOf(BadRequestException);
    await expect(bridge.submit(a, brief.id, { ...result(), upstreamVersion: "v0.19.0" })).rejects.toThrow();
    await expect(bridge.submit(a, brief.id, { ...result(), rightsAttested: false })).rejects.toThrow();
    const changedId = await seedAsset(a, "approved", "owned"), pinned = await bridge.create(a, draft([changedId]));
    await withTenant(database.db, a, (tx) => tx.update(assetFiles).set({ version: 2 }).where(eq(assetFiles.id, changedId)));
    await expect(bridge.get(a, pinned.id)).rejects.toBeInstanceOf(ConflictException);
    await expect(bridge.submit(a, pinned.id, result())).rejects.toBeInstanceOf(ConflictException);
    const versions = await withTenant(database.db, b, (tx) => tx.select().from(creativeDesignVersions)); expect(versions).toEqual([]);
  });
  it("replays an older adapter receipt after upgrading without rewriting its version", async () => {
    const brief = await bridge.create(a, draft([])), input = result();
    const receipt = await bridge.submit(a, brief.id, { ...input, pluginVersion: "1.0.0" });
    expect(await bridge.submit(a, brief.id, input)).toEqual({ ...receipt, replayed: true });
    await expect(bridge.submit(a, brief.id, { ...input, sourceReference: "Changed attestation" })).rejects.toBeInstanceOf(ConflictException);
    expect((await bridge.get(a, brief.id)).resultCount).toBe(1);
  });
  it("enforces the four-result limit under concurrency and blocks cancelled briefs", async () => {
    const brief = await bridge.create(a, draft([]));
    const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => bridge.submit(a, brief.id, result())));
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(4);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(ConflictException);
    expect((await bridge.get(a, brief.id)).resultCount).toBe(4);
    const cancelled = await bridge.create(a, draft([]));
    await designs.cancelDesignBatch(a, cancelled.id);
    await expect(bridge.submit(a, cancelled.id, result())).rejects.toBeInstanceOf(ConflictException);
    expect((await bridge.get(a, cancelled.id)).resultCount).toBe(0);
  });

  it("gates progression on a complete review, pins only approved selections, and resumes one child under concurrent retries", async () => {
    const brief = await bridge.create(a, { ...draft([]), templateKey: "tire_cover" });
    const first = await bridge.submit(a, brief.id, result()), second = await bridge.submit(a, brief.id, result());
    const next = { versionIds: [first.versionId], prompt: "Refine the approved synthetic design" };
    await expect(bridge.continueWorkflow(a, brief.id, next)).rejects.toBeInstanceOf(ConflictException);
    await workflow.review(a, brief.id, { versionIds: [first.versionId], decision: "approve" });
    await expect(bridge.continueWorkflow(a, brief.id, next)).rejects.toBeInstanceOf(ConflictException);
    await workflow.review(a, brief.id, { versionIds: [second.versionId], decision: "reject", rejectionReason: "Synthetic wrong text" });
    const [left, right] = await Promise.all([bridge.continueWorkflow(a, brief.id, next), bridge.continueWorkflow(a, brief.id, next)]);
    expect(left.id).toBe(right.id); expect(left.workflow).toMatchObject({ rootBatchId: brief.id, parentBatchId: brief.id, stepIndex: 1, sourceVersionIds: [first.versionId] });
    expect(left.referenceAssets.map((asset) => asset.id)).toEqual([first.assetId]);
    expect((await bridge.get(a, brief.id)).nextBriefId).toBe(left.id);
    await expect(bridge.submit(a, brief.id, result())).rejects.toBeInstanceOf(ConflictException);
    await expect(bridge.continueWorkflow(a, brief.id, { ...next, versionIds: [second.versionId] })).rejects.toBeInstanceOf(ConflictException);
    await expect(bridge.continueWorkflow(b, brief.id, next)).rejects.toBeInstanceOf(NotFoundException);
    await expect(withTenant(database.db, a, (tx) => tx.update(creativeDesignBatches).set({ canvasWorkflow: null }).where(eq(creativeDesignBatches.id, brief.id)))).rejects.toThrow();
    expect((await workflow.results(a, brief.id)).items.map((entry) => entry.status)).toEqual(["approved", "rejected"]);
    expect((await sharp(await workflow.preview(a, brief.id, first.versionId)).metadata()).format).toBe("webp");
    await expect(workflow.preview(b, brief.id, first.versionId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(workflow.review({ ...a, permissions: [Permission.DesignRead, Permission.AssetRead] }, brief.id, { versionIds: [first.versionId], decision: "approve" })).rejects.toThrow();
  });

  it("does not review another brief's version or continue with rejected or missing selections", async () => {
    const brief = await bridge.create(a, { ...draft([]), templateKey: "original_pattern" });
    const other = await bridge.create(a, draft([]));
    const own = await bridge.submit(a, brief.id, result()), foreign = await bridge.submit(a, other.id, result());
    await expect(workflow.review(a, brief.id, { versionIds: [own.versionId, foreign.versionId], decision: "approve" })).rejects.toBeInstanceOf(NotFoundException);
    expect((await designs.getCreativeVersion(a, own.versionId)).status).toBe("pending_review");
    await workflow.review(a, brief.id, { versionIds: [own.versionId], decision: "reject", rejectionReason: "Synthetic rejection" });
    await expect(bridge.continueWorkflow(a, brief.id, { versionIds: [own.versionId], prompt: "Invalid" })).rejects.toBeInstanceOf(ConflictException);
    await expect(bridge.continueWorkflow(a, brief.id, { versionIds: [foreign.versionId], prompt: "Invalid" })).rejects.toBeInstanceOf(ConflictException);
    await expect(workflow.preview(a, brief.id, foreign.versionId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("copies approved artwork into an independent production draft once, preserving geometry and resetting confirmations", async () => {
    const document: ProductionEditorDocument = { schemaVersion: 1, name: "Synthetic circular template", productType: "tire_cover", spec: { diameterMm: 80, dpi: 150, safeInsetMm: 4, opening: { xMm: 40, yMm: 60, diameterMm: 5 } }, contour: [], layers: [], confirmations: { physicalSize: true, visualReview: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true } };
    const template = await production.create(a, { name: document.name, document });
    const brief = await bridge.create(a, draft([])), receipt = await bridge.submit(a, brief.id, result());
    const input = { versionId: receipt.versionId, templateProjectId: template.project.id, templateVersionId: template.version.id };
    await expect(workflow.handoff(a, brief.id, input)).rejects.toBeInstanceOf(ConflictException);
    await workflow.review(a, brief.id, { versionIds: [receipt.versionId], decision: "approve" });
    await expect(workflow.handoff(a, brief.id, input)).rejects.toBeInstanceOf(ConflictException);
    await production.review(a, template.project.id, template.version.id);
    expect((await workflow.templates(a)).items).toContainEqual({ projectId: template.project.id, versionId: template.version.id, versionNumber: 1, name: document.name, productType: "tire_cover" });
    const [first, retry] = await Promise.all([workflow.handoff(a, brief.id, input), workflow.handoff(a, brief.id, input)]);
    expect(first.projectId).toBe(retry.projectId); expect([first.replayed, retry.replayed].sort()).toEqual([false, true]);
    const created = await production.get(a, first.projectId);
    expect(created.version.document.spec).toEqual(document.spec);
    expect(created.version.document.layers).toHaveLength(1); expect(created.images).toHaveLength(1);
    expect(created.version.document.confirmations.physicalSize).toBe(false); expect(created.version.reviewed).toBe(false);
    expect((await production.get(a, template.project.id)).version.document.layers).toEqual([]);
    expect((await workflow.results(a, brief.id)).items[0].productionProjects[0].id).toBe(first.projectId);
    await expect(workflow.handoff(b, brief.id, input)).rejects.toBeInstanceOf(NotFoundException);
    expect(await withTenant(database.db, b, (tx) => tx.select().from(canvasProductionHandoffs))).toEqual([]);
    await expect(withTenant(database.db, a, (tx) => tx.update(canvasProductionHandoffs).set({ templateName: "changed" }))).rejects.toThrow();
    const second = await bridge.submit(a, brief.id, result());
    await workflow.review(a, brief.id, { versionIds: [second.versionId], decision: "approve" });
    const before = await withTenant(database.db, a, (tx) => tx.select().from(productionEditorProjects).where(eq(productionEditorProjects.status, "active")));
    scanner.scan.mockRejectedValueOnce(new Error("Synthetic scanner offline"));
    await expect(workflow.handoff(a, brief.id, { ...input, versionId: second.versionId })).rejects.toThrow();
    const after = await withTenant(database.db, a, (tx) => tx.select().from(productionEditorProjects).where(eq(productionEditorProjects.status, "active")));
    expect(after.length).toBe(before.length);
    expect((await workflow.handoff(a, brief.id, { ...input, versionId: second.versionId })).replayed).toBe(false);
  });
});
