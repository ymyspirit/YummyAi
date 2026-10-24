import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Permission } from "@yummyai/authz";
import { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { assetFiles, connectDatabase, designVersionFiles, designVersions, memberships, membershipRoles, migrateDatabase, podArtworkExecutions as executions, podArtworkInvocations as invocations, podArtworkTasks as tasks, recordAuditInTransaction, roles, withTenant } from "@yummyai/database";
import { createQueue, createTraceId, enqueueJob, QueueName, type JobEnvelope } from "@yummyai/jobs";
import { PodArtworkOwner } from "@yummyai/pod-core";
import { createStorageFromEnvironment, type Storage } from "@yummyai/storage";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { createWorker } from "../../../worker/src/main.js";
import { HttpPodArtworkGateway } from "../../../worker/src/processors/pod-artwork.http-gateway.js";
import { PodArtworkProcessor } from "../../../worker/src/processors/pod-artwork.processor.js";
import { DrizzlePodArtworkExecutionRepository } from "../../../worker/src/processors/pod-artwork.repository.js";
import { PodArtworkScheduler } from "../../../worker/src/processors/pod-artwork.scheduler.js";
import { DrizzleCatalogRepository, ProductService } from "../catalog/product.service.js";

if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname)) throw new Error("Use the disposable --suite=pod-response-integration runner");

describe("original POD response recovery under current authorization", () => {
  const database = connectDatabase(), storage = createStorageFromEnvironment();
  const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant" };
  const other = { ...context, tenantId: createEntityId(), userId: createEntityId() }, roleId = createEntityId();
  const vault = new SecretVault(new Uint8Array(32).fill(31));
  const product = new ProductService(new DrizzleCatalogRepository(database));
  const owner = (enqueue: (input: { taskId: string }) => Promise<void> = async () => {}) => new PodArtworkOwner(database, { enqueue }, { isToolEnabled: () => true }, { recordInTransaction: recordAuditInTransaction });
  const repository = (store: Storage = storage) => new DrizzlePodArtworkExecutionRepository(database, store, vault);
  let skuId: string, inputId: string, image: Buffer;

  beforeAll(async () => {
    await migrateDatabase(database);
    await storage.ensureBucket();
    for (const actor of [context, other]) {
      await database.client.unsafe("insert into organizations(id,name,slug)values($1,'Synthetic POD recovery',$2)", [actor.tenantId, `pod-recovery-${actor.tenantId}`]);
      await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic recovery operator')", [actor.userId, `pod-recovery-${actor.userId}`, `${actor.userId}@example.test`]);
      await withTenant(database.db, actor, async tx => {
        const member = createEntityId(), role = actor === context ? roleId : createEntityId();
        await tx.insert(memberships).values({ id: member, tenantId: actor.tenantId, userId: actor.userId, status: "active" });
        await tx.insert(roles).values({ id: role, tenantId: actor.tenantId, name: "Synthetic POD role", permissions: Object.values(Permission), dataScope: "tenant" });
        await tx.insert(membershipRoles).values({ tenantId: actor.tenantId, membershipId: member, roleId: role });
      });
    }
    const plan = await product.createPlan(context, { name: "Synthetic recovery product", sourceReportIds: [createEntityId()], customization: { version: 1, fields: [] } });
    await product.transition(context, plan.id, "pending_approval"); await product.transition(context, plan.id, "approved");
    const spu = await product.createSpu(context, plan.id, { code: `REC-${plan.id}`, name: "Synthetic recovery SPU" });
    skuId = (await product.createSku(context, { spuId: spu.id, code: `REC-${spu.id}`, attributes: {} })).id;
    image = await sharp({ create: { width: 40, height: 30, channels: 3, background: "blue" } }).png().toBuffer();
    const stored = await storage.putPrivate(context, { body: image, domain: "authorized", fileName: "synthetic-source.png", mediaType: "image/png" });
    inputId = createEntityId();
    await withTenant(database.db, context, tx => tx.insert(assetFiles).values({ id: inputId, tenantId: context.tenantId, ownerUserId: context.userId, objectKey: stored.objectKey, assetDomain: "authorized", fileName: "synthetic-source.png", mediaType: "image/png", byteSize: image.byteLength, checksumSha256: stored.checksumSha256, rightsStatus: "approved", rightsMetadata: { source: { kind: "owned", reference: "synthetic fixture" } } }));
  });
  afterAll(async () => { await database.client.end(); });

  async function task(enqueue?: (input: { taskId: string }) => Promise<void>) {
    return owner(enqueue).create(context, { skuId, idempotencyKey: createEntityId(), toolKey: "pattern_crop", title: "Synthetic original POD task", inputAssetIds: [inputId], parameterSnapshot: { mode: "general", multiCrop: false, maximumCropsPerInput: 1, outputFormat: "png", background: "preserved", perspectiveCorrection: true, cropPaddingPercent: 2 } });
  }
  const job = (taskId: string): JobEnvelope => ({ jobId: createEntityId(), idempotencyKey: createEntityId(), correlationId: taskId, traceId: createTraceId(), tenantId: context.tenantId, requestedBy: context.userId, requestedAt: new Date().toISOString(), attempt: 0, maxAttempts: 1, payload: { taskId } });
  async function row(id: string) { return withTenant(database.db, context, async tx => ({ task: (await tx.select().from(tasks).where(eq(tasks.id, id)))[0]!, execution: (await tx.select().from(executions).where(eq(executions.taskId, id)))[0]!, invocations: await tx.select().from(invocations).where(eq(invocations.taskId, id)) })); }
  async function due(id: string, expireLease = false) { await withTenant(database.db, context, tx => tx.update(executions).set({ nextAttemptAt: sql`clock_timestamp()-interval '1 second'`, lastDispatchedAt: null, ...(expireLease ? { leaseExpiresAt: sql`clock_timestamp()-interval '1 second'` } : {}) }).where(eq(executions.taskId, id))); }
  async function grant(permissions = Object.values(Permission)) { await withTenant(database.db, context, tx => tx.update(roles).set({ permissions }).where(eq(roles.id, roleId))); }
  function response() { return JSON.stringify({ outputs: [{ dataBase64: image.toString("base64"), mediaType: "image/png", role: "effect", fileName: "crop.png", metadata: { width: 40, height: 30, unit: "px", colorMode: "rgb", transparent: false, aiInference: "none" } }], modelKey: "pod.synthetic-crop", modelVersion: "fixture-v1", costUsd: 0.023, partial: false, qualityCheckSnapshot: { passed: true, mode: "general", inputCoverageComplete: true, cropBoundsValid: true, blankOutputsDetected: false, duplicateOutputsDetected: false, outputChecks: [{ fileName: "crop.png", inputOrdinal: 0, cropIndex: 0, sourceBounds: { x: 0, y: 0, width: 1, height: 1 }, outputWidth: 40, outputHeight: 30, transparent: false, perspectiveCorrectionValidated: true, cropComplete: true, resultLabel: "synthetic" }] } }); }
  function transport(before?: () => Promise<void>) {
    const request = vi.fn(async () => { await before?.(); return new Response(response(), { headers: { "x-request-id": "synthetic-original-request" } }); });
    return { request, gateway: new HttpPodArtworkGateway("https://synthetic.invalid/pod", "synthetic-key", request, 1024 * 1024, "synthetic-deployment-v1") };
  }
  function proxy(put: Storage["putPrivate"]): Storage { return new Proxy(storage, { get(target, key) { if (key === "putPrivate") return put; const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } }); }
  async function outputBytes(id: string) {
    const r = await row(id);
    const [file] = await withTenant(database.db, context, tx => tx.select({ asset: assetFiles, version: designVersions }).from(designVersions).innerJoin(designVersionFiles, eq(designVersionFiles.versionId, designVersions.id)).innerJoin(assetFiles, eq(assetFiles.id, designVersionFiles.assetFileId)).where(eq(designVersions.id, r.task.resultVersionId!)));
    expect(file!.version.status).toBe("pending_review"); expect(file!.asset.rightsStatus).toBe("unverified");
    expect(await storage.readPrivate(context, { id: file!.asset.id, tenantId: context.tenantId, assetDomain: "authorized", objectKey: file!.asset.objectKey }, { requiredDomain: "authorized" })).toEqual(Uint8Array.from(image));
  }

  it("keeps a failed Redis send queued and recovers its original intent through a real Worker", async () => {
    const created = await task(async () => { throw new Error("synthetic Redis unavailable"); });
    expect(created).toMatchObject({ status: "queued", errorCode: "QUEUE_UNAVAILABLE" });
    expect(created.invocations?.[0]).toMatchObject({ boundary: "not_submitted", processingAttempts: 0, billing: { basis: "not_submitted", needsProviderEvidence: false } });
    const queueName = `${QueueName.PodArtwork}-${createEntityId()}` as typeof QueueName.PodArtwork;
    const { gateway, request } = transport(), queue = createQueue(queueName);
    const scheduler = new PodArtworkScheduler(database, storage, queue, () => true, [context.tenantId]);
    const worker = createWorker(queueName, envelope => new PodArtworkProcessor(repository(), gateway).process(envelope));
    try {
      const send = vi.spyOn(queue, "add").mockRejectedValueOnce(new Error("synthetic transport failure"));
      expect((await scheduler.dispatch()).failed).toBe(1);
      send.mockRestore();
      expect((await row(created.id)).execution.lastDispatchedAt).toBeNull(); expect(request).not.toHaveBeenCalled();
      expect((await scheduler.dispatch()).queued).toBe(1);
      await waitFor(async () => (await row(created.id)).task.status === "awaiting_review");
      const deliveries = await queue.getJobs(["completed", "active", "waiting", "failed"]);
      expect(deliveries.filter(item => item.data.correlationId === created.id)).toHaveLength(1);
      expect(JSON.stringify(deliveries.map(item => item.data))).not.toContain("dataBase64");
      expect(request).toHaveBeenCalledOnce(); await outputBytes(created.id);
      expect((await row(created.id)).execution).toMatchObject({ phase: "completed", dispatchCount: 3, attemptCount: 1, leaseToken: null });
    } finally { await worker.close(); await scheduler.close(); }
  });

  it("resumes artifact persistence after an acknowledged upload is lost, with no second gateway call", async () => {
    const created = await task(), { request, gateway } = transport();
    let failed = false;
    const faulty = proxy(async (actor, input) => { const stored = await storage.putPrivate(actor, input); if (input.fileName.includes("-pod-output-") && !failed) { failed = true; throw new Error("synthetic lost output acknowledgement"); } return stored; });
    await expect(new PodArtworkProcessor(repository(faulty), gateway).process(job(created.id))).resolves.toMatchObject({ disposition: "deferred" });
    const interrupted = await row(created.id);
    expect(interrupted.task).toMatchObject({ status: "running", errorCode: "POD_RESPONSE_RECOVERY_PENDING", resultVersionId: null });
    expect(interrupted.execution.artifactManifest).toHaveLength(1);
    const receiptId = interrupted.invocations[0]!.id;
    await due(created.id);
    const forbidden = { prepare: vi.fn(() => { throw new Error("No new model preparation allowed"); }), execute: vi.fn() };
    await expect(new PodArtworkProcessor(repository(), forbidden).process(job(created.id))).resolves.toMatchObject({ disposition: "awaiting_review" });
    const final = await row(created.id);
    expect(request).toHaveBeenCalledOnce(); expect(forbidden.prepare).not.toHaveBeenCalled(); expect(forbidden.execute).not.toHaveBeenCalled();
    expect(final.execution).toMatchObject({ phase: "completed", attemptCount: 2 });
    expect(final.invocations).toHaveLength(1); expect(final.invocations[0]).toMatchObject({ id: receiptId, phase: "completed", reportedCostUsd: "0.02300000", providerRequestId: "synthetic-original-request" });
    const view = await owner().get(context, created.id);
    expect(view.invocations?.[0]).toMatchObject({ processingAttempts: 2, billing: { amountUsd: "0.02300000" } });
    expect(view.completion?.evidence).toMatchObject({ responseChecksum: interrupted.execution.responseChecksum, inputFingerprint: interrupted.execution.inputFingerprint, resultVersionId: final.task.resultVersionId, requiresBusinessReview: true, automaticProductionApproval: false });
    expect(final.execution.completionChecksum).toBe(view.completion?.checksum);
    expect(JSON.stringify(view)).not.toMatch(/response_object_key|pod-response\.pe|dataBase64|encryptedChecksum/);
    await outputBytes(created.id);
  });

  it("recovers an exact staged response when S3 succeeded before its acknowledgement was lost", async () => {
    const created = await task(), { request, gateway } = transport();
    const faulty = proxy(async (actor, input) => { const stored = await storage.putPrivate(actor, input); if (input.domain === "quarantine") throw new Error("synthetic lost response acknowledgement"); return stored; });
    await expect(new PodArtworkProcessor(repository(faulty), gateway).process(job(created.id))).resolves.toMatchObject({ disposition: "deferred" });
    const interrupted = await row(created.id);
    expect(interrupted.execution.phase).toBe("response_staging");
    const encrypted = await storage.readPrivate(context, { id: created.id, tenantId: context.tenantId, assetDomain: "quarantine", objectKey: interrupted.execution.responseObjectKey! }, { requiredDomain: "quarantine" });
    expect(Buffer.from(encrypted).toString()).not.toContain("dataBase64");
    expect(vault.withSecret(Buffer.from(encrypted).toString(), raw => JSON.parse(raw).checkpoint.rawBody)).toBe(response());
    await due(created.id);
    const forbidden = { execute: vi.fn() };
    await expect(new PodArtworkProcessor(repository(), forbidden).process(job(created.id))).resolves.toMatchObject({ disposition: "awaiting_review" });
    expect(request).toHaveBeenCalledOnce(); expect(forbidden.execute).not.toHaveBeenCalled(); await outputBytes(created.id);
  });

  it("stops after bounded local recovery if the staged response body was never uploaded", async () => {
    const created = await task(), { request, gateway } = transport();
    const faulty = proxy(async (actor, input) => { if (input.domain === "quarantine") throw new Error("synthetic unavailable upload"); return storage.putPrivate(actor, input); });
    await new PodArtworkProcessor(repository(faulty), gateway).process(job(created.id));
    const forbidden = { execute: vi.fn() }, processor = new PodArtworkProcessor(repository(), forbidden);
    await due(created.id); await expect(processor.process(job(created.id))).resolves.toMatchObject({ disposition: "deferred" });
    await due(created.id); await expect(processor.process(job(created.id))).rejects.toThrow();
    const final = await row(created.id);
    expect(final.task).toMatchObject({ status: "failed", errorCode: "POD_LOCAL_PROCESSING_FAILED", resultVersionId: null });
    expect(final.execution.attemptCount).toBe(3); expect(final.invocations[0]).toMatchObject({ phase: "failed", reportedCostUsd: "0.02300000" });
    expect(request).toHaveBeenCalledOnce(); expect(forbidden.execute).not.toHaveBeenCalled();
  });

  it("marks an expired submitted lease uncertain instead of purchasing a replacement", async () => {
    const created = await task(), repo = repository(), claim = await repo.claim(context, created.id, 0);
    await repo.markSubmitted(context, created.id, 0, claim);
    const { request, gateway } = transport(); await gateway.execute(context, (await repo.load(context, created.id))!, new AbortController().signal);
    await due(created.id, true);
    await expect(new PodArtworkProcessor(repository(), gateway).process(job(created.id))).resolves.toMatchObject({ disposition: "already_claimed" });
    expect((await row(created.id)).task).toMatchObject({ status: "failed", errorCode: "POD_RESULT_UNCERTAIN" });
    expect((await row(created.id)).invocations[0]).toMatchObject({ phase: "uncertain", receivedAt: null }); expect(request).toHaveBeenCalledOnce();
  });

  it("reclaims a crashed preparation, fences the stale token, and ignores application clock skew", async () => {
    const created = await task(), repo = repository(), stale = (await repo.claim(context, created.id, 0))!;
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 600_000);
    try { expect(await repo.claim(context, created.id, 0)).toBeUndefined(); } finally { vi.useRealTimers(); }
    await due(created.id, true);
    const fresh = (await repo.claim(context, created.id, 0))!;
    expect(fresh.token).not.toBe(stale.token);
    await expect(repo.markSubmitted(context, created.id, 0, stale)).rejects.toThrow("POD_EXECUTION_CLAIM_LOST");
    expect(await repo.fail(context, created.id, { attempt: 0, terminal: true, code: "INPUT_POLICY_BLOCKED", message: "stale" }, stale)).toBe("lost");
    await due(created.id, true);
    const { gateway, request } = transport();
    await expect(new PodArtworkProcessor(repo, gateway).process(job(created.id))).resolves.toMatchObject({ disposition: "awaiting_review" });
    expect(request).toHaveBeenCalledOnce(); expect((await row(created.id)).execution.attemptCount).toBe(3);
  });

  it("preserves the received bill and encrypted response when membership is revoked in flight", async () => {
    const created = await task(), { request, gateway } = transport(() => grant([]));
    try {
      await expect(new PodArtworkProcessor(repository(), gateway).process(job(created.id))).rejects.toThrow(/permission/);
      const final = await row(created.id);
      expect(final.task).toMatchObject({ status: "blocked", errorCode: "INPUT_POLICY_BLOCKED", resultVersionId: null });
      expect(final.execution.responseObjectKey).toBeTruthy(); expect(final.invocations[0]).toMatchObject({ phase: "failed", reportedCostUsd: "0.02300000" }); expect(request).toHaveBeenCalledOnce();
    } finally { await grant(); }
  });

  it("fences concurrent duplicate delivery and a stale artifact writer after safe takeover", async () => {
    const created = await task(), { request, gateway } = transport();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
    const slow = proxy(async (actor, input) => { const stored = await storage.putPrivate(actor, input); if (input.fileName.includes("-pod-output-")) { entered(); await held; } return stored; });
    const original = new PodArtworkProcessor(repository(slow), gateway).process(job(created.id));
    try {
      await reached;
      const forbidden = { execute: vi.fn() };
      expect(await new PodArtworkProcessor(repository(), forbidden).process(job(created.id))).toMatchObject({ disposition: "already_claimed" });
      await due(created.id, true);
      expect(await new PodArtworkProcessor(repository(), forbidden).process(job(created.id))).toMatchObject({ disposition: "awaiting_review" });
      expect(forbidden.execute).not.toHaveBeenCalled();
    } finally { release(); }
    expect(await original).toMatchObject({ disposition: "already_claimed" });
    expect(request).toHaveBeenCalledOnce();
    const versions = await withTenant(database.db, context, tx => tx.select().from(designVersions).where(eq(designVersions.taskId, created.designTaskId)));
    expect(versions).toHaveLength(1); expect((await row(created.id)).invocations).toHaveLength(1); await outputBytes(created.id);
  });

  it("checks encryption before submission and resumes preparation without losing the original task", async () => {
    const created = await task(), { request, gateway } = transport();
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("POD_EXECUTION_ENCRYPTION_KEY", "");
    try {
      await expect(new PodArtworkProcessor(new DrizzlePodArtworkExecutionRepository(database, storage), gateway).process(job(created.id))).resolves.toMatchObject({ disposition: "deferred" });
      const saved = await row(created.id);
      expect(saved.task.status).toBe("queued"); expect(saved.invocations[0]).toMatchObject({ phase: "pending", submittedAt: null, receivedAt: null }); expect(request).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
    await due(created.id); await new PodArtworkProcessor(repository(), gateway).process(job(created.id)); expect(request).toHaveBeenCalledOnce();
  });

  it("requires the live claim token at both submission and artifact adoption", async () => {
    const created = await task(), repo = repository(), claim = (await repo.claim(context, created.id, 0))!;
    const loaded = (await repo.load(context, created.id))!;
    await expect(repo.markSubmitted(context, created.id, 0)).rejects.toThrow("POD_EXECUTION_CLAIM_LOST");
    await expect(repo.complete(context, loaded, { outputs: [], modelKey: "synthetic", modelVersion: "v1", qualityCheckSnapshot: {}, partial: false })).rejects.toThrow("POD_EXECUTION_CLAIM_LOST");
    expect((await row(created.id)).task.resultVersionId).toBeNull();
    await repo.fail(context, created.id, { attempt: 0, terminal: true, code: "INPUT_POLICY_BLOCKED", message: "Synthetic fixture complete" }, claim);
  });

  it("recovers after killing the actual Worker process between S3 upload and business commit", async () => {
    const created = await task(), queueName = `${QueueName.PodArtwork}-${createEntityId()}` as typeof QueueName.PodArtwork, queue = createQueue(queueName);
    let requests = 0;
    const server = createServer(async (request, reply) => {
      if (request.url !== "/pod" || request.method !== "POST") { reply.writeHead(404).end(); return; }
      for await (const chunk of request) void chunk;
      requests++; reply.writeHead(200, { "content-type": "application/json", "x-request-id": "synthetic-process-crash-request" }).end(response());
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Synthetic probe address missing");
    type Probe = { child: ChildProcess; closed: Promise<void>; phase: (value: string) => Promise<void>; stop: () => Promise<void> };
    const processes: Probe[] = [];
    function launch(hold: boolean): Probe {
      const root = fileURLToPath(new URL("../../../../", import.meta.url));
      const child = spawn(process.execPath, ["--import", "./apps/api/node_modules/tsx/dist/loader.mjs", "tools/testing/pod-recovery-worker.mts"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, POD_EXECUTION_ENCRYPTION_KEY: Buffer.from(new Uint8Array(32).fill(31)).toString("base64url"), POD_RECOVERY_PROBE_QUEUE: queueName, POD_RECOVERY_PROBE_TASK: created.id, POD_RECOVERY_PROBE_URL: `http://127.0.0.1:${address && typeof address !== "string" ? address.port : 0}/pod`, POD_RECOVERY_PROBE_HOLD: hold ? "1" : "0" } });
      let stdout = "", stopped = false;
      child.stdout.on("data", chunk => { stdout = (stdout + String(chunk)).slice(-12_000); });
      child.stderr.resume();
      const closed = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => { stopped = true; resolve(); }); });
      const phase = async (value: string) => waitFor(async () => { if (stopped) throw new Error("POD probe exited before checkpoint"); return stdout.includes(`"phase":"${value}"`); });
      const stop = async () => { if (!stopped) child.kill("SIGKILL"); await closed; };
      const probe = { child, closed, phase, stop }; processes.push(probe); return probe;
    }
    try {
      const first = launch(true); await first.phase("ready");
      const envelope = job(created.id); await enqueueJob(queue, "pod-artwork.execute", envelope);
      await first.phase("artifact_uploaded");
      const before = await row(created.id);
      expect(before.task.resultVersionId).toBeNull(); expect(before.execution.phase).toBe("response_ready"); expect(requests).toBe(1);
      await first.stop(); expect(first.child.exitCode !== null || first.child.signalCode !== null).toBe(true);
      await due(created.id, true);
      const second = launch(false); await second.phase("ready");
      await enqueueJob(queue, "pod-artwork.execute", job(created.id));
      await waitFor(async () => (await row(created.id)).task.status === "awaiting_review");
      expect(requests).toBe(1);
      const final = await row(created.id);
      expect(final.invocations).toHaveLength(1); expect(final.invocations[0]).toMatchObject({ id: before.invocations[0]!.id, phase: "completed", providerRequestId: "synthetic-process-crash-request", reportedCostUsd: "0.02300000" });
      expect(final.execution).toMatchObject({ phase: "completed", attemptCount: 2, responseObjectKey: before.execution.responseObjectKey }); await outputBytes(created.id);
    } finally {
      await Promise.allSettled(processes.map(process => process.stop()));
      await queue.obliterate({ force: true }); await queue.close();
      server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("rechecks source authorization after output upload and never creates an approved version", async () => {
    const created = await task(), { gateway, request } = transport(); let revoked = false;
    const faulty = proxy(async (actor, input) => { const value = await storage.putPrivate(actor, input); if (input.fileName.includes("-pod-output-") && !revoked) { revoked = true; await withTenant(database.db, context, tx => tx.update(assetFiles).set({ rightsStatus: "rejected" }).where(eq(assetFiles.id, inputId))); } return value; });
    try {
      await expect(new PodArtworkProcessor(repository(faulty), gateway).process(job(created.id))).rejects.toThrow(/authorization/);
      expect((await row(created.id)).task).toMatchObject({ status: "blocked", resultVersionId: null }); expect(request).toHaveBeenCalledOnce();
    } finally { await withTenant(database.db, context, tx => tx.update(assetFiles).set({ rightsStatus: "approved" }).where(eq(assetFiles.id, inputId))); }
  });

  it("detects a tampered response checkpoint without entering the paid gateway", async () => {
    const created = await task(), { gateway, request } = transport();
    const faulty = proxy(async (actor, input) => { if (input.fileName.includes("-pod-output-")) throw new Error("synthetic output failure"); return storage.putPrivate(actor, input); });
    await due(created.id);
    await expect(new PodArtworkProcessor(repository(faulty), gateway).process(job(created.id))).resolves.toMatchObject({ disposition: "deferred" });
    const interrupted = await row(created.id);
    expect(interrupted.execution).toMatchObject({ phase: "response_ready", attemptCount: 1, leaseToken: null });
    expect(interrupted.execution.responseObjectKey).toBeTruthy();
    expect(interrupted.invocations[0]).toMatchObject({ phase: "received", reportedCostUsd: "0.02300000" });
    expect(request).toHaveBeenCalledOnce();
    await due(created.id);
    const tampered = new Proxy(storage, { get(target, key) { if (key === "readPrivate") return async (...args: Parameters<Storage["readPrivate"]>) => args[1].assetDomain === "quarantine" ? Uint8Array.from([1,2,3]) : target.readPrivate(...args); const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
    const forbidden = { execute: vi.fn() };
    await expect(new PodArtworkProcessor(repository(tampered), forbidden).process(job(created.id))).rejects.toThrow("POD_RESPONSE_INVALID");
    expect((await row(created.id)).task).toMatchObject({ status: "failed", errorCode: "POD_RESPONSE_INVALID", resultVersionId: null });
    expect(request).toHaveBeenCalledOnce(); expect(forbidden.execute).not.toHaveBeenCalled();
  });

  it("keeps recovery metadata tenant isolated and immutable, including the original receipt", async () => {
    const created = await task(), { gateway } = transport(); await new PodArtworkProcessor(repository(), gateway).process(job(created.id));
    expect(await withTenant(database.db, other, tx => tx.select().from(executions).where(eq(executions.taskId, created.id)))).toEqual([]);
    await expect(withTenant(database.db, context, tx => tx.update(executions).set({ responseObjectKey: "changed" }).where(eq(executions.taskId, created.id)))).rejects.toMatchObject({ cause: { code: "55000" } });
    await expect(withTenant(database.db, context, tx => tx.update(executions).set({ attemptCount: 0 }).where(eq(executions.taskId, created.id)))).rejects.toMatchObject({ cause: { code: "55000" } });
    await expect(withTenant(database.db, other, tx => tx.insert(executions).values({ taskId: createEntityId(), tenantId: other.tenantId, inputFingerprint: "a".repeat(64) }))).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(withTenant(database.db, context, tx => tx.execute(sql`delete from pod_artwork_executions where task_id=${created.id}`))).rejects.toMatchObject({ cause: { code: "42501" } });
    expect((await row(created.id)).invocations[0]?.reportedCostUsd).toBe("0.02300000");
  });

  it("purges an expired response and uncommitted artifacts while preserving committed bytes and tombstones", async () => {
    const created = await task();
    const raw = await storage.putPrivate(context, { body: Buffer.from(vault.encrypt("synthetic expired response")), domain: "quarantine", fileName: `${created.id}-pod-response.pe`, mediaType: "application/octet-stream" });
    const orphan = await storage.putPrivate(context, { body: Buffer.from("orphan"), domain: "authorized", fileName: `${created.id}-pod-output-0.txt`, mediaType: "text/plain" });
    const committed = await storage.putPrivate(context, { body: image, domain: "authorized", fileName: `${created.id}-pod-output-1.png`, mediaType: "image/png" });
    await withTenant(database.db, context, async tx => {
      await tx.insert(assetFiles).values({ id: createEntityId(), tenantId: context.tenantId, ownerUserId: context.userId, objectKey: committed.objectKey, assetDomain: "authorized", fileName: "retained-synthetic-output.png", mediaType: "image/png", byteSize: image.byteLength, checksumSha256: committed.checksumSha256, rightsStatus: "unverified", rightsMetadata: {} });
      const checksum = createHash("sha256").update("synthetic").digest("hex");
      await tx.insert(invocations).values({ id: createEntityId(), tenantId: context.tenantId, taskId: created.id, attemptNumber: 1, phase: "failed", submittedAt: new Date(), receivedAt: new Date(), finishedAt: new Date(), responseChecksum: checksum, metadataValid: false });
      await tx.update(executions).set({ phase: "failed", responseObjectKey: raw.objectKey, encryptedChecksum: raw.checksumSha256, responseChecksum: checksum, responseExpiresAt: sql`clock_timestamp()-interval '1 second'`, artifactManifest: [orphan, committed].map(({ objectKey, checksumSha256 }) => ({ objectKey, checksumSha256 })) }).where(eq(executions.taskId, created.id));
      await tx.update(tasks).set({ status: "failed", errorCode: "POD_LOCAL_PROCESSING_FAILED" }).where(eq(tasks.id, created.id));
    });
    expect(await repository().purgeExpiredResponses(context)).toBe(1);
    for (const [stored, domain] of [[raw, "quarantine"], [orphan, "authorized"]] as const) await expect(storage.readPrivate(context, { id: created.id, tenantId: context.tenantId, assetDomain: domain, objectKey: stored.objectKey }, { requiredDomain: domain })).rejects.toThrow();
    expect(await storage.readPrivate(context, { id: created.id, tenantId: context.tenantId, assetDomain: "authorized", objectKey: committed.objectKey }, { requiredDomain: "authorized" })).toEqual(Uint8Array.from(image));
    expect((await row(created.id)).execution).toMatchObject({ responseObjectKey: raw.objectKey, responsePurgedAt: expect.any(Date) });
    expect(await repository().purgeExpiredResponses(context)).toBe(0);
  });
});

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error("Synthetic POD worker did not reach its expected state");
}
