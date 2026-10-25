import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { ConfigurationSnapshotSchema } from "@yummyai/contracts/ai/model-configuration";
import { StudioGenerateSchema } from "@yummyai/contracts/pod/creative-studio";
import { StudioPaidImageInputSchema, StudioPaidImageRequestSchema } from "@yummyai/contracts/pod/studio-paid-image";
import { aiBudgetLedger, aiBudgetPolicies, assetFiles, connectDatabase, creativeExecutions, creativeStudioGenerations,
  loadCurrentMembershipContext, memberships, membershipRoles, migrateDatabase, modelProviderConfigs, modelRoutes, roles, visualDeliveryModelFingerprint, withTenant } from "@yummyai/database";
import { stageCreativeExecution, type CreativeOperation } from "@yummyai/pod-core";
import { createStorageFromEnvironment, type Storage } from "@yummyai/storage";
import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CreativeExecutionRecovery, type CreativeExecutionClaim } from "../../../worker/src/processors/creative-execution-recovery.js";
import { creativeLocalResponse, creativeResponseChecksum } from "../../../worker/src/processors/creative-execution-response.js";
import { podInvocationReceipt } from "../../../worker/src/processors/pod-invocation-receipt.js";
import { StudioGenerationProcessor } from "../../../worker/src/processors/studio-generation.processor.js";
import { HttpStudioGateway } from "../../../worker/src/processors/studio-generation.gateway.js";
import { createQueue, createTraceId, enqueueJob, QueueName, type JobEnvelope } from "@yummyai/jobs";
import { ClamAvScanner } from "@yummyai/storage";
import { objectKey } from "@yummyai/storage";
import { hashPodResponse } from "../../../worker/src/processors/pod-artwork-response.js";
import { vi } from "vitest";
import { ModelConfigurationService } from "../ai/model-configuration.service.js";
import { AuditService } from "../audit/audit.service.js";
import { CanvasBridgeService } from "./canvas-bridge.service.js";
import { CreativeExecutionOperatorService } from "./creative-execution-operator.service.js";
import { DesignService, DrizzleDesignRepository } from "./design.service.js";
import { PodBatchWorkflowService } from "./pod-batch-workflow.service.js";
import { StudioGenerationService } from "./studio-generation.service.js";
import { StudioPaidImageService } from "./studio-paid-image.service.js";

if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname))
  throw new Error("Use the disposable creative editing acceptance runner");

describe("creative original submission, response and asset recovery", () => {
  const database = connectDatabase(), storage = createStorageFromEnvironment(), vault = new SecretVault(Buffer.alloc(32, 43)), modelVault = new SecretVault(Buffer.alloc(32, 37));
  const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant" };
  const roleId = createEntityId(); let image: Buffer;
  let originalAdmission: { enabled: string | undefined; tenants: string | undefined };
  const admission = (enabled: boolean) => {
    process.env.STUDIO_PAID_IMAGE_ENABLED = enabled ? "1" : "0";
    process.env.STUDIO_PAID_IMAGE_TENANT_IDS = enabled ? context.tenantId : "";
  };
  const recovery = (store: Storage = storage) => new CreativeExecutionRecovery(database, store, vault);
  const grant = (permissions: readonly string[] = Object.values(Permission)) => withTenant(database.db, context, tx => tx.update(roles).set({ permissions }).where(eq(roles.id, roleId)));
  const current = () => withTenant(database.db, context, tx => loadCurrentMembershipContext(tx, context));
  const read = (id: string) => withTenant(database.db, context, async tx => (await tx.select().from(creativeExecutions).where(eq(creativeExecutions.id, id)))[0]!);
  const due = (id: string) => withTenant(database.db, context, tx => tx.update(creativeExecutions).set({
    leaseExpiresAt: sql`case when ${creativeExecutions.leaseToken} is null then null else clock_timestamp()-interval '1 second' end`, nextAttemptAt: sql`clock_timestamp()-interval '1 second'`,
  }).where(eq(creativeExecutions.id, id)));
  async function operation(modelKey = `synthetic-${createEntityId()}`, reserve = false, capability: "image" | "video" | "text" = "image", endpoint = "http://127.0.0.1:9/v1") {
    const ownerId = createEntityId(), op: CreativeOperation = { kind: "studio_generation", ownerId, stepKey: "generate" };
    const authority = await current();
    const execution = await withTenant(database.db, authority, async tx => {
      const taskType = `studio_${capability}`;
      const [previous] = await tx.select().from(modelRoutes).where(and(eq(modelRoutes.modelKey, modelKey), eq(modelRoutes.taskType, taskType)));
      const [provider] = previous ? await tx.select().from(modelProviderConfigs).where(eq(modelProviderConfigs.id, previous.targets[0]!.providerConfigId))
        : await tx.insert(modelProviderConfigs).values({ id: createEntityId(), tenantId: context.tenantId, provider: "openai-compatible",
          label: `Synthetic ${ownerId}`, endpoint, encryptedApiKey: modelVault.encrypt("synthetic-test-only"), createdBy: context.userId }).returning();
      const target = previous?.targets[0] ?? { providerConfigId: provider!.id, providerModel: modelKey, timeoutMs: 600000 };
      const [route] = previous ? [previous] : await tx.insert(modelRoutes).values({ id: createEntityId(), tenantId: context.tenantId, modelKey, taskType, targets: [target] }).returning();
      await tx.insert(creativeStudioGenerations).values({ id: ownerId, tenantId: context.tenantId, ownerId: context.userId, scope: "unassigned",
        requestId: randomUUID(), input: StudioGenerateSchema.parse({ requestId: randomUUID(), modelId: route!.id, prompt: "Synthetic original creative operation" }),
        references: [], modelSnapshot: { providerConfigId: provider!.id, model: modelKey, capability, routeId: route!.id, providerFingerprint: visualDeliveryModelFingerprint(provider!, target) } });
      if (reserve) await tx.insert(aiBudgetLedger).values({ id: createEntityId(), tenantId: context.tenantId, requestId: ownerId,
        taskType, modelKey, provider: "openai-compatible", amountUsd: "0.100000", state: "reserved" });
      return stageCreativeExecution(tx, authority, op, "external_request");
    });
    return { op, execution, billing: { taskType: `studio_${capability}`, modelKey, provider: "openai-compatible", ceilingUsd: "0.100000" } };
  }
  // New Processor recovery must start from the real quoted image producer.
  // Directly staged owners above are retained pre-quotation history only.
  async function paidOperation(endpoint = "http://127.0.0.1:9/v1") {
    const authority = await current(), modelKey = `synthetic-${createEntityId()}`;
    const configuration = new ModelConfigurationService(database, modelVault);
    const channelName = `Synthetic recovery image ${createEntityId()}`;
    const configured = ConfigurationSnapshotSchema.parse(JSON.parse(JSON.stringify(await configuration.invoke(authority, {
      operation: "channel.save", name: channelName, baseUrl: endpoint, apiKey: "synthetic-test-only",
      models: [{ name: modelKey, capability: "image" }],
    }))));
    const channel = configured.channels.find(row => row.name === channelName);
    if (!channel || channel.models.length !== 1) throw new Error("Synthetic quoted recovery model missing");
    const modelId = channel.models[0]!.id;
    await configuration.invoke(authority, { operation: "studio.image-pricing.save", channelId: channel.id,
      modelId, revision: channel.revision, pricing: { estimatedUsd: "0.02000000", reservationUsd: "0.100000",
        reference: "Synthetic isolated recovery estimate Not a provider invoice" } });
    const audit = new AuditService(database);
    const forbiddenDispatch = async () => { throw new Error("Synthetic recovery unexpected POD dispatch"); };
    const designs = new PodBatchWorkflowService(database, { enqueueCreativeCandidate: forbiddenDispatch,
      enqueueCreativeAdaptation: forbiddenDispatch, enqueueTemplateCompile: forbiddenDispatch, enqueueMockupRender: forbiddenDispatch },
    audit, new DesignService(new DrizzleDesignRepository(database, storage)));
    const clam = new ClamAvScanner();
    const bridge = new CanvasBridgeService(database, storage, audit, designs,
      { scan: (body: Uint8Array, fileName: string, mediaType: string) => clam.scan({ body, fileName, mediaType }) });
    const deliveries: Array<{ id: string; tenantId: string; userId: string }> = [];
    const queue = { async enqueue(value: { id: string; tenantId: string; userId: string }) { deliveries.push(value); } };
    const generations = new StudioGenerationService(database, storage, queue, bridge);
    const selected = (await generations.models(authority)).find(row => row.id === modelId);
    if (!selected) throw new Error("Synthetic quoted recovery selection missing");
    const input = StudioPaidImageInputSchema.parse({ requestId: randomUUID(), modelId, capability: "image",
      selectionRevision: selected.selectionRevision, prompt: "Synthetic quoted original creative recovery",
      size: "1024x1024", quality: "high", background: "opaque" });
    const service = new StudioPaidImageService(database, queue, bridge);
    const prepared = StudioPaidImageRequestSchema.parse(await service.prepare(authority, { scope: "unassigned", input }));
    expect(prepared.status).toBe("prepared"); expect(deliveries).toEqual([]);
    admission(true);
    const accepted = StudioPaidImageRequestSchema.parse(await service.commit(authority, {
      scope: prepared.scope, requestId: prepared.requestId, quoteHash: prepared.quote.quoteHash, confirmed: true,
    }));
    if (!accepted.generationId) throw new Error("Synthetic quoted recovery generation missing");
    expect(deliveries).toEqual([{ id: accepted.generationId, tenantId: context.tenantId, userId: context.userId }]);
    const execution = await withTenant(database.db, authority, async tx => {
      const rows = await tx.select().from(creativeExecutions).where(eq(creativeExecutions.studioGenerationId, accepted.generationId!));
      expect(rows).toHaveLength(1); return rows[0]!;
    });
    const op: CreativeOperation = { kind: "studio_generation", ownerId: accepted.generationId, stepKey: "generate" };
    return { op, execution, routeId: prepared.quote.modelId,
      billing: { taskType: "studio_image", modelKey, provider: "openai-compatible", ceilingUsd: prepared.quote.pricing.reservationUsd } };
  }
  async function submitted(reserve = false) {
    const item = await operation(undefined, reserve), repo = recovery(), claim = (await repo.claim(context, item.op))!;
    await repo.markSubmitted(context, claim, item.billing); return { ...item, repo, claim };
  }
  const response = () => creativeLocalResponse([{ bytes: image, mediaType: "image/png", role: "image" }], { purpose: "synthetic result" });
  function receipt(value: ReturnType<typeof response>, costUsd?: number) {
    return podInvocationReceipt({ modelKey: "synthetic-reported", modelVersion: "v1", ...(costUsd === undefined ? {} : { costUsd }) }, creativeResponseChecksum(value), "synthetic-request");
  }
  async function adopt(repo: CreativeExecutionRecovery, claim: CreativeExecutionClaim, fail = false) {
    return repo.complete(context, claim, [{ bytes: image, mediaType: "image/png", role: "image", aiGenerated: true,
      rightsStatus: "unverified", rightsMetadata: { source: { kind: "ai_generated", reference: "synthetic result" } } }], async (tx, _admission, assets) => {
      await tx.update(creativeStudioGenerations).set({ status: "completed", assetId: assets[0]!.id }).where(eq(creativeStudioGenerations.id, claim.operation.ownerId));
      if (fail) throw new Error("SYNTHETIC_OWNER_COMMIT_INTERRUPTED");
      return { assetId: assets[0]!.id };
    });
  }
  beforeAll(async () => {
    await migrateDatabase(database); await storage.ensureBucket();
    await database.client.unsafe("insert into organizations(id,name,slug)values($1,'Synthetic creative recovery',$2)", [context.tenantId, `creative-recovery-${context.tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic creative actor')", [context.userId, `creative-recovery-${context.userId}`, `${context.userId}@example.test`]);
    await withTenant(database.db, context, async tx => {
      const member = createEntityId();
      await tx.insert(memberships).values({ id: member, tenantId: context.tenantId, userId: context.userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId: context.tenantId, name: "Synthetic creative role", permissions: Object.values(Permission), dataScope: "self" });
      await tx.insert(membershipRoles).values({ tenantId: context.tenantId, membershipId: member, roleId });
      await tx.insert(aiBudgetPolicies).values({ tenantId: context.tenantId, monthlyCapUsd: "100.000000", defaultTaskCapUsd: "0.100000", taskCapsUsd: {} });
    });
    image = await sharp({ create: { width: 32, height: 24, channels: 4, background: "#2879be" } }).png().toBuffer();
  });
  beforeEach(async () => {
    originalAdmission = { enabled: process.env.STUDIO_PAID_IMAGE_ENABLED, tenants: process.env.STUDIO_PAID_IMAGE_TENANT_IDS };
    admission(false); await grant();
  });
  afterEach(() => {
    if (originalAdmission.enabled === undefined) delete process.env.STUDIO_PAID_IMAGE_ENABLED;
    else process.env.STUDIO_PAID_IMAGE_ENABLED = originalAdmission.enabled;
    if (originalAdmission.tenants === undefined) delete process.env.STUDIO_PAID_IMAGE_TENANT_IDS;
    else process.env.STUDIO_PAID_IMAGE_TENANT_IDS = originalAdmission.tenants;
  });
  afterAll(() => database.client.end());
  const job = (id: string): JobEnvelope => ({ jobId: createEntityId(), idempotencyKey: createEntityId(), correlationId: id, traceId: createTraceId(),
    tenantId: context.tenantId, requestedBy: context.userId, requestedAt: new Date().toISOString(), attempt: 0, maxAttempts: 1, payload: { generationId: id } });

  const operator = new CreativeExecutionOperatorService(database);
  const history = async (item: Awaited<ReturnType<typeof operation>>, authority?: TenantContext) =>
    (await operator.history(authority ?? await current(), "studio_generation", item.op.ownerId)).entries[0]!;

  it("shows original metadata, unknown fees and exact receipts without exposing private execution fields", async () => {
    const item = await submitted(true), pending = await history(item);
    expect(pending.cost).toMatchObject({ basis: "unknown", amountUsd: null, budgetAmountUsd: "0.10000000", providerInvoiceVerified: false });
    expect(pending.canRequestRecovery).toBe(false);
    const value = response();
    await item.repo.record(context, item.claim, value, receipt(value, 0.01234567));
    const ready = await history(item);
    expect(ready).toMatchObject({ inputFingerprint: item.execution.inputFingerprint, method: item.execution.methodSelection, responseState: "retained" });
    expect(ready.cost).toMatchObject({ basis: "processor_reported", amountUsd: "0.01234567" });
    for (const field of ["authoritySnapshot", "authorityChecksum", "responseObjectKey", "encryptedChecksum", "leaseToken", "submissionToken", "artifactManifest", "modelSnapshot", "prompt"])
      expect(ready).not.toHaveProperty(field);
  });

  it("keeps read-only historical access but rechecks current membership and every owner scope", async () => {
    const item = await operation(), stale = await current();
    await grant([Permission.DesignRead, Permission.AssetRead]);
    const row = await history(item, stale);
    expect(row.canRequestRecovery).toBe(false); expect(row.canRecordCheck).toBe(false);
    await expect(operator.history({ ...context, userId: createEntityId(), dataScope: "self" }, "studio_generation", item.op.ownerId)).rejects.toMatchObject({ status: 403 });
    await expect(operator.history({ ...context, tenantId: createEntityId() }, "studio_generation", item.op.ownerId)).rejects.toMatchObject({ status: 404 });
    await grant([Permission.AssetRead]);
    await expect(history(item, stale)).rejects.toMatchObject({ status: 403 });
  });

  it("requests only the original durable record once and never resets an attempt or submission", async () => {
    const item = await operation();
    await withTenant(database.db, context, tx => tx.update(creativeExecutions).set({ nextAttemptAt: sql`clock_timestamp()+interval '1 hour'` }).where(eq(creativeExecutions.id, item.execution.id)));
    const row = await history(item), authority = await current();
    expect(row.canRequestRecovery).toBe(true);
    const command = { action: "request_recovery", commandId: randomUUID(), expectedFingerprint: row.fingerprint };
    const results = await Promise.all([operator.act(authority, row.id, command), operator.act(authority, row.id, command)]);
    expect(results[0]!.id).toBe(results[1]!.id);
    const original = await read(row.id);
    expect(original).toMatchObject({ id: row.id, phase: "pending", attemptCount: 0, submittedAt: null, budgetLedgerId: null, responseObjectKey: null });
    expect(original.nextAttemptAt.getTime()).toBeLessThan(Date.now()+1000);
    const view = await history(item); expect(view.events).toHaveLength(1);
    await expect(operator.act(authority, row.id, { ...command, expectedFingerprint: "f".repeat(64) })).rejects.toMatchObject({ status: 409 });
  });

  it("records immutable human attestations for uncertain requests without changing their fee or terminal state", async () => {
    const item = await submitted(true); await due(item.claim.id); expect(await item.repo.claim(context, item.op)).toBeUndefined();
    const row = await history(item), before = await read(row.id);
    expect(row.phase).toBe("uncertain");
    const command = { action: "record_check", commandId: randomUUID(), expectedFingerprint: row.fingerprint, finding: "response_located", proofChecksum: "a".repeat(64), matchesOriginalRequest: true };
    const authority = await current(), first = await operator.act(authority, row.id, command);
    expect(await operator.act(authority, row.id, command)).toEqual(first);
    expect(await read(row.id)).toEqual(before);
    const after = await history(item); expect(after.events[0]).toMatchObject({ finding: "response_located", verification: "operator_attested" });
    expect(after.cost).toEqual(row.cost); expect(after.canRequestRecovery).toBe(false);
    await expect(operator.act(authority, row.id, { action: "request_recovery", commandId: randomUUID(), expectedFingerprint: row.fingerprint })).rejects.toMatchObject({ status: 409 });
    await grant([Permission.DesignRead, Permission.AssetRead]);
    await expect(operator.act(authority, row.id, command)).rejects.toMatchObject({ status: 403 });
  });

  it("rejects stale, leased, exhausted, changed-source and unknown paid recovery requests before any dispatch", async () => {
    const item = await operation(), stale = await history(item), authority = await current();
    const claim = (await recovery().claim(context, item.op))!;
    await expect(operator.act(authority, stale.id, { action: "request_recovery", commandId: randomUUID(), expectedFingerprint: stale.fingerprint })).rejects.toMatchObject({ status: 409 });
    let row = await history(item); expect(row.recoveryBlockers).toContain("原执行仍持有有效租约");
    await expect(operator.act(authority, row.id, { action: "request_recovery", commandId: randomUUID(), expectedFingerprint: row.fingerprint })).rejects.toMatchObject({ status: 409 });
    await due(claim.id);
    await withTenant(database.db, context, tx => tx.update(creativeExecutions).set({ attemptCount: 3 }).where(eq(creativeExecutions.id, claim.id)));
    row = await history(item); expect(row.canRequestRecovery).toBe(false);
    const changed = await operation();
    const [generation] = await withTenant(database.db, context, tx => tx.select().from(creativeStudioGenerations).where(eq(creativeStudioGenerations.id, changed.op.ownerId)));
    await withTenant(database.db, context, tx => tx.update(modelRoutes).set({ status: "disabled" }).where(eq(modelRoutes.id, generation!.modelSnapshot.routeId!)));
    const changedRow = await history(changed);
    await expect(operator.act(authority, changedRow.id, { action: "request_recovery", commandId: randomUUID(), expectedFingerprint: changedRow.fingerprint })).rejects.toMatchObject({ status: 409 });
    expect((await read(changedRow.id)).dispatchCount).toBe(0);
    const unknown = await submitted(); await due(unknown.execution.id);
    const currentRow = await history(unknown); expect(currentRow.recoveryBlockers).toContain("原提交结果不明 需要人工核对渠道");
    await expect(operator.act(authority, currentRow.id, { action: "request_recovery", commandId: randomUUID(), expectedFingerprint: currentRow.fingerprint })).rejects.toMatchObject({ status: 409 });
  });

  it("claims once under concurrency and fences a stale local lease", async () => {
    const item = await operation(), repo = recovery();
    const claims = await Promise.all([repo.claim(context, item.op), repo.claim(context, item.op)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const original = claims.find(Boolean)!; await due(original.id);
    const next = (await repo.claim(context, item.op))!;
    expect(next.token).not.toBe(original.token);
    await expect(repo.markSubmitted(context, original, item.billing)).rejects.toThrow("CREATIVE_EXECUTION_LEASE_LOST");
    await repo.markSubmitted(context, next, item.billing);
  });
  it("rechecks current permissions before submission without creating a budget charge", async () => {
    const item = await operation(), repo = recovery(), claim = (await repo.claim(context, item.op))!;
    await grant([Permission.DesignRead, Permission.AssetRead]);
    await expect(repo.markSubmitted(context, claim, item.billing)).rejects.toMatchObject({ status: 403 });
    expect((await read(claim.id)).submittedAt).toBeNull();
    expect(await withTenant(database.db, context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, item.op.ownerId)))).toEqual([]);
  });
  it("reuses Studio's original reservation and rejects a second paid submission", async () => {
    const item = await submitted(true), row = await read(item.claim.id);
    const ledger = await withTenant(database.db, context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, item.op.ownerId)));
    expect(ledger).toHaveLength(1); expect(row.budgetLedgerId).toBe(ledger[0]!.id);
    await expect(item.repo.markSubmitted(context, item.claim, item.billing)).rejects.toThrow("CREATIVE_SUBMISSION_ALREADY_RECORDED");
  });
  it("keeps an unknown submitted outcome uncertain rather than invoking again", async () => {
    const item = await submitted(); await due(item.claim.id);
    expect(await item.repo.claim(context, item.op)).toBeUndefined();
    expect(await read(item.claim.id)).toMatchObject({ phase: "uncertain", errorCode: "CREATIVE_RESULT_UNCERTAIN" });
    expect(await item.repo.claim(context, item.op)).toBeUndefined();
    const [ledger] = await withTenant(database.db, context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, item.op.ownerId)));
    expect(ledger).toMatchObject({ state: "reserved", amountUsd: "0.100000" });
  });
  it("retains a late original receipt and exact eight-decimal cost after lease and permission loss", async () => {
    const item = await submitted(); await due(item.claim.id); await item.repo.claim(context, item.op);
    await grant([]); const value = response(), bill = receipt(value, 0.01234567);
    await item.repo.record(context, item.claim, value, bill);
    const row = await read(item.claim.id); expect(row.phase).toBe("uncertain"); expect(row.receipt?.costUsd).toBe("0.01234567");
    expect(row.responseObjectKey).toContain(`/${row.id}-pod-response.pe`);
    const [ledger] = await withTenant(database.db, context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.id, row.budgetLedgerId!)));
    expect(ledger).toMatchObject({ state: "committed", amountUsd: "0.012346" });
    await expect(item.repo.read(context, item.claim)).rejects.toThrow("CREATIVE_EXECUTION_LEASE_LOST");
  });
  it("recovers an upload acknowledgement loss from the exact encrypted response", async () => {
    const item = await submitted(); const value = response(), bill = receipt(value, 0.02);
    const proxy = Object.create(storage) as Storage;
    proxy.putPrivate = async (...args: Parameters<Storage["putPrivate"]>) => { await storage.putPrivate(...args); throw new Error("SYNTHETIC_ACK_LOST"); };
    await expect(recovery(proxy).record(context, item.claim, value, bill)).rejects.toThrow("SYNTHETIC_ACK_LOST");
    await due(item.claim.id); const resumed = (await recovery().claim(context, item.op))!;
    expect(resumed.hasResponse).toBe(true); expect(await recovery().read(context, resumed)).toEqual(value);
    const result = await adopt(recovery(), resumed); expect(result.assetId).toBeTruthy();
    expect((await read(item.claim.id)).phase).toBe("completed");
  });
  it("rolls back asset adoption with the owner and resumes without another reservation", async () => {
    const item = await submitted(); const value = response(); await item.repo.record(context, item.claim, value, receipt(value, 0.03));
    await item.repo.read(context, item.claim);
    await expect(adopt(item.repo, item.claim, true)).rejects.toThrow("SYNTHETIC_OWNER_COMMIT_INTERRUPTED");
    const before = await read(item.claim.id); expect(before.phase).toBe("response_ready"); expect(before.completionEvidence).toBeNull();
    const files = await withTenant(database.db, context, tx => tx.select().from(assetFiles).where(eq(assetFiles.objectKey, before.artifactManifest![0]!.objectKey)));
    expect(files).toEqual([]);
    await item.repo.fail(context, item.op, item.claim, "CREATIVE_LOCAL_PROCESSING_FAILED", false); await due(item.claim.id);
    const resumed = (await recovery().claim(context, item.op))!; await recovery().read(context, resumed); await adopt(recovery(), resumed);
    expect((await read(item.claim.id)).completionEvidence?.artifacts).toHaveLength(1);
  });
  it("rejects response adoption when authority is revoked during private storage IO", async () => {
    const item = await submitted(), value = response(); await item.repo.record(context, item.claim, value, receipt(value));
    const proxy = Object.create(storage) as Storage;
    proxy.readPrivate = async (...args: Parameters<Storage["readPrivate"]>) => { const bytes = await storage.readPrivate(...args); await grant([]); return bytes; };
    await expect(recovery(proxy).read(context, item.claim)).rejects.toMatchObject({ status: 403 });
    expect((await read(item.claim.id)).completionEvidence).toBeNull();
  });
  it("does not record unknown cost as zero or release its original occupied budget", async () => {
    const item = await submitted(), value = response(); await item.repo.record(context, item.claim, value, receipt(value));
    const row = await read(item.claim.id); expect(row.receipt?.costUsd).toBeNull();
    const [ledger] = await withTenant(database.db, context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.id, row.budgetLedgerId!)));
    expect(ledger).toMatchObject({ state: "reserved", amountUsd: "0.100000" });
  });
  it("records an overrun and blocks later calls using the underestimated model budget", async () => {
    const item = await submitted(), value = response(); await item.repo.record(context, item.claim, value, receipt(value, 0.12345678));
    const next = await operation(item.billing.modelKey), claim = (await recovery().claim(context, next.op))!;
    await expect(recovery().markSubmitted(context, claim, next.billing)).rejects.toThrow("CREATIVE_PRIOR_BUDGET_OVERRUN");
    const row = await read(item.claim.id);
    const [ledger] = await withTenant(database.db, context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.id, row.budgetLedgerId!)));
    expect(ledger?.amountUsd).toBe("0.123457");
  });
  it("does not upgrade or erase original submission, response or completion evidence", async () => {
    const item = await submitted(), value = response(); await item.repo.record(context, item.claim, value, receipt(value, 0.01));
    await item.repo.read(context, item.claim); await adopt(item.repo, item.claim);
    for (const patch of [{ submissionToken: createEntityId() }, { receipt: null }, { responseObjectKey: null }, { completionEvidence: null }, { phase: "pending" as const }])
      await expect(withTenant(database.db, context, tx => tx.update(creativeExecutions).set(patch).where(eq(creativeExecutions.id, item.claim.id)))).rejects.toThrow();
    const [generation] = await withTenant(database.db, context, tx => tx.select().from(creativeStudioGenerations).where(and(eq(creativeStudioGenerations.id, item.op.ownerId), eq(creativeStudioGenerations.status, "completed"))));
    expect(generation?.assetId).toBe((await read(item.claim.id)).completionEvidence!.artifacts[0]!.assetId);
  });
  it("keeps a submitted legacy video and its original receipt dormant with paid images off or enabled for its tenant", async () => {
    const item = await operation(undefined, false, "video"), repo = recovery(), claim = (await repo.claim(context, item.op))!;
    await repo.markSubmitted(context, claim, item.billing); await repo.rememberStudioTask(context, claim, "video_synthetic_original");
    const original = podInvocationReceipt({ modelKey: item.billing.modelKey, modelVersion: "synthetic-v1", costUsd: 0.02345678 }, "a".repeat(64), "video_synthetic_original");
    await repo.record(context, claim, undefined, original); await due(claim.id);
    const transport = vi.fn<typeof fetch>();
    const processor = new StudioGenerationProcessor(database, storage, modelVault, new HttpStudioGateway(transport, 1), new ClamAvScanner(), vault);
    const facts = () => withTenant(database.db, context, async tx => ({
      owner: await tx.select().from(creativeStudioGenerations).where(eq(creativeStudioGenerations.id, item.op.ownerId)),
      execution: await tx.select().from(creativeExecutions).where(eq(creativeExecutions.id, claim.id)),
      ledger: await tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, item.op.ownerId)),
    }));
    const before = await facts();
    expect(before.execution[0]).toMatchObject({ phase: "submitted", receipt: original, submissionToken: claim.submissionToken });
    expect(before.owner[0]?.providerTaskId).toBe("video_synthetic_original");
    expect(before.ledger).toHaveLength(1); expect(before.ledger[0]).toMatchObject({ state: "committed", amountUsd: "0.023457" });
    // The image opt-in cannot grant legacy video polling, claims or local adoption.
    // HttpStudioGateway's separate unit coverage retains the GET-only algorithm.
    for (const enabled of [false, true]) {
      admission(enabled);
      expect(await processor.process(job(item.op.ownerId))).toEqual({ id: item.op.ownerId,
        disposition: enabled ? "legacy_not_admitted" : "operator_paused" });
      expect(transport).not.toHaveBeenCalled(); expect(await facts()).toEqual(before);
    }
    await expect(withTenant(database.db, context, tx => tx.update(creativeStudioGenerations).set({ providerTaskId: "video_other" }).where(eq(creativeStudioGenerations.id, item.op.ownerId)))).rejects.toThrow();
  });
  it("keeps a quoted image's unknown original acknowledgement uncertain without submitting it again", async () => {
    const item = await paidOperation(), repo = recovery(), claim = (await repo.claim(context, item.op))!;
    await repo.markSubmitted(context, claim, item.billing); await due(claim.id);
    const transport = vi.fn<typeof fetch>();
    await new StudioGenerationProcessor(database, storage, modelVault, new HttpStudioGateway(transport), new ClamAvScanner(), vault).process(job(item.op.ownerId));
    expect(transport).not.toHaveBeenCalled(); expect((await read(claim.id)).phase).toBe("uncertain");
  });
  it("requires original submission evidence before remembering a provider video task", async () => {
    const item = await operation(undefined, false, "video"), repo = recovery(), claim = (await repo.claim(context, item.op))!;
    await expect(repo.rememberStudioTask(context, claim, "video_unsubmitted")).rejects.toThrow("CREATIVE_SUBMISSION_MISSING");
    await expect(withTenant(database.db, context, tx => tx.update(creativeStudioGenerations).set({ providerTaskId: "video_unsubmitted" }).where(eq(creativeStudioGenerations.id, item.op.ownerId)))).rejects.toThrow();
  });
  it("rejects a changed quoted image model route before any provider call", async () => {
    const item = await paidOperation();
    const disabled = await withTenant(database.db, context, tx => tx.update(modelRoutes).set({ status: "disabled" })
      .where(eq(modelRoutes.id, item.routeId)).returning({ id: modelRoutes.id, status: modelRoutes.status }));
    expect(disabled).toEqual([{ id: item.routeId, status: "disabled" }]);
    const transport = vi.fn<typeof fetch>();
    await expect(new StudioGenerationProcessor(database, storage, modelVault, new HttpStudioGateway(transport), new ClamAvScanner(), vault).process(job(item.op.ownerId))).rejects.toThrow("studio_generation_failed");
    expect(transport).not.toHaveBeenCalled(); expect((await read(item.execution.id)).submittedAt).toBeNull();
  });
  it("purges only expired original private bytes and unadopted outputs while retaining paid evidence and registered assets", async () => {
    const item = await submitted(), value = response(), bill = receipt(value, 0.02);
    await item.repo.record(context, item.claim, undefined, bill);
    const original = await read(item.claim.id), encrypted = Buffer.from(vault.encrypt(JSON.stringify({ version: 1, tenantId: context.tenantId,
      executionId: original.id, inputFingerprint: original.inputFingerprint, response: value })));
    const raw = await storage.putPrivate(context, { body: encrypted, domain: "quarantine", fileName: `${original.id}-pod-response.pe`, mediaType: "application/octet-stream" });
    const orphan = await storage.putPrivate(context, { body: Buffer.from("{}"), domain: "authorized", fileName: `${original.id}-pod-output-0.json`, mediaType: "application/json" });
    const registered = await storage.putPrivate(context, { body: image, domain: "authorized", fileName: `${original.id}-pod-output-1.png`, mediaType: "image/png" });
    expect(raw.objectKey).toBe(objectKey({ tenantId: context.tenantId, domain: "quarantine", sha256: hashPodResponse(encrypted), fileName: `${original.id}-pod-response.pe` }));
    const assetId = createEntityId();
    await withTenant(database.db, context, async tx => {
      await tx.insert(assetFiles).values({ id: assetId, tenantId: context.tenantId, ownerUserId: context.userId, objectKey: registered.objectKey,
        checksumSha256: registered.checksumSha256, byteSize: image.length, fileName: `${original.id}-pod-output-1.png`, assetDomain: "authorized",
        mediaType: "image/png", rightsStatus: "unverified", rightsMetadata: { source: { kind: "ai_generated", reference: "Synthetic registered history" } } });
      // First checkpoint assignment models an already-aged original; immutable deadlines are never edited.
      await tx.update(creativeExecutions).set({ phase: "response_staging", responseObjectKey: raw.objectKey, encryptedChecksum: raw.checksumSha256,
        responseChecksum: bill.responseChecksum, responseExpiresAt: sql`clock_timestamp()-interval '1 second'`, leaseToken: null, leaseExpiresAt: null,
        artifactManifest: [orphan, registered].map(output => ({ objectKey: output.objectKey, checksumSha256: output.checksumSha256 })) }).where(eq(creativeExecutions.id, original.id));
    });
    expect(await item.repo.purgeExpired(context, ["mockup_render"])).toBe(0);
    expect(await item.repo.purgeExpired(context, ["studio_generation"])).toBe(1);
    for (const [key, domain] of [[raw.objectKey, "quarantine"], [orphan.objectKey, "authorized"]] as const)
      await expect(storage.readPrivate(context, { id: original.id, tenantId: context.tenantId, objectKey: key, assetDomain: domain }, { requiredDomain: domain })).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
    expect(await storage.readPrivate(context, { id: assetId, tenantId: context.tenantId, objectKey: registered.objectKey, assetDomain: "authorized" }, { requiredDomain: "authorized" })).toEqual(new Uint8Array(image));
    const retained = await read(original.id); expect(retained.receipt).toEqual(bill); expect(retained.responsePurgedAt).toBeInstanceOf(Date);
    const [ledger] = await withTenant(database.db, context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.id, retained.budgetLedgerId!)));
    expect(ledger).toMatchObject({ state: "committed", amountUsd: "0.020000" });
  });

  it.each(["artifact_uploaded", "submission_unknown", "authority_revoked"] as const)(
    "recovers the original across an actual killed Worker process: %s", async mode => {
      let requests = 0;
      const server = createServer(async (request, reply) => {
        if (request.url !== "/v1/images/generations" || request.method !== "POST") { reply.writeHead(404).end(); return; }
        for await (const chunk of request) void chunk;
        requests++;
        if (mode !== "submission_unknown") reply.writeHead(200, { "content-type": "application/json", "x-request-id": "synthetic-creative-process" })
          .end(JSON.stringify({ model: "synthetic-reported-v1", costUsd: 0.02345678, data: [{ b64_json: image.toString("base64") }] }));
      });
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Synthetic recovery server missing");
      const endpoint = `http://127.0.0.1:${address.port}/v1`;
      const queueName = `${QueueName.StudioGeneration}-${createEntityId()}` as typeof QueueName.StudioGeneration;
      const queue = createQueue(queueName), probes: Array<{ stop: () => Promise<void> }> = [];
      const waitFor = async (check: () => Promise<boolean>) => {
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) { if (await check()) return; await delay(50); }
        throw new Error("Creative process acceptance checkpoint timed out");
      };
      try {
        const item = await paidOperation(endpoint);
        const launch = (hold = false) => {
          const child = spawn(process.execPath, ["--import", "./apps/api/node_modules/tsx/dist/loader.mjs", "tools/testing/creative-recovery-worker.mts"], {
            cwd: fileURLToPath(new URL("../../../../", import.meta.url)), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
              ...process.env, CREATIVE_RECOVERY_PROBE_QUEUE: queueName, CREATIVE_RECOVERY_PROBE_EXECUTION: item.execution.id,
              CREATIVE_RECOVERY_PROBE_URL: endpoint, CREATIVE_RECOVERY_PROBE_HOLD: hold ? "1" : "0",
              CREATIVE_RECOVERY_PROBE_TENANT: context.tenantId, CREATIVE_RECOVERY_PROBE_ACTOR: context.userId,
              CREATIVE_RECOVERY_PROBE_GENERATION: item.op.ownerId,
            },
          });
          let stdout = "", stopped = false;
          child.stdout.on("data", chunk => { stdout = (stdout + String(chunk)).slice(-12000); }); child.stderr.resume();
          const closed = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => { stopped = true; resolve(); }); });
          const stop = async () => { if (!stopped) child.kill("SIGKILL"); await closed; };
          const phase = (value: string) => waitFor(async () => {
            if (stopped) throw new Error("Creative recovery Worker exited before its checkpoint");
            return stdout.includes(`"phase":"${value}"`);
          });
          const probe = { child, stop, phase }; probes.push(probe); return probe;
        };
        const first = launch(true); await first.phase("ready");
        await enqueueJob(queue, "studio-generation.execute", job(item.op.ownerId));
        if (mode === "submission_unknown") await waitFor(async () => requests === 1);
        else await first.phase("artifact_uploaded");
        const before = await read(item.execution.id);
        expect(before.phase).toBe(mode === "submission_unknown" ? "submitted" : "response_ready");
        expect(before.completionEvidence).toBeNull(); expect(requests).toBe(1);
        await first.stop(); expect(first.child.exitCode !== null || first.child.signalCode !== null).toBe(true);
        await due(item.execution.id);
        if (mode === "authority_revoked") await grant(Object.values(Permission).filter(permission => permission !== Permission.DesignWrite));
        // Only the first process is held after upload; the restarted process uses the same persisted original.
        const second = launch();
        await second.phase("ready"); expect(second.child.pid).not.toBe(first.child.pid);
        await enqueueJob(queue, "studio-generation.execute", job(item.op.ownerId));
        await waitFor(async () => ["completed", "uncertain", "failed"].includes((await read(item.execution.id)).phase));
        const final = await read(item.execution.id);
        expect(requests).toBe(1); expect(final.submissionToken).toBe(before.submissionToken);
        expect(final.responseObjectKey).toBe(before.responseObjectKey); expect(final.receipt).toEqual(before.receipt);
        const budgets = await withTenant(database.db, context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, item.op.ownerId)));
        expect(budgets).toHaveLength(1);
        if (mode === "artifact_uploaded") {
          expect(final).toMatchObject({ phase: "completed", attemptCount: 2 });
          expect(budgets[0]).toMatchObject({ state: "committed", amountUsd: "0.023457" });
          const [generation] = await withTenant(database.db, context, tx => tx.select().from(creativeStudioGenerations).where(eq(creativeStudioGenerations.id, item.op.ownerId)));
          const [asset] = await withTenant(database.db, context, tx => tx.select().from(assetFiles).where(eq(assetFiles.id, generation!.assetId!)));
          expect(await storage.readPrivate(context, { ...asset!, assetDomain: "authorized" }, { requiredDomain: "authorized" })).toEqual(new Uint8Array(image));
        } else {
          expect(final.phase).toBe(mode === "submission_unknown" ? "uncertain" : "failed");
          expect(final.completionEvidence).toBeNull();
          expect(budgets[0]!.state).toBe(mode === "submission_unknown" ? "reserved" : "committed");
        }
      } finally {
        const stopped = await Promise.allSettled(probes.map(probe => probe.stop()));
        try { await queue.obliterate({ force: true }); } finally { await queue.close(); }
        server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        expect(stopped.every(result => result.status === "fulfilled")).toBe(true);
      }
    }, 90000,
  );
});
