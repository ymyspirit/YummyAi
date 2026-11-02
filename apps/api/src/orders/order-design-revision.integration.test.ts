import "reflect-metadata";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, CustomizationSchema, type ProductionEditorDocument, type TenantContext } from "@yummyai/contracts";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import type { OrderDesignReviseCandidate } from "@yummyai/contracts/order/design-agent";
import { createPillowPipeline, type DesignAutomationRecipe } from "@yummyai/contracts/pod/design-automation";
import {
  aiBudgetLedger, connectDatabase, marketplaceAccounts, memberships, membershipRoles,
  migrateDatabase, modelProviderConfigs, modelRoutes, orderDesignAgentCommands, orderDesignAgentOutbox,
  orderDesignAgentRuns as runs, orderDesignAgentSteps as steps, orderDesignModelCalls,
  orderLines, orders, orderSourceSnapshots, orderWorkAssets, orderWorkItems, orderWorkRevisions,
  productionEditorImages as images, productionEditorProjects as projects,
  productionEditorRenders as renders, productionEditorVersions as versions, productionOrders,
  roles, withTenant,
} from "@yummyai/database";
import {
  OrderDesignError, OrderDesignProcessor, OrderDesignRepository, OrderDesignRevisionService,
  PILLOW_REALESRGAN_POLICY, registerOrderDesignRun, assertOrderDesignCandidate,
  type OrderDesignImageGateway, type OrderDesignSnapshot, type OrderDesignSuperResolutionGateway,
} from "@yummyai/order-design";
import { decryptProductionBytes, encryptProductionBytes } from "@yummyai/production-editor";
import { buildDesignAutomationPlan } from "@yummyai/production-editor/design-automation";
import { assertAssetAccess, objectKey, type AssetDomain, type PutPrivateInput, type Storage, type StoredAsset } from "@yummyai/storage";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { purgeExpiredOrderDesignFeedback } from "../../../worker/src/processors/order-design-feedback-retention.js";
import { OrderDesignExecutor } from "../../../../packages/order-design/src/executor.js";
import { ProductionEditorRenderProcessor } from "../../../worker/src/processors/production-editor.processor.js";
import { JobEnvelopeSchema } from "@yummyai/jobs";
import { AuditService } from "../audit/audit.service.js";
import { ProductionEditorService } from "../design/production-editor.service.js";
import { AmazonOrderReportService } from "./amazon-order-report.service.js";
import { OrderService } from "./order.service.js";
import { OrderWorkspaceService } from "./order-workspace.service.js";

// Reject an ordinary database before opening any connection. The owning runner
// deletes its nonce DB/Redis/bucket in finally, including immutable test history.
requireDisposableIntegrationEnvironment();
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown) => hash(JSON.stringify(value));
const seal = (key: Uint8Array, value: unknown) => encryptProductionBytes(key, Buffer.from(JSON.stringify(value))).toString("base64");
const open = <T>(key: Uint8Array, value: string): T => JSON.parse(decryptProductionBytes(key, Buffer.from(value, "base64")).toString("utf8")) as T;
const usage = { version: "model-token-usage-v1" as const, inputTokens: 10, outputTokens: 4,
  cachedInputTokens: 0, totalTokens: 14, totalTokensBasis: "provider" as const };

describe("operator-requested Agent candidate revisions", () => {
  let database: ReturnType<typeof connectDatabase>;
  const vault = new SecretVault(Buffer.alloc(32, 117));
  const objects = new Map<string, Uint8Array>();
  const workKeys: Buffer[] = [];
  const executionFailures = new Map<string, Array<ReturnType<typeof safeFailure> & { step: string }>>();
  let restoreExecute: (() => void) | undefined;
  const scan = vi.fn(async () => ({ result: "clean" as const, engine: "synthetic-revision", signatureVersion: "fixture-v1", scannedAt: new Date().toISOString() }));
  let duringRead: (() => Promise<void>) | undefined;
  const storage = {
    putPrivate: async (context: TenantContext, input: PutPrivateInput) => {
      const checksumSha256 = hash(input.body);
      const key = objectKey({ tenantId: context.tenantId, domain: input.domain, sha256: checksumSha256, fileName: input.fileName });
      objects.set(key, Uint8Array.from(input.body));
      return { objectKey: key, checksumSha256, deduplicated: false };
    },
    readPrivate: async (context: TenantContext, asset: StoredAsset, options: { requiredDomain: AssetDomain }) => {
      assertAssetAccess(context, asset, options.requiredDomain);
      const bytes = objects.get(asset.objectKey);
      if (!bytes) throw new Error("Synthetic revision object missing");
      const result = Uint8Array.from(bytes);
      await duringRead?.();
      return result;
    },
    discardOrderDesignResponse: async (context: TenantContext, id: string, key: string) => {
      assertAssetAccess(context, { id, tenantId: context.tenantId, assetDomain: "order", objectKey: key }, "order");
      objects.delete(key);
    },
    discardOrderDesignFeedback: async (context: TenantContext, id: string, key: string, options: { assertCurrent: () => Promise<void> }) => {
      assertAssetAccess(context, { id, tenantId: context.tenantId, assetDomain: "order", objectKey: key }, "order");
      await options.assertCurrent();
      objects.delete(key);
    },
  } as unknown as Storage;
  const revisions = () => new OrderDesignRevisionService(database, vault, storage, { scan });
  const repository = () => new OrderDesignRepository(database, vault);

  beforeAll(async () => {
    const execute = OrderDesignExecutor.prototype.execute;
    const spy = vi.spyOn(OrderDesignExecutor.prototype, "execute").mockImplementation(async function (this: OrderDesignExecutor, job) {
      try { return await execute.call(this, job); }
      catch (error) {
        const previous = executionFailures.get(job.run.id) ?? [];
        previous.push({ step: job.step.key, ...safeFailure(error) });
        executionFailures.set(job.run.id, previous);
        throw error;
      }
    });
    restoreExecute = () => spy.mockRestore();
    database = connectDatabase(); await migrateDatabase(database);
  }, 90_000);
  afterAll(async () => {
    restoreExecute?.();
    duringRead = undefined;
    objects.clear();
    for (const key of workKeys) key.fill(0);
    await database?.client.end();
  });

  it("creates one image-edit child against the exact proof, keeps references outside production layers, and retains all prior evidence", async () => {
    const f = await candidate();
    const before = await state(f, f.runId);
    const screenshot = await image(96, "#cc5544");
    const input = await decision(f, { attachments: [{ name: "marked-edge.png", contentBase64: screenshot.toString("base64") }] });
    const result = await revisions().revise(f.context, f.lineId, input);
    expect(result.runId).not.toBe(f.runId);
    const queued = await state(f, result.runId);
    expect(queued.run).toMatchObject({ parentRunId: f.runId, status: "queued", projectId: before.project!.id,
      currentEditorVersionId: before.run.currentEditorVersionId, actualCostUsd: null });
    expect(queued.snapshot.revisionRequest).toMatchObject({ requestId: input.idempotencyKey, parentRunId: f.runId,
      baseProjectId: before.project!.id, baseVersionId: before.run.currentEditorVersionId,
      baseDocumentChecksum: before.versions.find(row => row.id === before.run.currentEditorVersionId)!.checksum,
      reason: input.reason, mode: "image_edit" });
    expect(queued.snapshot.draft).toEqual(f.snapshot.draft);
    expect(queued.snapshot.ruleSnapshot).toEqual(f.snapshot.ruleSnapshot);
    expect(queued.snapshot.recipe).toEqual(f.snapshot.recipe);
    const feedback = queued.snapshot.revisionRequest!.feedbackImages[0]!;
    expect(queued.assets.some(row => row.id === feedback.id)).toBe(false);
    expect(queued.snapshot.assets.some(row => row.assetId === feedback.id || row.key === feedback.id)).toBe(false);
    expect(queued.document!.layers.some(layer => layer.kind === "image" && layer.assetId === feedback.id)).toBe(false);
    expect((await revisions().attachment(f.context, f.lineId, result.runId, feedback.id)).bytes).toEqual(screenshot);

    await process(f, result.runId);
    const after = await state(f, result.runId);
    expect(after.run, safeState(after)).toMatchObject({ status: "awaiting_review", errorCode: null, actualCostUsd: "0.10000000" });
    expect(f.generate).toHaveBeenCalledTimes(3);
    expect(f.submitted[2]!.feedback).toEqual([screenshot]);
    expect(f.submitted[2]!.prompt).toContain(input.reason);
    expect(after.run.currentEditorVersionId).not.toBe(before.run.currentEditorVersionId);
    expect(after.project!.reviewedVersionId).toBeNull();
    expect(after.work).toMatchObject({ artwork: "in_progress", approvedEditorVersionId: null, proof: "pending", proofEditorVersionId: null });
    expect(after.document!.confirmations.visualReview).toBe(false);
    const targetIds = queued.snapshot.revisionRequest!.targetLayerIds;
    expectPreservedLayout(before.document!, after.document!, targetIds);
    expect(after.document!.layers.filter(layer => targetIds.includes(layer.id)).map(layer => layer.kind === "image" && layer.assetId))
      .not.toEqual(before.document!.layers.filter(layer => targetIds.includes(layer.id)).map(layer => layer.kind === "image" && layer.assetId));
    await expectOriginalPreserved(f, before);
    const view = await repository().view(f.context, f.lineId);
    expect(view.run!.revisionFeedback).toMatchObject({ requestId: input.idempotencyKey, parentRunId: f.runId });
    expect(view.usageSummary).toMatchObject({ callCount: 3, reportedCalls: 3, inputTokens: 30, outputTokens: 12, totalTokens: 42 });
    expect(JSON.stringify(view)).not.toContain("revision-feedback.pe");
    expect(JSON.stringify(view)).not.toContain("contentBase64");
    await process(f, f.runId);
    await process(f, result.runId);
    expect(f.generate).toHaveBeenCalledTimes(3);
  }, 60_000);

  it("changes only contour geometry without buying a model, replacing the subject bytes, or moving unrelated layers", async () => {
    const f = await candidate();
    const before = await state(f, f.runId);
    const input = await decision(f, { mode: "contour_only", contourRoundingPx: 30 });
    const result = await revisions().revise(f.context, f.lineId, input);
    await process(f, result.runId);
    const after = await state(f, result.runId);
    expect(after.run, safeState(after)).toMatchObject({ status: "awaiting_review", actualCostUsd: "0.00000000", costStatus: "not_required" });
    expect(after.steps.map(step => step.key)).toEqual(["reuse_revision_subject", "optimize_contour", "preflight", "render_proof", "review_required"]);
    expect(after.calls).toHaveLength(0);
    expect(f.generate).toHaveBeenCalledTimes(2);
    const targetIds = after.snapshot.revisionRequest!.targetLayerIds;
    expectPreservedLayout(before.document!, after.document!, targetIds);
    for (const layer of before.document!.layers.filter(row => targetIds.includes(row.id))) {
      const updated = after.document!.layers.find(row => row.id === layer.id)!;
      expect(withoutPosition(updated)).toEqual(withoutPosition(layer));
    }
    const contourStep = after.steps.find(step => step.key === "optimize_contour")!;
    expect(open<Record<string, unknown>>(f.workKey, contourStep.encryptedOutput!)).toMatchObject({
      artworkUnchanged: true, roundingPx: 30, revisionRequestId: input.idempotencyKey,
    });
    expect(after.run.currentEditorVersionId).not.toBe(before.run.currentEditorVersionId);
    expect(after.snapshot.revisionRequest).toMatchObject({ mode: "contour_only", contourRoundingPx: 30 });
    const target = after.snapshot.revisionRequest!.targetImageId;
    expect(after.assets.find(row => row.id === target)).toEqual(before.assets.find(row => row.id === target));
    expect(after.document!.confirmations.visualReview).toBe(false);
    expect(after.work.approvedEditorVersionId).toBeNull();
    await expectOriginalPreserved(f, before);
  }, 60_000);

  it("serializes repeated and competing decisions to one child, rejects changed intent and compensates losing screenshot objects", async () => {
    const f = await candidate();
    const screenshot = await image(64, "#667788");
    const input = await decision(f, { attachments: [{ name: "reference.png", contentBase64: screenshot.toString("base64") }] });
    const [first, second] = await Promise.all([revisions().revise(f.context, f.lineId, input), revisions().revise(f.context, f.lineId, input)]);
    expect(second).toEqual(first);
    expect(await revisions().revise(f.context, f.lineId, input)).toEqual(first);
    await expect(revisions().revise(f.context, f.lineId, { ...input, reason: "A different operator instruction" })).rejects.toMatchObject({ code: "agent_command_conflict" });
    await expect(revisions().revise(f.context, f.lineId, { ...input, attachments: [{ ...input.attachments[0]!, contentBase64: (await image(64, "#998877")).toString("base64") }] }))
      .rejects.toMatchObject({ code: "agent_command_conflict" });
    await expect(revisions().revise(f.context, f.lineId, { ...input, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(OrderDesignError);
    const children = await withTenant(database.db, f.context, tx => tx.select().from(runs).where(eq(runs.parentRunId, f.runId)));
    expect(children.map(row => row.id)).toEqual([first.runId]);
    const rows = await state(f, first.runId);
    const feedback = rows.snapshot.revisionRequest!.feedbackImages;
    expect([...objects.keys()].filter(key => key.startsWith(`tenants/${f.context.tenantId}/`) && key.endsWith("-revision-feedback.pe")))
      .toEqual(feedback.map(pin => pin.objectKey));
    expect(await withTenant(database.db, f.context, tx => tx.select().from(orderDesignAgentCommands).where(eq(orderDesignAgentCommands.runId, f.runId))))
      .toHaveLength(1);
    expect(await withTenant(database.db, f.context, tx => tx.select().from(orderDesignAgentOutbox).where(eq(orderDesignAgentOutbox.runId, first.runId))))
      .toHaveLength(1);
    expect(f.generate).toHaveBeenCalledTimes(2);
  }, 60_000);

  it("refuses stale candidates, held or expired orders, approved artwork and missing current review authority before a new call", async () => {
    const f = await candidate();
    const input = await decision(f);
    const before = await state(f, f.runId);
    for (const patch of [{ expectedRevision: input.expectedRevision + 1 }, { expectedEditorVersionId: createEntityId() }]) {
      await expect(revisions().revise(f.context, f.lineId, { ...input, ...patch })).rejects.toBeInstanceOf(OrderDesignError);
    }
    for (const permission of [Permission.OrderPiiRead, Permission.DesignReview, Permission.DesignWrite]) {
      await expect(revisions().revise({ ...f.context, permissions: f.context.permissions.filter(value => value !== permission) }, f.lineId, input)).rejects.toThrow();
    }
    await withTenant(database.db, f.context, tx => tx.update(roles).set({ permissions: f.context.permissions.filter(value => value !== Permission.DesignReview) }).where(eq(roles.id, f.roleId)));
    try { await expect(revisions().revise(f.context, f.lineId, input)).rejects.toThrow(); }
    finally { await withTenant(database.db, f.context, tx => tx.update(roles).set({ permissions: f.context.permissions }).where(eq(roles.id, f.roleId))); }
    await withTenant(database.db, f.context, tx => tx.update(orderWorkItems).set({ held: true }).where(eq(orderWorkItems.id, f.lineId)));
    try { await expect(revisions().revise(f.context, f.lineId, input)).rejects.toMatchObject({ code: "agent_order_unavailable" }); }
    finally { await withTenant(database.db, f.context, tx => tx.update(orderWorkItems).set({ held: false }).where(eq(orderWorkItems.id, f.lineId))); }
    await withTenant(database.db, f.context, tx => tx.update(orderWorkItems).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(orderWorkItems.id, f.lineId)));
    try { await expect(revisions().revise(f.context, f.lineId, input)).rejects.toMatchObject({ code: "agent_source_expired" }); }
    finally { await withTenant(database.db, f.context, tx => tx.update(orderWorkItems).set({ expiresAt: before.work.expiresAt }).where(eq(orderWorkItems.id, f.lineId))); }
    // Explicit synthetic state admission only. This does not claim an operator
    // approval or factory release; those retain their full native owner gates.
    await withTenant(database.db, f.context, tx => tx.update(orderWorkItems).set({ artwork: "approved",
      approvedEditorVersionId: before.run.currentEditorVersionId }).where(eq(orderWorkItems.id, f.lineId)));
    await expect(revisions().revise(f.context, f.lineId, input)).rejects.toMatchObject({ code: "agent_work_changed" });
    expect(await withTenant(database.db, f.context, tx => tx.select().from(runs).where(eq(runs.parentRunId, f.runId)))).toEqual([]);
    expect(await withTenant(database.db, f.context, tx => tx.select().from(productionOrders).where(eq(productionOrders.sourceWorkItemId, f.lineId)))).toEqual([]);
    expect(f.generate).toHaveBeenCalledTimes(2);
    await expectOriginalPreserved(f, before);
  }, 60_000);

  it("keeps screenshots tenant-private, rejects corrupt or unsafe images and revocation during private reading", async () => {
    const f = await candidate();
    const input = await decision(f);
    const keysBefore = [...objects.keys()].filter(key => key.startsWith(`tenants/${f.context.tenantId}/`));
    await expect(revisions().revise(f.context, f.lineId, { ...input, attachments: [{ name: "bad.png", contentBase64: Buffer.from("not an image").toString("base64") }] }))
      .rejects.toMatchObject({ code: "agent_revision_attachment_invalid" });
    const screenshot = await image(64, "#334455");
    const infected = new OrderDesignRevisionService(database, vault, storage, { scan: async () => ({ result: "infected", engine: "synthetic", signatureVersion: "fixture", scannedAt: new Date().toISOString() }) });
    await expect(infected.revise(f.context, f.lineId, { ...input, attachments: [{ name: "infected.png", contentBase64: screenshot.toString("base64") }] }))
      .rejects.toMatchObject({ code: "agent_scan_rejected" });
    expect([...objects.keys()].filter(key => key.startsWith(`tenants/${f.context.tenantId}/`))).toEqual(keysBefore);
    const child = await revisions().revise(f.context, f.lineId, { ...input, attachments: [{ name: "safe.png", contentBase64: screenshot.toString("base64") }] });
    const childState = await state(f, child.runId);
    const feedbackId = childState.snapshot.revisionRequest!.feedbackImages[0]!.id;
    const outsider = await actor();
    await expect(revisions().attachment(outsider.context, f.lineId, child.runId, feedbackId)).rejects.toBeInstanceOf(OrderDesignError);
    expect(await withTenant(database.db, outsider.context, tx => tx.select().from(runs).where(eq(runs.id, child.runId)))).toEqual([]);
    const [identity] = await withTenant(database.db, f.context, tx => tx.execute<{ role: string }>(sql`select current_user as role`));
    expect(identity!.role).toBe("yummyai_app");
    duringRead = async () => {
      duringRead = undefined;
      await withTenant(database.db, f.context, tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, f.membershipId)));
    };
    try { await expect(revisions().attachment(f.context, f.lineId, child.runId, feedbackId)).rejects.toThrow(); }
    finally {
      duringRead = undefined;
      await withTenant(database.db, f.context, tx => tx.update(memberships).set({ status: "active" }).where(eq(memberships.id, f.membershipId)));
    }
    expect((await revisions().attachment(f.context, f.lineId, child.runId, feedbackId)).bytes).toEqual(screenshot);
    expect(f.generate).toHaveBeenCalledTimes(2);
  }, 60_000);

  it("stops an uncertain revision without repurchasing and preserves the original paid history", async () => {
    const f = await candidate();
    const before = await state(f, f.runId);
    const child = await revisions().revise(f.context, f.lineId, await decision(f));
    f.generate.mockImplementationOnce(async () => { throw new OrderDesignError("agent_model_transport_lost", true); });
    await process(f, child.runId);
    const after = await state(f, child.runId);
    expect(after.run.status).toBe("needs_attention");
    expect(after.steps.find(step => step.key === "revise_image")!.status).toBe("uncertain");
    expect(after.run.actualCostUsd).toBeNull();
    expect(after.run.costStatus).toBe("unknown");
    expect(after.calls).toHaveLength(1);
    expect(after.calls[0]!.reportedCostUsd).toBeNull();
    const view = await repository().view(f.context, f.lineId);
    expect(view.run!.canResume).toBe(false);
    await expect(repository().command(f.context, f.lineId, "resume", { runId: child.runId, expectedRevision: after.run.revision, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: "agent_resume_not_safe" });
    await process(f, child.runId);
    expect(f.generate).toHaveBeenCalledTimes(3);
    await expectOriginalPreserved(f, before);
  }, 60_000);

  it("retains explicit human takeover after an AI revision and never lets a late task overwrite that choice", async () => {
    const f = await candidate();
    const child = await revisions().revise(f.context, f.lineId, await decision(f, { mode: "contour_only", contourRoundingPx: 25 }));
    await process(f, child.runId);
    const candidateState = await state(f, child.runId);
    expect(candidateState.run, safeState(candidateState)).toMatchObject({ status: "awaiting_review" });
    const { editor, workspace } = editorServices();
    const detail = await workspace.detail(f.context, f.lineId);
    const originalVersion = (await state(f, f.runId)).run.currentEditorVersionId;
    await expect(workspace.action(f.context, f.lineId, { action: "approve_artwork", expectedRevision: detail.line.revision,
      expectedProjectionVersion: detail.line.projectionVersion, expectedEditorVersionId: originalVersion,
      reason: "Synthetic stale original cannot approve the replacement", idempotencyKey: randomUUID() })).rejects.toThrow("版本已变化");
    const rejected = await workspace.action(f.context, f.lineId, { action: "reject_artwork", expectedRevision: detail.line.revision,
      expectedProjectionVersion: detail.line.projectionVersion, expectedEditorVersionId: candidateState.run.currentEditorVersionId,
      reason: "Synthetic operator chooses a human correction after the AI revision", idempotencyKey: randomUUID() });
    expect(rejected.line).toMatchObject({ artwork: "changes_requested", designExecutor: "human", designCandidateReview: false });
    const stopped = await state(f, child.runId);
    expect(stopped.run).toMatchObject({ status: "cancelled", errorCode: "agent_manual_takeover" });
    await process(f, child.runId);
    expect(f.generate).toHaveBeenCalledTimes(2);
    const current = await editor.get(f.context, stopped.project!.id);
    const saved = await editor.save(f.context, current.project.id, { expectedVersionId: current.version.id,
      document: { ...current.version.document, name: "Synthetic human correction after AI revision", confirmations: { ...current.version.document.confirmations, visualReview: false } } });
    expect(saved.version.id).not.toBe(current.version.id);
    expect((await state(f, child.runId)).run.currentEditorVersionId).toBe(candidateState.run.currentEditorVersionId);
    expect((await editor.get(f.context, current.project.id)).version.id).toBe(saved.version.id);
    await process(f, child.runId);
    expect((await editor.get(f.context, current.project.id)).version.id).toBe(saved.version.id);
    expect(f.generate).toHaveBeenCalledTimes(2);
  }, 60_000);

  it("rechecks review authority before charging a queued child and retains a late receipt without adopting its image", async () => {
    const queuedFixture = await candidate();
    const queuedChild = await revisions().revise(queuedFixture.context, queuedFixture.lineId, await decision(queuedFixture));
    await withTenant(database.db, queuedFixture.context, tx => tx.update(roles).set({ permissions: queuedFixture.context.permissions.filter(value => value !== Permission.DesignReview) }).where(eq(roles.id, queuedFixture.roleId)));
    try {
      await process(queuedFixture, queuedChild.runId);
      const blocked = await state(queuedFixture, queuedChild.runId);
      expect(blocked.run).toMatchObject({ status: "needs_attention", errorCode: "agent_membership_unavailable" });
      expect(blocked.calls).toEqual([]);
      expect(queuedFixture.generate).toHaveBeenCalledTimes(2);
    } finally {
      await withTenant(database.db, queuedFixture.context, tx => tx.update(roles).set({ permissions: queuedFixture.context.permissions }).where(eq(roles.id, queuedFixture.roleId)));
    }

    const lateFixture = await candidate();
    const before = await state(lateFixture, lateFixture.runId);
    const lateChild = await revisions().revise(lateFixture.context, lateFixture.lineId, await decision(lateFixture));
    lateFixture.generate.mockImplementationOnce(async () => {
      await withTenant(database.db, lateFixture.context, tx => tx.update(roles).set({ permissions: lateFixture.context.permissions.filter(value => value !== Permission.DesignReview) }).where(eq(roles.id, lateFixture.roleId)));
      return { bytes: await subject(512, "#337755"), actualCostUsd: .37, tokenUsage: usage };
    });
    try {
      await process(lateFixture, lateChild.runId);
      const blocked = await state(lateFixture, lateChild.runId);
      expect(blocked.run).toMatchObject({ status: "needs_attention", errorCode: "agent_membership_unavailable", actualCostUsd: "0.37000000", costStatus: "reported" });
      expect(blocked.calls).toHaveLength(1);
      expect(blocked.calls[0]).toMatchObject({ costReportState: "reported", reportedCostUsd: "0.37000000", tokenUsage: usage });
      expect(blocked.calls[0]!.receivedAt).not.toBeNull();
      expect(blocked.project!.currentVersionId).toBe(before.project!.currentVersionId);
      expect(blocked.versions).toEqual(before.versions);
      expect(blocked.work.approvedEditorVersionId).toBeNull();
      expect(lateFixture.generate).toHaveBeenCalledTimes(3);
    } finally {
      await withTenant(database.db, lateFixture.context, tx => tx.update(roles).set({ permissions: lateFixture.context.permissions }).where(eq(roles.id, lateFixture.roleId)));
    }
    await expectOriginalPreserved(lateFixture, before);
  }, 90_000);

  it("retains live feedback, deletes only its expired objects, and preserves retry locators when storage cleanup fails", async () => {
    const f = await candidate();
    const screenshot = await image(64, "#778899");
    const child = await revisions().revise(f.context, f.lineId, await decision(f, {
      attachments: [{ name: "retention-reference.png", contentBase64: screenshot.toString("base64") }],
    }));
    const saved = await state(f, child.runId);
    const feedback = saved.snapshot.revisionRequest!.feedbackImages[0]!;
    const before = new Map([...objects.entries()].filter(([key]) => key.startsWith(`tenants/${f.context.tenantId}/`)).map(([key, bytes]) => [key, hash(bytes)]));
    const purge = vi.fn(async (input: { tenantId: string; attachmentId: string; objectKey: string }, options: { assertExpired: () => Promise<void> }) => {
      expect(input).toEqual({ tenantId: f.context.tenantId, attachmentId: feedback.id, objectKey: feedback.objectKey });
      await options.assertExpired();
      objects.delete(input.objectKey);
    });
    expect(await purgeExpiredOrderDesignFeedback(database, f.context, { purgeExpiredOrderDesignFeedback: purge })).toEqual({ purgedRuns: 0 });
    expect(purge).not.toHaveBeenCalled();
    expect((await revisions().attachment(f.context, f.lineId, child.runId, feedback.id)).bytes).toEqual(screenshot);
    await withTenant(database.db, f.context, tx => tx.update(orderWorkItems).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(orderWorkItems.id, f.lineId)));
    const failPurge = vi.fn(async () => { throw new Error("Synthetic feedback storage unavailable"); });
    await expect(purgeExpiredOrderDesignFeedback(database, f.context, { purgeExpiredOrderDesignFeedback: failPurge })).rejects.toThrow("Synthetic feedback storage unavailable");
    const [failed] = await withTenant(database.db, f.context, tx => tx.select().from(runs).where(eq(runs.id, child.runId)));
    expect(failed!.revisionFeedbackObjects).toEqual([{ id: feedback.id, objectKey: feedback.objectKey }]);
    expect(failed!.revisionFeedbackPurgedAt).toBeNull();
    expect(objects.has(feedback.objectKey)).toBe(true);
    await expect(revisions().attachment(f.context, f.lineId, child.runId, feedback.id)).rejects.toMatchObject({ code: "agent_revision_feedback_not_found" });
    const cutoff = new Date();
    expect(await purgeExpiredOrderDesignFeedback(database, f.context, { purgeExpiredOrderDesignFeedback: purge }, cutoff)).toEqual({ purgedRuns: 1 });
    const [purged] = await withTenant(database.db, f.context, tx => tx.select().from(runs).where(eq(runs.id, child.runId)));
    expect(purged!.revisionFeedbackPurgedAt).toEqual(cutoff);
    expect(purged!.revisionFeedbackObjects).toEqual(failed!.revisionFeedbackObjects);
    expect(objects.has(feedback.objectKey)).toBe(false);
    for (const [key, checksum] of before) {
      if (key !== feedback.objectKey) expect(hash(objects.get(key)!)).toBe(checksum);
    }
    expect(await purgeExpiredOrderDesignFeedback(database, f.context, { purgeExpiredOrderDesignFeedback: purge })).toEqual({ purgedRuns: 0 });
    expect(purge).toHaveBeenCalledTimes(1);
    expect(f.generate).toHaveBeenCalledTimes(2);
  }, 60_000);

  it("revises only an explicitly submitted current successor while preserving the original Agent completion and rejecting stale or forged authority", async () => {
    const f = await candidate();
    const original = await state(f, f.runId);
    const audit = new AuditService(database);
    const refuseExternal = vi.fn(async () => { throw new Error("Synthetic successor must not call an external service"); });
    const order = new OrderService(database, vault, audit);
    const reports = new AmazonOrderReportService(database, vault, order, audit,
      { download: refuseExternal, scan }, { schedule: refuseExternal }, { schedule: refuseExternal });
    const enqueue = vi.fn(async () => undefined);
    const editor = new ProductionEditorService(database, vault, storage, reports, audit, { enqueue }, { scan });
    const workspace = new OrderWorkspaceService(database, vault, storage, reports, editor, { scan });
    const previous = await editor.get(f.context, original.project!.id);
    const successor = await editor.save(f.context, previous.project.id, { expectedVersionId: previous.version.id,
      document: { ...previous.version.document, name: "Synthetic explicitly submitted successor", confirmations: {
        physicalSize: true, visualReview: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true,
      } } });
    expect(successor.version.id).not.toBe(original.run.currentEditorVersionId);
    expect(successor.version.versionNumber).toBe(previous.version.versionNumber + 1);
    const preflight = await editor.preflight(f.context, successor.project.id, { expectedVersionId: successor.version.id,
      purpose: "production", format: "jpeg", background: "white" });
    expect(preflight.productionReady, JSON.stringify(preflight.issues.map(issue => ({ code: issue.code, severity: issue.severity })))).toBe(true);

    // Produce a genuine private preview through the existing render owner. The
    // fixture invokes the processor directly; no ordinary Worker is started.
    const preview = await editor.render(f.context, successor.project.id, { expectedVersionId: successor.version.id,
      purpose: "preview", format: "jpeg", background: "white", previewFullResolution: true });
    expect(preview.status).toBe("queued");
    const renderer = new ProductionEditorRenderProcessor(database, storage, vault, vault, { generate: refuseExternal }, { scan });
    await renderer.process(JobEnvelopeSchema.parse({ jobId: preview.id, type: "production_editor_render", tenantId: f.context.tenantId,
      requestedBy: f.context.userId, correlationId: preview.id, idempotencyKey: preview.id, payload: { renderId: preview.id } }));
    const completedPreview = await editor.getRender(f.context, successor.project.id, preview.id);
    expect(completedPreview.status).toBe("completed");
    expect(completedPreview.files.length).toBeGreaterThan(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(refuseExternal).not.toHaveBeenCalled();

    const input = await decision(f, { expectedEditorVersionId: successor.version.id });
    expect((await repository().view(f.context, f.lineId)).run!.canRevise).toBe(false);
    await expect(revisions().revise(f.context, f.lineId, input)).rejects.toMatchObject({ code: "agent_revision_successor_not_submitted" });
    let detail = await workspace.detail(f.context, f.lineId);
    detail = await workspace.action(f.context, f.lineId, { action: "submit_artwork", expectedRevision: detail.line.revision,
      expectedProjectionVersion: detail.line.projectionVersion, expectedEditorVersionId: successor.version.id,
      reason: "Synthetic operator explicitly submits this successor for review", idempotencyKey: randomUUID() });
    expect(detail.line.artwork).toBe("in_review");
    const submitted = await state(f, f.runId);
    expect(submitted.work.approvedEditorVersionId).toBeNull();
    expect(submitted.project!.reviewedVersionId).toBeNull();
    const view = await repository().view(f.context, f.lineId);
    expect(view.run).toMatchObject({ id: f.runId, currentEditorVersionId: original.run.currentEditorVersionId,
      canRevise: true, revisionBaseVersionId: successor.version.id, revisionSource: "submitted_successor" });
    expect(view.run!.completion).toEqual({ evidence: original.run.completionEvidence, checksum: original.run.completionChecksum });

    // The original approval helper remains exact. A submitted successor gains
    // only revision admission, never the old Agent candidate's approval proof.
    await expect(withTenant(database.db, f.context, tx => assertOrderDesignCandidate(tx, f.context, submitted.run, vault, successor.version.id)))
      .rejects.toMatchObject({ code: "agent_editor_changed" });
    await expect(revisions().revise(f.context, f.lineId, { ...input, expectedEditorVersionId: original.run.currentEditorVersionId }))
      .rejects.toBeInstanceOf(OrderDesignError);
    for (const patch of [{ source: "submitted_successor" }, { baseProjectId: createEntityId() }]) {
      await expect(revisions().revise(f.context, f.lineId, { ...input, ...patch })).rejects.toThrow();
    }
    await withTenant(database.db, f.context, tx => tx.update(orderWorkItems).set({ approvedEditorVersionId: original.run.currentEditorVersionId }).where(eq(orderWorkItems.id, f.lineId)));
    try { await expect(revisions().revise(f.context, f.lineId, input)).rejects.toBeInstanceOf(OrderDesignError); }
    finally { await withTenant(database.db, f.context, tx => tx.update(orderWorkItems).set({ approvedEditorVersionId: null }).where(eq(orderWorkItems.id, f.lineId))); }
    await withTenant(database.db, f.context, tx => tx.update(projects).set({ reviewedVersionId: original.run.currentEditorVersionId,
      reviewedBy: f.context.userId, reviewedAt: new Date() }).where(eq(projects.id, successor.project.id)));
    try { await expect(revisions().revise(f.context, f.lineId, input)).rejects.toBeInstanceOf(OrderDesignError); }
    finally { await withTenant(database.db, f.context, tx => tx.update(projects).set({ reviewedVersionId: null, reviewedBy: null, reviewedAt: null }).where(eq(projects.id, successor.project.id))); }

    // A FK-valid competing work revision simulates a changed dispatch source.
    // Its immutable row is retained; no historical revision is overwritten.
    const competingRevisionId = createEntityId();
    await withTenant(database.db, f.context, async tx => {
      await tx.insert(orderWorkRevisions).values({ id: competingRevisionId, tenantId: f.context.tenantId, workItemId: f.lineId,
        revision: 2, encryptedDraft: seal(f.workKey, f.snapshot.draft), checksum: digest(f.snapshot.draft), createdBy: f.context.userId });
      await tx.update(orderWorkItems).set({ pushedRevisionId: competingRevisionId }).where(eq(orderWorkItems.id, f.lineId));
    });
    try { await expect(revisions().revise(f.context, f.lineId, input)).rejects.toBeInstanceOf(OrderDesignError); }
    finally { await withTenant(database.db, f.context, tx => tx.update(orderWorkItems).set({ pushedRevisionId: f.snapshot.workRevisionId }).where(eq(orderWorkItems.id, f.lineId))); }
    expect(await withTenant(database.db, f.context, tx => tx.select().from(runs).where(eq(runs.parentRunId, f.runId)))).toEqual([]);
    expect(f.generate).toHaveBeenCalledTimes(2);
    await expectOriginalPreserved(f, original);

    const result = await revisions().revise(f.context, f.lineId, input);
    const queued = await state(f, result.runId);
    const baseVersion = submitted.versions.find(version => version.id === successor.version.id)!;
    expect(queued.run).toMatchObject({ parentRunId: f.runId, projectId: successor.project.id, currentEditorVersionId: successor.version.id, status: "queued" });
    expect(queued.snapshot.revisionRequest).toMatchObject({ source: "submitted_successor", parentRunId: f.runId,
      baseVersionId: successor.version.id, baseDocumentChecksum: baseVersion.checksum });
    expect(queued.snapshot.document.name).toBe("Synthetic explicitly submitted successor");
    await process(f, result.runId);
    const revised = await state(f, result.runId);
    expect(revised.run, safeState(revised)).toMatchObject({ status: "awaiting_review", actualCostUsd: "0.10000000" });
    expect(revised.run.currentEditorVersionId).not.toBe(successor.version.id);
    expect(revised.run.currentEditorVersionId).not.toBe(original.run.currentEditorVersionId);
    expect(revised.work.approvedEditorVersionId).toBeNull();
    expect(revised.project!.reviewedVersionId).toBeNull();
    expect(revised.document!.confirmations.visualReview).toBe(false);
    expect(revised.versions.find(version => version.id === successor.version.id)).toEqual(baseVersion);
    expect((await state(f, f.runId)).run.currentEditorVersionId).toBe(original.run.currentEditorVersionId);
    await expectOriginalPreserved(f, original);
    expect(f.generate).toHaveBeenCalledTimes(3);
    expect(refuseExternal).not.toHaveBeenCalled();
  }, 120_000);

  async function actor() {
    const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant" };
    const membershipId = createEntityId(), roleId = createEntityId(), accountId = createEntityId();
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic revision',$2)", [context.tenantId, randomUUID()]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic reviewer')", [context.userId, randomUUID(), `${context.userId}@example.invalid`]);
    await withTenant(database.db, context, async tx => {
      await tx.insert(memberships).values({ id: membershipId, tenantId: context.tenantId, userId: context.userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId: context.tenantId, name: randomUUID(), permissions: context.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: context.tenantId, membershipId, roleId });
      await tx.insert(marketplaceAccounts).values({ id: accountId, tenantId: context.tenantId, platform: "amazon", displayName: "Synthetic revision shop", region: "NA", authorizationMode: "amazon_private", createdBy: context.userId });
    });
    return { context, membershipId, roleId, accountId };
  }

  async function candidate() {
    const owner = await actor();
    const { context, accountId } = owner;
    const lineId = createEntityId(), workRevisionId = createEntityId(), orderId = createEntityId(), sourceSnapshotId = createEntityId();
    const templateProjectId = createEntityId(), templateVersionId = createEntityId(), routeId = createEntityId(), providerId = createEntityId();
    const workKey = randomBytes(32); workKeys.push(workKey);
    const sourceId = createEntityId(), sourcePinId = createEntityId(), referenceId = createEntityId(), referencePinId = createEntityId();
    const recipe: DesignAutomationRecipe = { schemaVersion: 1, workflow: "pillow_photo", imagePolicy: "faithful_enhancement", modelRouteId: routeId,
      allowOrderImageTransfer: true, modelCallLimit: 4, estimatedCostPerCallUsd: null, maxEstimatedCostUsd: null, costPolicy: "unlimited",
      pillowPipeline: createPillowPipeline({ ...PILLOW_REALESRGAN_POLICY }) };
    const customization = CustomizationSchema.parse({ version: 1, fields: [
      { key: "buyer_photo", label: "Original customer image", type: "image", required: true, validation: { allowedMediaTypes: ["image/png"], maxFiles: 1, maxBytes: 1_000_000 } },
    ] });
    const draft = OrderWorkDraftSchema.parse({ printProfileVersionId: null, designExecutor: "agent", fields: [],
      images: [{ origin: "upload", key: sourceId, usage: "buyer_photo" }], instructions: "", customerApprovalRequired: true, dueAt: null });
    const document: ProductionEditorDocument = {
      schemaVersion: 1, name: "Synthetic versioned pillow", productType: "shaped_pillow", automation: recipe, exportBackground: "white",
      spec: { widthMm: 110, heightMm: 110, dpi: 150, sideMode: "single", factoryStandardId: "ps-pillow-2026-09-17",
        declaredLongestMm: 254, sizeBasis: "artwork", whiteBorderMm: 200 * 25.4 / 150, cutLineMm: 1.016,
        minimumNeckMm: 50, minimumNeckBasis: "cut_contour", panelGapMm: 100 * 25.4 / 150, sheetMarginMm: 50 * 25.4 / 150,
        barcodeTab: { widthMm: 600 * 25.4 / 150, heightMm: 200 * 25.4 / 150, centerXMm: 55 } },
      contour: [{ xMm: 0, yMm: 0, smooth: false }, { xMm: 110, yMm: 0, smooth: false }, { xMm: 110, yMm: 110, smooth: false }, { xMm: 0, yMm: 110, smooth: false }],
      layers: [{ id: "fixed_reference", name: "Immutable hidden reference", kind: "image", assetId: referencePinId,
        assetVersion: 1, xMm: 0, yMm: 0, widthMm: 10, heightMm: 10, rotationDeg: 0, opacity: 1, visible: false, locked: true, flipX: false, flipY: false }],
      confirmations: { physicalSize: true, visualReview: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true },
    };
    const source = await image(512, "#4477aa"), reference = await image(64, "#999999");
    const snapshot: OrderDesignSnapshot = {
      schemaVersion: 1, workItemId: lineId, workRevisionId, sourceVersionId: null,
      templateProjectId, templateVersionId, templateChecksum: digest(document), document,
      assets: [{ key: sourcePinId, origin: "work", kind: "image", assetId: sourceId, name: "Synthetic buyer original", usage: "buyer_photo", checksum: hash(source), buyerOriginal: true },
        { key: referencePinId, origin: "work", kind: "image", assetId: referenceId, name: "Synthetic hidden reference", checksum: hash(reference) }],
      templateAssetKeys: {}, masterAssetKey: null,
      layout: [{ fieldKey: "buyer_photo", xPercent: 10, yPercent: 10, widthPercent: 80, heightPercent: 80, color: "#000000" }],
      customization, draft, photoOnlyPillow: false, recipe,
      plan: buildDesignAutomationPlan({ recipe, imageIds: [sourcePinId], pillowSubject: "head", configuredModel: "gpt-image-2.5", pillowRuntime: { ...PILLOW_REALESRGAN_POLICY } }),
      model: { routeId, providerConfigId: providerId, model: "gpt-image-2.5", endpoint: "https://synthetic.invalid/v1" },
    };
    await withTenant(database.db, context, async tx => {
      await tx.insert(orderSourceSnapshots).values({ id: sourceSnapshotId, tenantId: context.tenantId, accountId, platform: "amazon", externalEventId: randomUUID(), externalOrderId: `REVISION-${orderId}`, normalizedOrderId: orderId, redactedPayload: { synthetic: true }, payloadChecksum: "a".repeat(64) });
      await tx.insert(orders).values({ id: orderId, tenantId: context.tenantId, accountId, sourceSnapshotId, platform: "amazon", externalOrderId: `REVISION-${orderId}`, providerStatus: "paid", workflowState: "awaiting_shipment", orderTotalMinor: 2000, orderCurrency: "USD", lineCount: 1, addressStatus: "protected", addressCountryCode: "US", latestEventSequence: 1, placedAt: new Date() });
      await tx.insert(orderLines).values({ id: lineId, tenantId: context.tenantId, orderId, externalLineId: `LINE-${lineId}`, title: "Synthetic candidate revision", quantity: 1, unitPriceMinor: 2000, unitPriceCurrency: "USD" });
      await tx.insert(orderWorkItems).values({ id: lineId, tenantId: context.tenantId, encryptedDataKey: vault.encrypt(workKey.toString("base64")), revision: 1, preparation: "pushed", artwork: "queued", proof: "pending", expiresAt: new Date(Date.now() + 86400_000) });
      await tx.insert(orderWorkRevisions).values({ id: workRevisionId, tenantId: context.tenantId, workItemId: lineId, revision: 1, encryptedDraft: seal(workKey, draft), checksum: digest(draft), createdBy: context.userId });
      await tx.update(orderWorkItems).set({ pushedRevisionId: workRevisionId }).where(eq(orderWorkItems.id, lineId));
      await tx.insert(projects).values({ id: templateProjectId, tenantId: context.tenantId, name: document.name, encryptedDataKey: vault.encrypt(workKey.toString("base64")), createdBy: context.userId });
      await tx.insert(versions).values({ id: templateVersionId, tenantId: context.tenantId, projectId: templateProjectId, versionNumber: 1, encryptedDocument: seal(workKey, document), checksum: digest(document), createdBy: context.userId });
      await tx.update(projects).set({ currentVersionId: templateVersionId, reviewedVersionId: templateVersionId, reviewedBy: context.userId, reviewedAt: new Date() }).where(eq(projects.id, templateProjectId));
      for (const item of [{ id: sourceId, bytes: source }, { id: referenceId, bytes: reference }]) {
        const body = encryptProductionBytes(workKey, item.bytes), key = objectKey({ tenantId: context.tenantId, domain: "order", sha256: hash(body), fileName: `${item.id}.pe` });
        objects.set(key, Uint8Array.from(body));
        await tx.insert(orderWorkAssets).values({ id: item.id, tenantId: context.tenantId, workItemId: lineId, objectKey: key, previewObjectKey: key, checksum: hash(item.bytes), encryptedMetadata: seal(workKey, { name: "Synthetic source", kind: "image", mediaType: "image/png", width: item.id === sourceId ? 512 : 64, height: item.id === sourceId ? 512 : 64 }) });
      }
      await tx.insert(modelProviderConfigs).values({ id: providerId, tenantId: context.tenantId, provider: "openai-compatible", label: "Synthetic revision provider", endpoint: "https://synthetic.invalid/v1", encryptedApiKey: vault.encrypt("synthetic-never-called"), createdBy: context.userId });
      await tx.insert(modelRoutes).values({ id: routeId, tenantId: context.tenantId, taskType: "studio_image", modelKey: "Synthetic revision image", targets: [{ providerConfigId: providerId, providerModel: "gpt-image-2.5", timeoutMs: 1000 }] });
    });
    const runId = await withTenant(database.db, context, tx => registerOrderDesignRun(tx, context, snapshot, workKey));
    const submitted: Array<{ prompt: string; bytes: Buffer; feedback: Buffer[] }> = [];
    const generate = vi.fn<OrderDesignImageGateway["generate"]>(async input => {
      submitted.push({ prompt: input.prompt, bytes: Buffer.from(input.bytes), feedback: input.feedbackImages?.map(item => Buffer.from(item.bytes)) ?? [] });
      return { bytes: submitted.length === 1 ? source : await subject(512, submitted.length === 2 ? "#795630" : "#557733"), actualCostUsd: 0.1, tokenUsage: usage };
    });
    const upscale: OrderDesignSuperResolutionGateway = { validatePolicy: async () => {},
      upscale: async ({ bytes }) => ({ bytes: await sharp(bytes).resize(2048, 2048).png().toBuffer(), evidence: { engine: "synthetic-revision" } }) };
    const processor = new OrderDesignProcessor(database, storage, vault, { generate }, { scan }, upscale);
    const result = { ...owner, lineId, orderId, runId, workKey, snapshot, processor, generate, submitted };
    await process(result, runId);
    const ready = await state(result, runId);
    expect(ready.run, safeState(ready)).toMatchObject({ status: "awaiting_review", errorCode: null });
    expect(ready.document!.layers.some(layer => layer.id === "fixed_reference")).toBe(true);
    return result;
  }

  type Fixture = Awaited<ReturnType<typeof candidate>>;
  async function decision(f: Pick<Fixture, "context" | "lineId" | "runId">, patch: Partial<OrderDesignReviseCandidate> = {}): Promise<OrderDesignReviseCandidate> {
    const view = await repository().view(f.context, f.lineId);
    return { runId: f.runId, expectedRevision: view.run!.revision, expectedEditorVersionId: view.run!.currentEditorVersionId!,
      idempotencyKey: randomUUID(), reason: "Correct only the marked edge and preserve the original subject", mode: "image_edit", attachments: [], ...patch };
  }
  function process(f: { context: TenantContext; processor: OrderDesignProcessor }, runId: string) {
    return f.processor.process({ tenantId: f.context.tenantId, requestedBy: f.context.userId, runId });
  }
  async function state(f: { context: TenantContext; lineId: string; workKey: Buffer }, runId: string) {
    return withTenant(database.db, f.context, async tx => {
      const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
      const [work] = await tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, f.lineId));
      const [project] = run!.projectId ? await tx.select().from(projects).where(eq(projects.id, run!.projectId)) : [];
      const versionRows = project ? await tx.select().from(versions).where(eq(versions.projectId, project.id)).orderBy(versions.versionNumber) : [];
      const assetRows = project ? await tx.select().from(images).where(eq(images.projectId, project.id)).orderBy(images.id) : [];
      const renderRows = project ? await tx.select().from(renders).where(eq(renders.projectId, project.id)).orderBy(renders.id) : [];
      const stepRows = await tx.select().from(steps).where(eq(steps.runId, runId)).orderBy(steps.position);
      const calls = await tx.select().from(orderDesignModelCalls).where(eq(orderDesignModelCalls.runId, runId)).orderBy(orderDesignModelCalls.id);
      const ledger = stepRows.length ? await tx.select().from(aiBudgetLedger).where(inArray(aiBudgetLedger.requestId, stepRows.map(step => step.requestId))).orderBy(aiBudgetLedger.id) : [];
      const version = versionRows.find(row => row.id === project?.currentVersionId);
      const document = project?.encryptedDataKey && version ? vault.withSecret(project.encryptedDataKey, value => {
        const key = Buffer.from(value, "base64");
        try { return open<ProductionEditorDocument>(key, version.encryptedDocument); } finally { key.fill(0); }
      }) : null;
      return { run: run!, work: work!, project: project ?? null, versions: versionRows, assets: assetRows, renders: renderRows,
        steps: stepRows, calls, ledger, document, snapshot: open<OrderDesignSnapshot>(f.workKey, run!.encryptedSnapshot) };
    });
  }
  async function expectOriginalPreserved(f: Fixture, before: Awaited<ReturnType<typeof state>>) {
    const after = await state(f, f.runId);
    for (const key of ["encryptedSnapshot", "inputChecksum", "methodSnapshot", "completionEvidence", "completionChecksum", "actualCostUsd", "costStatus", "estimatedCostUsd", "recipeVersion", "policyVersion", "modelRouteId", "workRevisionId"] as const) {
      expect(after.run[key], key).toEqual(before.run[key]);
    }
    expect(after.steps).toEqual(before.steps);
    expect(after.calls).toEqual(before.calls);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.versions.filter(row => before.versions.some(old => old.id === row.id))).toEqual(before.versions);
    expect(after.assets.filter(row => before.assets.some(old => old.id === row.id))).toEqual(before.assets);
    expect(after.renders.filter(row => before.renders.some(old => old.id === row.id))).toEqual(before.renders);
  }
  function safeState(value: Awaited<ReturnType<typeof state>>) {
    return JSON.stringify({ status: value.run.status, errorCode: value.run.errorCode,
      diagnostics: value.run.qualityDiagnostics.map(row => ({ code: row.code, severity: row.severity })),
      steps: value.steps.map(row => ({ key: row.key, status: row.status, errorCode: row.errorCode })),
      executionFailures: executionFailures.get(value.run.id) ?? [] });
  }
  function safeFailure(error: unknown) {
    const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
    const cause = value.cause && typeof value.cause === "object" ? value.cause as Record<string, unknown> : {};
    const text = (input: unknown, max: number) => typeof input === "string" ? input.slice(0, max) : null;
    return { name: text(value.name, 80), code: text(value.code, 80), causeCode: text(cause.code, 80),
      constraint: text(value.constraint ?? cause.constraint, 160), message: text(value.message, 200),
      stackFrames: typeof value.stack === "string" ? value.stack.split("\n").slice(1, 4).map(line => line.slice(0, 220)) : [] };
  }
  function withoutPosition(layer: ProductionEditorDocument["layers"][number]) {
    const { xMm: _xMm, yMm: _yMm, ...properties } = layer;
    void _xMm; void _yMm;
    return properties;
  }
  function expectPreservedLayout(before: ProductionEditorDocument, after: ProductionEditorDocument, targetIds: string[]) {
    expect(after.layers.map(layer => layer.id)).toEqual(before.layers.map(layer => layer.id));
    const originalAnchor = before.layers.find(layer => layer.id === targetIds[0])!;
    const revisedAnchor = after.layers.find(layer => layer.id === targetIds[0])!;
    expect(originalAnchor).toBeTruthy(); expect(revisedAnchor).toBeTruthy();
    for (const layer of before.layers.filter(row => !targetIds.includes(row.id))) {
      const updated = after.layers.find(row => row.id === layer.id)!;
      expect(withoutPosition(updated)).toEqual(withoutPosition(layer));
      // A changed cut path can renormalize the canvas origin. Every untouched
      // layer must receive exactly the same translation as the subject anchor.
      expect(updated.xMm - revisedAnchor.xMm).toBeCloseTo(layer.xMm - originalAnchor.xMm, 10);
      expect(updated.yMm - revisedAnchor.yMm).toBeCloseTo(layer.yMm - originalAnchor.yMm, 10);
    }
  }
  function image(size: number, color: string) {
    return sharp({ create: { width: size, height: size, channels: 4, background: color } }).png().toBuffer();
  }
  function subject(size: number, color: string) {
    return sharp(Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><ellipse cx="${size / 2}" cy="${size / 2}" rx="${size * .43}" ry="${size * .44}" fill="${color}"/></svg>`)).png().toBuffer();
  }
  function editorServices() {
    const audit = new AuditService(database);
    const rejectExternal = vi.fn(async () => { throw new Error("Synthetic revision must not call an external service"); });
    const order = new OrderService(database, vault, audit);
    const reports = new AmazonOrderReportService(database, vault, order, audit, { download: rejectExternal, scan }, { schedule: rejectExternal }, { schedule: rejectExternal });
    const editor = new ProductionEditorService(database, vault, storage, reports, audit, { enqueue: rejectExternal }, { scan });
    return { editor, workspace: new OrderWorkspaceService(database, vault, storage, reports, editor, { scan }) };
  }
});
