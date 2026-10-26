import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { StudioGenerateRequestSchema, type StudioGenerateRequest } from "@yummyai/contracts/pod/creative-studio";
import { PillowRuntimeCapabilitySchema } from "@yummyai/contracts/pod/design-automation";
import { aiBudgetLedger, aiBudgetPolicies, assetFiles, connectDatabase, creativeExecutions, creativeStudioEntries, creativeStudioGenerations, creativeStudioRevisions,
  memberships, membershipRoles, migrateDatabase, modelProviderConfigs, modelRoutes, roles, visualDeliveryModelFingerprint, withTenant } from "@yummyai/database";
import { stageCreativeExecution } from "@yummyai/pod-core";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { CanvasBridgeService } from "./canvas-bridge.service.js";
import { CreativeStudioService } from "./creative-studio.service.js";
import { StudioGenerationService } from "./studio-generation.service.js";
import { PodBatchWorkflowService } from "./pod-batch-workflow.service.js";
import { DesignService, DrizzleDesignRepository } from "./design.service.js";
import { StudioGenerationProcessor } from "../../../worker/src/processors/studio-generation.processor.js";
import type { JobEnvelope } from "@yummyai/jobs";

describe("ERP creative studio with RLS, private files and durable generation", () => {
  const database = connectDatabase(), storage = createStorageFromEnvironment(), vault = new SecretVault(Buffer.alloc(32, 71));
  const tenantA = createEntityId(), tenantB = createEntityId(), userA = createEntityId(), userB = createEntityId();
  const a: TenantContext = { tenantId: tenantA, userId: userA, permissions: Object.values(Permission), dataScope: "tenant" }, b = { ...a, tenantId: tenantB, userId: userB }, otherMember = { ...a, userId: userB };
  const audit = new AuditService(database), enqueuer = { enqueue: vi.fn() };
  const scan = vi.fn(async () => ({ result: "clean" as const, engine: "synthetic", signatureVersion: "fixture-1", scannedAt: new Date().toISOString() }));
  const designs = new PodBatchWorkflowService(database, { enqueueCreativeCandidate: vi.fn(), enqueueCreativeAdaptation: vi.fn(), enqueueTemplateCompile: vi.fn(), enqueueMockupRender: vi.fn() }, audit, new DesignService(new DrizzleDesignRepository(database, storage)));
  const bridge = new CanvasBridgeService(database, storage, audit, designs, { scan }), generations = new StudioGenerationService(database, storage, enqueuer, bridge);
  const studio = new CreativeStudioService(database, storage, { scan }, bridge, audit, generations);
  let image: Buffer, modelId: string;
  const invoke = (input: Record<string, unknown>, context = a) => studio.invoke(context, { scope: "unassigned", ...input });
  const request = async () => {
    const selected = (await generations.models(a)).find(row => row.id === modelId)!;
    return StudioGenerateRequestSchema.parse({ requestId: randomUUID(), modelId, capability: "image", selectionRevision: selected.selectionRevision, prompt: "Synthetic blue square" });
  };
  const envelope = (id: string): JobEnvelope => ({ jobId: id, correlationId: id, idempotencyKey: id, traceId: "studio-test-trace", tenantId: tenantA, requestedBy: userA, requestedAt: new Date().toISOString(), attempt: 0, maxAttempts: 1, payload: { generationId: id } });
  async function retainedGeneration(scope: string, input: StudioGenerateRequest, status: "completed" | "failed", assetId?: string, error?: string) {
    const id = createEntityId();
    await withTenant(database.db, a, async tx => {
      const [route] = await tx.select().from(modelRoutes).where(eq(modelRoutes.id, input.modelId));
      if (!route?.targets[0]) throw new Error("Synthetic retained route missing");
      const [provider] = await tx.select().from(modelProviderConfigs).where(eq(modelProviderConfigs.id, route.targets[0].providerConfigId));
      if (!provider) throw new Error("Synthetic retained provider missing");
      await tx.insert(creativeStudioGenerations).values({ id, tenantId: tenantA, ownerId: userA, scope, requestId: input.requestId, input, status,
        assetId: assetId ?? null, error: error ?? null, references: [], modelSnapshot: { routeId: route.id, providerConfigId: provider.id,
          model: route.targets[0].providerModel, capability: "image", providerFingerprint: visualDeliveryModelFingerprint(provider, route.targets[0]) } });
    });
    return { id };
  }
  beforeAll(async () => {
    await migrateDatabase(database); await storage.ensureBucket();
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Studio test A',$2),($3,'Studio test B',$4)", [tenantA, `studio-${tenantA}`, tenantB, `studio-${tenantB}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Studio A'),($4,$5,$6,'Studio B')", [userA, `studio-${userA}`, `${userA}@example.test`, userB, `studio-${userB}`, `${userB}@example.test`]);
    for (const actor of [a, b]) await withTenant(database.db, actor, async tx => {
      const membershipId = createEntityId(), roleId = createEntityId();
      await tx.insert(memberships).values({ id: membershipId, tenantId: actor.tenantId, userId: actor.userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId: actor.tenantId, name: "Synthetic studio role", permissions: Object.values(Permission), dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: actor.tenantId, membershipId, roleId });
      await tx.insert(aiBudgetPolicies).values({ tenantId: actor.tenantId, monthlyCapUsd: "100.000000", defaultTaskCapUsd: "0.100000", taskCapsUsd: {} });
    });
    image = await sharp({ create: { width: 32, height: 24, channels: 4, background: "#2857a6" } }).png().toBuffer();
    const providerId = createEntityId();
    await withTenant(database.db, a, tx => tx.insert(modelProviderConfigs).values({ id: providerId, tenantId: tenantA, provider: "openai-compatible", label: "Synthetic fixture only", endpoint: "http://127.0.0.1:9/v1", encryptedApiKey: vault.encrypt("synthetic-test-only"), createdBy: userA }));
    modelId = (await generations.addModel(a, { providerConfigId: providerId, model: "fixture-image", capability: "image", label: "Synthetic image fixture" })).id;
  }, 60_000);
  afterAll(async () => database.client.end());
  it("returns only safe pillow runtime capability to authorized readers and rejects caller-selected executable paths",async()=>{
    const capability=await invoke({operation:"pillow-runtime"});
    expect(PillowRuntimeCapabilitySchema.safeParse(capability).success).toBe(true);
    expect(JSON.stringify(capability)).not.toMatch(/(?:[A-Z]:\\|runtimeDirectory|apiKey|endpoint|objectKey)/i);
    await expect(invoke({operation:"pillow-runtime"},{...a,permissions:[]})).rejects.toThrow();
    await expect(invoke({operation:"pillow-runtime"},{...a,permissions:[Permission.DesignRead]})).rejects.toThrow();
    await expect(invoke({operation:"pillow-runtime",directory:"C:\\untrusted"})).rejects.toBeInstanceOf(BadRequestException);
    await expect(invoke({operation:"pillow-runtime",scope:createEntityId()})).rejects.toBeInstanceOf(NotFoundException);
  });
  it("restores documents, detects concurrent edits and isolates tenants, members and scopes", async () => {
    const address = { namespace: "app_state", key: "infinite-canvas:canvas_store" };
    const document = JSON.stringify({ state: { projects: [{ id: "fixture-canvas", title: "Fixture", nodes: [{ id: "node-1", type: "text", text: "Hello" }], connections: [] }], deletedProjects: [] }, version: 0 });
    expect(await invoke({ operation: "state.get", ...address })).toEqual({ revision: 0, value: null });
    expect(await invoke({ operation: "state.set", ...address, revision: 0, value: document })).toMatchObject({ revision: 1 });
    expect(await invoke({ operation: "state.get", ...address })).toEqual({ revision: 1, value: document });
    expect(await invoke({ operation: "state.get", ...address }, b)).toEqual({ revision: 0, value: null });
    expect(await invoke({ operation: "state.get", ...address }, otherMember)).toEqual({ revision: 0, value: null });
    await expect(invoke({ operation: "state.set", ...address, revision: 0, value: "stale" })).rejects.toBeInstanceOf(ConflictException);
    const writes = await Promise.allSettled(["left", "right"].map(value => invoke({ operation: "state.set", ...address, revision: 1, value })));
    expect(writes.filter(item => item.status === "fulfilled")).toHaveLength(1);
    const revisions = await withTenant(database.db, a, tx => tx.select().from(creativeStudioRevisions));
    expect(revisions).toHaveLength(2);
    await expect(withTenant(database.db, a, tx => tx.execute(sql`update creative_studio_revisions set value = '{}'::jsonb where id = ${revisions[0]!.id}`))).rejects.toThrow();
    expect(await withTenant(database.db, b, tx => tx.select().from(creativeStudioEntries))).toEqual([]);
    await expect(invoke({ operation: "state.get", ...address, scope: createEntityId() })).rejects.toBeInstanceOf(NotFoundException);
  });
  it("rejects serialized credentials, unknown config stores and unauthorized writes", async () => {
    const base = { operation: "state.set", namespace: "app_state", key: "infinite-canvas:asset_store", revision: 0 };
    await expect(invoke({ ...base, value: JSON.stringify({ config: { apiKey: "synthetic-only" } }) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(invoke({ ...base, key: "infinite-canvas:ai_config_store", value: {} })).rejects.toBeInstanceOf(BadRequestException);
    await expect(invoke({ ...base, value: {} }, { ...a, permissions: [Permission.DesignRead, Permission.AssetRead] })).rejects.toThrow();
  });
  it("returns compact project summaries without workflow documents and preserves tenant permissions", async () => {
    const brief = await bridge.create(a, { requestId: randomUUID(), name: "Compact selector fixture", prompt: "Must not appear in the selector", referenceAssetIds: [] });
    const rows = await bridge.projectSummaries(a);
    expect(rows.find(row => row.id === brief.id)).toEqual({ id: brief.id, name: brief.name, stepIndex: brief.workflow?.stepIndex ?? null });
    expect(await bridge.projectSummaries(b)).toEqual([]);
    await expect(bridge.projectSummaries({ ...a, permissions: [] })).rejects.toThrow();
  });
  it("serves bounded private thumbnails without changing the original or exposing other members' files", async () => {
    const key = `image:${randomUUID()}`;
    const original = await sharp({ create: { width: 1024, height: 768, channels: 4, background: "#357ca2" } }).png().toBuffer();
    await invoke({ operation: "state.set", namespace: "image_files", key, revision: 0, media: { contentBase64: original.toString("base64"), mediaType: "image/png" } });
    const preview = await invoke({ operation: "asset.preview", namespace: "image_files", key }) as { contentBase64: string; mediaType: string };
    expect(preview.mediaType).toBe("image/webp");
    expect(await sharp(Buffer.from(preview.contentBase64, "base64")).metadata()).toMatchObject({ width: 320, height: 240 });
    expect(await invoke({ operation: "state.get", namespace: "image_files", key })).toMatchObject({ revision: 1, media: { contentBase64: original.toString("base64"), mediaType: "image/png" } });
    for (const context of [b, otherMember]) await expect(invoke({ operation: "asset.preview", namespace: "image_files", key }, context)).rejects.toBeInstanceOf(NotFoundException);
    await expect(invoke({ operation: "asset.preview", namespace: "image_files", key }, { ...a, permissions: [Permission.DesignRead] })).rejects.toThrow();
    await expect(invoke({ operation: "asset.preview", namespace: "image_files", key, scope: createEntityId() })).rejects.toBeInstanceOf(NotFoundException);
    await invoke({ operation: "state.remove", namespace: "image_files", key, revision: 1 });
    await expect(invoke({ operation: "asset.preview", namespace: "image_files", key })).rejects.toBeInstanceOf(NotFoundException);
  });
  it("scans uploads, requires rights review and shares a single authorized asset record", async () => {
    const key = `image:${randomUUID()}`;
    const result = await invoke({ operation: "state.set", namespace: "image_files", key, revision: 0, media: { contentBase64: image.toString("base64"), mediaType: "image/png" } }) as { assetId: string };
    expect(scan).toHaveBeenCalled();
    await expect(generations.create(a, "unassigned", { ...await request(), referenceKeys: [key] })).rejects.toMatchObject({ status: 409, response: { code: "studio_paid_execution_paused" } });
    await expect(invoke({ operation: "reference.attach", assetId: result.assetId })).rejects.toBeInstanceOf(BadRequestException);
    await invoke({ operation: "asset.review", key, decision: "approve", sourceReference: "Synthetic original owned artwork" });
    const attached = await invoke({ operation: "reference.attach", assetId: result.assetId }) as { key: string };
    const restored = await invoke({ operation: "state.get", namespace: "image_files", key: attached.key });
    expect(restored).toMatchObject({ assetId: result.assetId, media: { contentBase64: image.toString("base64"), mediaType: "image/png" } });
    await expect(invoke({ operation: "reference.attach", assetId: result.assetId }, b)).rejects.toBeInstanceOf(NotFoundException);
    const invalidOriginal = invoke({ operation: "state.set", namespace: "image_files", key: "image:invalid", revision: 0, media: { contentBase64: Buffer.from("not an image").toString("base64"), mediaType: "image/png" } });
    await expect(invalidOriginal).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(invalidOriginal).rejects.toMatchObject({ status: 422, response: { code: "studio_original_invalid_media" } });
    const [asset] = await withTenant(database.db, a, tx => tx.select().from(assetFiles).where(eq(assetFiles.id, result.assetId)));
    await withTenant(database.db, a, tx => tx.update(assetFiles).set({ rightsMetadata: { source: { kind: "customer_provided" } } }).where(eq(assetFiles.id, asset!.id)));
    await expect(invoke({ operation: "state.get", namespace: "image_files", key })).rejects.toBeInstanceOf(NotFoundException);
  });
  it("preserves an immutable completed legacy generation and submits its same private asset for review without requeue", async () => {
    const brief = await bridge.create(a, { requestId: randomUUID(), name: "Studio generation fixture", prompt: "Synthetic square", referenceAssetIds: [], requirements: { mode: "fixed", style: "Muted blue border", acceptance: "Keep exact square geometry" } });
    const input = StudioGenerateRequestSchema.parse({ ...await request(), prompt: `Synthetic blue square\n\n项目固定需求：\n${brief.designInstructions}` });
    const assetId = createEntityId(), stored = await storage.putPrivate(a, { domain: "authorized", fileName: "synthetic-retained-studio.png", mediaType: "image/png", body: image });
    await withTenant(database.db, a, tx => tx.insert(assetFiles).values({ id: assetId, tenantId: tenantA, ownerUserId: userA, ...stored, assetDomain: "authorized",
      fileName: "synthetic-retained-studio.png", mediaType: "image/png", byteSize: image.length, aiGenerated: true, rightsStatus: "unverified", rightsMetadata: { source: { kind: "ai_generated" }, fixture: "retained-pre-quotation-history" } }));
    const job = await retainedGeneration(brief.id, input, "completed", assetId);
    const [original] = await withTenant(database.db, a, tx => tx.select().from(creativeStudioGenerations).where(eq(creativeStudioGenerations.id, job.id)));
    for (const raw of [input, { ...input, prompt: "Changed" }]) await expect(generations.create(a, brief.id, raw)).rejects.toMatchObject({ status: 409, response: { code: "studio_paid_execution_paused" } });
    const generate = vi.fn(async () => ({ bytes: image, mediaType: "image/png" }));
    const processor = new StudioGenerationProcessor(database, storage, vault, { generate }, { scan });
    await processor.process(envelope(job.id)); await processor.process(envelope(job.id));
    expect(generate).not.toHaveBeenCalled(); expect(enqueuer.enqueue).not.toHaveBeenCalled();
    expect(await generations.get(b, brief.id, job.id).catch(error => error)).toBeInstanceOf(NotFoundException);
    const saved = await generations.get(a, brief.id, job.id);
    expect(saved).toMatchObject({ status: "completed", contentBase64: image.toString("base64") });
    expect((await bridge.get(a, brief.id)).resultCount).toBe(1);
    await generations.get(a, brief.id, job.id);
    expect((await bridge.get(a, brief.id)).resultCount).toBe(1);
    const [record] = await withTenant(database.db, a, tx => tx.select().from(creativeStudioGenerations).where(eq(creativeStudioGenerations.id, job.id)));
    expect(record).toEqual(original); expect(await generations.originalInput(a, brief.id, input.requestId)).toEqual(input);
    expect(record!.input.prompt).toContain("Muted blue border");
    expect(record!.input.prompt).toContain("Keep exact square geometry");
    const [asset] = await withTenant(database.db, a, tx => tx.select().from(assetFiles).where(eq(assetFiles.id, record!.assetId!)));
    expect(asset).toMatchObject({ aiGenerated: true, rightsStatus: "unverified" });
  });
  it("does not resume or settle retained uncertain billing and preserves sanitized failed history", async () => {
    const input = await request(), job = await retainedGeneration("unassigned", input, "failed", undefined, "studio_submission_interrupted");
    await withTenant(database.db, a, async tx => {
      const execution = await stageCreativeExecution(tx, a, { kind: "studio_generation", ownerId: job.id, stepKey: "generate" }, "external_request"), ledgerId = createEntityId();
      await tx.insert(aiBudgetLedger).values({ id: ledgerId, tenantId: tenantA, requestId: job.id, taskType: "studio_image", modelKey: "fixture-image", provider: "openai-compatible", amountUsd: "0.100000", state: "reserved" });
      await tx.update(creativeExecutions).set({ phase: "uncertain", errorCode: "CREATIVE_RESULT_UNCERTAIN", attemptCount: 1,
        submittedAt: sql`clock_timestamp()-interval '1 hour'`, submissionToken: createEntityId(), budgetLedgerId: ledgerId, budgetLimitUsd: "0.100000" }).where(eq(creativeExecutions.id, execution.id));
    });
    const retained = () => withTenant(database.db, a, async tx => ({ generations: await tx.select().from(creativeStudioGenerations), executions: await tx.select().from(creativeExecutions), ledger: await tx.select().from(aiBudgetLedger) }));
    const before = await retained(), generate = vi.fn(async () => { throw new Error("synthetic-secret-must-not-be-persisted"); });
    const processor = new StudioGenerationProcessor(database, storage, vault, { generate }, { scan });
    await processor.process(envelope(job.id)); await processor.process(envelope(job.id)); expect(generate).not.toHaveBeenCalled();
    expect(await generations.get(a, "unassigned", job.id)).toMatchObject({ status: "failed", error: "studio_submission_interrupted" });
    expect(await generations.originalInput(a, "unassigned", input.requestId)).toEqual(input);
    expect(await retained()).toEqual(before); expect(JSON.stringify(before)).not.toContain("synthetic-secret-must-not-be-persisted");
    await expect(generations.create(a, "unassigned", input)).rejects.toMatchObject({ status: 409, response: { code: "studio_paid_execution_paused" } });
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
  });
});
