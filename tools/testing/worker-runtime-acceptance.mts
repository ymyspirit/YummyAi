import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import { createServer as createTcpServer, connect as tcpConnect, type Socket } from "node:net";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveWorkspacePath } from "../scripts/backup-restore.mjs";
import { inspectLocalWorkerQueues } from "../scripts/inspect-local-worker-queues.mts";
import { Permission } from "../../packages/authz/src/index.js";
import { createEntityId, type TenantContext } from "../../packages/contracts/src/index.js";
import { assetFiles, connectDatabase, designVersionFiles, designVersions, memberships, membershipRoles, podArtworkExecutions as executions, podArtworkInvocations as invocations, podArtworkTasks as tasks, recordAuditInTransaction, roles, withTenant } from "../../packages/database/src/index.js";
import { createQueue, createTraceId, enqueueJob, QueueName } from "../../packages/jobs/src/index.js";
import { PodArtworkOwner, RedisPodArtworkDispatcher } from "../../packages/pod-core/src/index.js";
import { createStorageFromEnvironment } from "../../packages/storage/src/index.js";
import { DrizzleCatalogRepository, ProductService } from "../../apps/api/src/catalog/product.service.js";
import { and, eq, sql } from "../../apps/api/node_modules/drizzle-orm/index.js";
import type Sharp from "../../apps/api/node_modules/sharp/lib/index.js";

// This is a standalone, disposable acceptance run. Never import into the shared
// parallel API suite: the actual standard Worker owns all enabled queue names.
const databaseUrl = new URL(process.env.DATABASE_URL!), bucket = process.env.S3_PRIVATE_BUCKET!;
if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(databaseUrl.pathname)
  || bucket !== `order-daily-e2e-${databaseUrl.pathname.slice("/order_daily_e2e_".length)}`) throw new Error("Unsafe full-Worker fixture");
const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2), outputArg = args.find(value => value.startsWith("--output-dir="));
if (args.length > 1 || args.some(value => value !== outputArg) || outputArg === "--output-dir=") throw new Error("Unsupported Worker acceptance argument");
const outputDirectory = await resolveWorkspacePath(root, outputArg?.slice("--output-dir=".length) || "tmp/worker-runtime-" + randomUUID(), { fresh: true });
await mkdir(outputDirectory, { recursive: true });
const database = connectDatabase(), storage = createStorageFromEnvironment();
const apiRequire = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const sharpModule = apiRequire("sharp");
const sharp = (sharpModule.default ?? sharpModule) as typeof Sharp;
const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant" };
const cases: Array<{ id: string; result: "pass"; detail: string }> = [];
const keys = Object.fromEntries(["MODEL_CREDENTIAL_ENCRYPTION_KEY", "ORDER_PII_ENCRYPTION_KEY", "MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY", "INTEGRATION_SECRET_ENCRYPTION_KEY", "KNOWLEDGE_EVIDENCE_ENCRYPTION_KEY", "POD_EXECUTION_ENCRYPTION_KEY"].map((key, index) => [key, Buffer.alloc(32, index + 40).toString("base64url")]));
type Event = { type?: string; state?: string; queues?: string[]; schedulers?: string[]; code?: string; clean?: boolean };
type Probe = { child: ChildProcess; events: Event[]; closed: Promise<number>; logs: () => string; ready: () => Promise<Event>; stop: (graceful?: boolean) => Promise<number> };
const children: Probe[] = [], requests = new Map<string, number>(), held = new Map<string, ServerResponse>();
let modelMode: "return" | "hold" = "return", sequence = 0, image: Buffer, skuId: string, inputId: string;
const modelServer = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/pod" || request.headers.authorization !== "Bearer synthetic-worker-runtime-only") { response.writeHead(404).end(); return; }
  let body = "";
  for await (const chunk of request) { body += String(chunk); if (body.length > 2 * 1024 * 1024) { response.writeHead(413).end(); return; } }
  const data = JSON.parse(body) as { taskId: string };
  assert.match(data.taskId, /^[a-f0-9-]{36}$/);
  requests.set(data.taskId, (requests.get(data.taskId) ?? 0) + 1);
  if (modelMode === "hold") held.set(data.taskId, response); else sendResult(data.taskId, response);
});
const dispatcher = new RedisPodArtworkDispatcher(), owner = new PodArtworkOwner(database, dispatcher, { isToolEnabled: () => true }, { recordInTransaction: recordAuditInTransaction });
let modelUrl = "";

function result() { return JSON.stringify({ outputs: [{ dataBase64: image.toString("base64"), mediaType: "image/png", role: "effect", fileName: "synthetic.png", metadata: { width: 40, height: 30, unit: "px", colorMode: "rgb", transparent: false, aiInference: "none" } }], modelKey: "pod.runtime-fixture", modelVersion: "runtime-v1", costUsd: 0.023, partial: false, qualityCheckSnapshot: { passed: true, mode: "general", inputCoverageComplete: true, cropBoundsValid: true, blankOutputsDetected: false, duplicateOutputsDetected: false, outputChecks: [{ fileName: "synthetic.png", inputOrdinal: 0, cropIndex: 0, sourceBounds: { x: 0, y: 0, width: 1, height: 1 }, outputWidth: 40, outputHeight: 30, transparent: false, perspectiveCorrectionValidated: true, cropComplete: true, resultLabel: "synthetic runtime fixture" }] } }); }
function sendResult(id: string, response: ServerResponse) { response.writeHead(200, { "content-type": "application/json", "x-request-id": `runtime-${id}` }).end(result()); held.delete(id); }
async function waitFor<T>(check: () => Promise<T | undefined | false>, timeout = 20_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error("Worker runtime acceptance deadline exceeded");
}
async function bounded<T>(promise: Promise<T>, timeout = 12_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Worker process did not terminate")), timeout); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function launch(overrides: NodeJS.ProcessEnv = {}): Probe {
  const child = spawn(process.execPath, ["--import", "./apps/api/node_modules/tsx/dist/loader.mjs", "apps/worker/src/run.ts"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, ...keys, NODE_ENV: "production", WORKER_STARTUP_TIMEOUT_MS: "5000", WORKER_SHUTDOWN_TIMEOUT_MS: "5000", WORKFLOW_CENTER_TENANT_IDS: context.tenantId, ORDER_RESPONSIBILITY_TENANT_IDS: context.tenantId, BUSINESS_FOLLOWUP_TENANT_IDS: context.tenantId, ORDER_DESIGN_AGENT_ENABLED: "true", POD_PROCESSOR_URL: modelUrl, POD_PROCESSOR_API_KEY: "synthetic-worker-runtime-only", POD_PROCESSOR_DEPLOYMENT_ID: "full-runtime-synthetic-v1", POD_ENABLED_TOOLS: "pattern_crop,text_to_image,canvas_extend", POD_ORDER_PROCESSOR_URL: modelUrl, POD_ORDER_PROCESSOR_API_KEY: "synthetic-worker-runtime-only", POD_ORDER_PROCESSOR_DEPLOYMENT_ID: "full-runtime-order-fixture", POD_ORDER_ENABLED_TOOLS: "image_composite", POD_BATCH_WORKFLOWS_ENABLED: "true", POD_MOCKUP_RENDERER_ENABLED: "true", ...overrides } });
  const events: Event[] = []; let output = "", finished = false;
  child.stdout!.on("data", chunk => { output = (output + String(chunk)).slice(-100_000); }); child.stderr!.on("data", chunk => { output = (output + String(chunk)).slice(-100_000); });
  child.on("message", value => { if (value && typeof value === "object" && "type" in value && value.type === "worker.lifecycle") events.push(value as Event); });
  const closed = new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", code => { finished = true; resolve(code ?? 1); }); });
  const probe: Probe = { child, events, closed, logs: () => output, ready: () => waitFor(async () => { if (finished) throw new Error("Standard Worker exited before ready"); return events.find(event => event.state === "ready"); }), stop: async (graceful = true) => { if (!finished) { if (graceful && child.connected) child.send("shutdown", () => undefined); else child.kill("SIGKILL"); } return bounded(closed); } };
  children.push(probe); return probe;
}
async function createTask() { return owner.create(context, { skuId, idempotencyKey: createEntityId(), toolKey: "pattern_crop", title: "Synthetic full runtime task", inputAssetIds: [inputId], parameterSnapshot: { mode: "general", multiCrop: false, maximumCropsPerInput: 1, outputFormat: "png", background: "preserved", perspectiveCorrection: true, cropPaddingPercent: 2 } }); }
async function row(id: string) { return withTenant(database.db, context, async tx => ({ task: (await tx.select().from(tasks).where(eq(tasks.id, id)))[0]!, execution: (await tx.select().from(executions).where(eq(executions.taskId, id)))[0]!, invocation: (await tx.select().from(invocations).where(and(eq(invocations.taskId, id), eq(invocations.attemptNumber, 1))))[0] })); }
async function expireLease(id: string) { await withTenant(database.db, context, tx => tx.update(executions).set({ leaseExpiresAt: sql`clock_timestamp()-interval '1 second'`, nextAttemptAt: sql`clock_timestamp()-interval '1 second'`, lastDispatchedAt: null }).where(eq(executions.taskId, id))); }
async function verifyOutput(id: string) {
  const current = await row(id); assert.equal(current.task.status, "awaiting_review"); assert.equal(current.invocation?.reportedCostUsd, "0.02300000"); assert.equal(current.invocation?.providerRequestId, `runtime-${id}`);
  const files = await withTenant(database.db, context, tx => tx.select({ version: designVersions, asset: assetFiles }).from(designVersions).innerJoin(designVersionFiles, eq(designVersionFiles.versionId, designVersions.id)).innerJoin(assetFiles, eq(assetFiles.id, designVersionFiles.assetFileId)).where(eq(designVersions.taskId, current.task.designTaskId)));
  assert.equal(files.length, 1); assert.equal(files[0]!.version.status, "pending_review"); assert.equal(files[0]!.asset.rightsStatus, "unverified");
  assert.deepEqual(await storage.readPrivate(context, { id: files[0]!.asset.id, tenantId: context.tenantId, assetDomain: "authorized", objectKey: files[0]!.asset.objectKey }, { requiredDomain: "authorized" }), Uint8Array.from(image));
}
function pass(id: string, detail: string) { cases.push({ id, result: "pass", detail }); process.stdout.write(JSON.stringify({ runtimeCase: id, result: "pass" }) + "\n"); }

try {
  // Explicit fixture setup owns this guarded disposable bucket. The standard
  // Worker only checks readiness and must never create deployment resources.
  await storage.ensureBucket();
  await storage.assertBucketReady();
  await database.client.unsafe("insert into organizations(id,name,slug)values($1,'Synthetic full runtime',$2)", [context.tenantId, `runtime-${context.tenantId}`]);
  await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic runtime operator')", [context.userId, `runtime-${context.userId}`, `${context.userId}@example.test`]);
  await withTenant(database.db, context, async tx => {
    const member = createEntityId(), role = createEntityId();
    await tx.insert(memberships).values({ id: member, tenantId: context.tenantId, userId: context.userId, status: "active" });
    await tx.insert(roles).values({ id: role, tenantId: context.tenantId, name: "Synthetic runtime role", permissions: Object.values(Permission), dataScope: "tenant" });
    await tx.insert(membershipRoles).values({ tenantId: context.tenantId, membershipId: member, roleId: role });
  });
  const product = new ProductService(new DrizzleCatalogRepository(database)), plan = await product.createPlan(context, { name: "Synthetic runtime product", sourceReportIds: [createEntityId()], customization: { version: 1, fields: [] } });
  await product.transition(context, plan.id, "pending_approval"); await product.transition(context, plan.id, "approved");
  const spu = await product.createSpu(context, plan.id, { code: `RT-${plan.id}`, name: "Synthetic runtime SPU" }); skuId = (await product.createSku(context, { spuId: spu.id, code: `RT-${spu.id}`, attributes: {} })).id;
  image = await sharp({ create: { width: 40, height: 30, channels: 3, background: "blue" } }).png().toBuffer();
  const asset = await storage.putPrivate(context, { body: image, domain: "authorized", fileName: "runtime-source.png", mediaType: "image/png" }); inputId = createEntityId();
  await withTenant(database.db, context, tx => tx.insert(assetFiles).values({ id: inputId, tenantId: context.tenantId, ownerUserId: context.userId, objectKey: asset.objectKey, assetDomain: "authorized", fileName: "runtime-source.png", mediaType: "image/png", byteSize: image.byteLength, checksumSha256: asset.checksumSha256, rightsStatus: "approved", rightsMetadata: { source: { kind: "owned", reference: "synthetic acceptance fixture" } } }));
  modelServer.listen(0, "127.0.0.1"); await once(modelServer, "listening"); const address = modelServer.address(); assert(address && typeof address !== "string"); modelUrl = `http://127.0.0.1:${address.port}/pod`;

  const [last] = await database.client.unsafe("select id,hash from drizzle.__drizzle_migrations order by created_at desc,id desc limit 1"); assert(last);
  try { await database.client.unsafe("update drizzle.__drizzle_migrations set hash=$1 where id=$2", ["0".repeat(64), last.id]); const child = launch(); assert.equal(await bounded(child.closed), 1); assert(!child.events.some(event => event.state === "ready")); pass("W01", "Migration drift rejects startup without migrating or consuming"); }
  finally { await database.client.unsafe("update drizzle.__drizzle_migrations set hash=$1 where id=$2", [last.hash, last.id]); }

  const absentBucket = launch({ S3_PRIVATE_BUCKET: `${bucket}-missing` }); assert.equal(await bounded(absentBucket.closed), 1); assert(!absentBucket.events.some(event => event.state === "ready")); pass("W02", "Missing private bucket rejects startup without creating it");

  const workflowQueue = createQueue(QueueName.WorkflowNode), identity = createEntityId();
  try {
    await enqueueJob(workflowQueue, "workflow.execute", { jobId: identity, idempotencyKey: identity, correlationId: identity, tenantId: context.tenantId, requestedBy: context.userId, traceId: createTraceId(), requestedAt: new Date().toISOString(), attempt: 0, maxAttempts: 1, payload: { runId: createEntityId(), nodeRunId: createEntityId(), attemptId: createEntityId() } });
    const lateFailure = launch({ MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY: "invalid" }); assert.equal(await bounded(lateFailure.closed), 1); assert(!lateFailure.events.some(event => event.state === "ready"));
    const pending = await workflowQueue.getJob(identity); assert.equal(await pending?.getState(), "waiting"); await pending!.remove(); pass("W03", "Late assembly failure closes earlier resources before any job is consumed");
  } finally { await workflowQueue.close(); }

  modelMode = "hold"; const draining = launch(), ready = await draining.ready();
  const reserved = new Set(["ai-analysis", "capture", "export", "metrics", "order-ingestion"]), expected = Object.values(QueueName).filter(name => !reserved.has(name)).sort();
  assert.equal(expected.length, 27); assert.deepEqual([...ready.queues!].sort(), expected); assert.equal(ready.schedulers?.length, 10);
  const active = await createTask(); await waitFor(async () => held.has(active.id));
  draining.child.send("shutdown", () => undefined); await waitFor(async () => draining.events.some(event => event.state === "stopping"));
  assert.equal(draining.child.exitCode, null); sendResult(active.id, held.get(active.id)!); assert.equal(await bounded(draining.closed), 0); await verifyOutput(active.id); assert.equal(requests.get(active.id), 1); pass("W04", "All 27 consumers ready; graceful stop drains active POD before closing database");

  const timed = launch({ WORKER_SHUTDOWN_TIMEOUT_MS: "1000" }); await timed.ready(); const pending = await createTask(); await waitFor(async () => held.has(pending.id));
  assert.equal(await timed.stop(), 1); assert(timed.events.some(event => event.state === "stopped" && event.clean === false));
  const before = await row(pending.id); assert.equal(before.task.status, "running"); assert(before.invocation?.submittedAt); await expireLease(pending.id); modelMode = "return";
  const reconciling = launch(); await reconciling.ready(); await waitFor(async () => (await row(pending.id)).task.status === "failed"); assert.equal((await row(pending.id)).task.errorCode, "POD_RESULT_UNCERTAIN"); assert.equal(requests.get(pending.id), 1); assert.equal(await reconciling.stop(), 0); pass("W05", "Bounded stop preserves submission uncertainty and restart does not purchase again");

  const upstream = new URL(process.env.S3_ENDPOINT!); assert.equal(upstream.protocol, "http:"); assert(["127.0.0.1", "localhost"].includes(upstream.hostname));
  let uploaded!: () => void; const outputUploaded = new Promise<void>(resolve => { uploaded = resolve; });
  const storageProxy = createServer((request, response) => {
    if (!(request.url === `/${bucket}` || request.url?.startsWith(`/${bucket}/`))) { response.writeHead(403).end(); return; }
    const forward = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: request.url, method: request.method, headers: request.headers }, remote => {
      if (request.method === "PUT" && request.url?.includes("-pod-output-")) { remote.resume(); remote.once("end", () => { if ((remote.statusCode ?? 500) < 300) uploaded(); }); }
      else { response.writeHead(remote.statusCode ?? 502, remote.headers); remote.pipe(response); }
    });
    forward.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); }); request.pipe(forward);
  });
  try {
    storageProxy.listen(0, "127.0.0.1"); await once(storageProxy, "listening"); const proxyAddress = storageProxy.address(); assert(proxyAddress && typeof proxyAddress !== "string");
    const first = launch({ S3_ENDPOINT: `http://127.0.0.1:${proxyAddress.port}` }); await first.ready(); const recovering = await createTask(); await bounded(outputUploaded);
    const saved = await row(recovering.id); assert.equal(saved.execution.phase, "response_ready"); assert.equal(saved.task.resultVersionId, null); assert.equal(requests.get(recovering.id), 1);
    await first.stop(false); await expireLease(recovering.id);
    const second = launch(); await second.ready(); await waitFor(async () => (await row(recovering.id)).task.status === "awaiting_review");
    const restored = await row(recovering.id); assert.equal(restored.execution.attemptCount, 2); assert.equal(restored.execution.responseObjectKey, saved.execution.responseObjectKey); assert.equal(restored.invocation?.id, saved.invocation?.id); assert.equal(requests.get(recovering.id), 1); await verifyOutput(recovering.id); assert.equal(await second.stop(), 0); pass("W06", "Actual standard Worker killed after S3 upload; another standard process reuses original response, artifact and fee");
  } finally { storageProxy.closeAllConnections(); await new Promise<void>(resolve => storageProxy.close(() => resolve())); }

  const redisUpstream = new URL(process.env.REDIS_URL!), sockets = new Set<Socket>();
  const redisProxy = createTcpServer(socket => { const forward = tcpConnect(Number(redisUpstream.port), redisUpstream.hostname); sockets.add(socket); sockets.add(forward); socket.pipe(forward); forward.pipe(socket); const stop = () => { socket.destroy(); forward.destroy(); sockets.delete(socket); sockets.delete(forward); }; socket.on("error", stop); forward.on("error", stop); socket.on("close", stop); forward.on("close", stop); });
  redisProxy.listen(0, "127.0.0.1"); await once(redisProxy, "listening"); const redisAddress = redisProxy.address(); assert(redisAddress && typeof redisAddress !== "string");
  const proxyUrl = new URL(redisUpstream); proxyUrl.hostname = "127.0.0.1"; proxyUrl.port = String(redisAddress.port);
  const faulted = launch({ REDIS_URL: proxyUrl.toString(), WORKER_SHUTDOWN_TIMEOUT_MS: "1000" });
  try { await faulted.ready(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => redisProxy.close(() => resolve())); assert.equal(await bounded(faulted.closed), 1); assert(faulted.events.some(event => event.code === "WORKER_CONNECTION_ERROR")); pass("W07", "Real Redis connection loss is handled and terminates the supervised runtime"); }
  finally { for (const socket of sockets) socket.destroy(); if (redisProxy.listening) await new Promise<void>(resolve => redisProxy.close(() => resolve())); }
  const unreachable = launch({ REDIS_URL: proxyUrl.toString(), WORKER_STARTUP_TIMEOUT_MS: "1000", WORKER_SHUTDOWN_TIMEOUT_MS: "1000" }); assert.equal(await bounded(unreachable.closed), 1); assert(!unreachable.events.some(event => event.state === "ready")); pass("W08", "Unreachable Redis never reports ready and startup has a deadline");

  const profileQueue = createQueue(QueueName.WorkflowNode), profileJob = createEntityId();
  try {
    await enqueueJob(profileQueue, "workflow.execute", { jobId: profileJob, idempotencyKey: profileJob, correlationId: profileJob, tenantId: context.tenantId, requestedBy: context.userId, traceId: createTraceId(), requestedAt: new Date().toISOString(), attempt: 0, maxAttempts: 1, payload: { runId: createEntityId(), nodeRunId: createEntityId(), attemptId: createEntityId() } });
    const invalidUnusedKeys = { MODEL_CREDENTIAL_ENCRYPTION_KEY: "invalid", ORDER_PII_ENCRYPTION_KEY: "invalid", MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY: "invalid", INTEGRATION_SECRET_ENCRYPTION_KEY: "invalid", KNOWLEDGE_EVIDENCE_ENCRYPTION_KEY: "invalid", POD_EXECUTION_ENCRYPTION_KEY: "invalid" };
    const mediaOnly = launch({ ...invalidUnusedKeys, WORKER_QUEUES: "media", WORKER_SCHEDULERS: undefined }), mediaReady = await mediaOnly.ready();
    assert.deepEqual(mediaReady.queues, [QueueName.Media]); assert.deepEqual(mediaReady.schedulers, ["captureMediaScheduler"]);
    assert.equal(await (await profileQueue.getJob(profileJob))?.getState(), "waiting"); assert.equal(await mediaOnly.stop(), 0);
    pass("W09", "Media-only process ignores unrelated invalid credentials and leaves an unselected workflow waiting");

    modelMode = "return";
    const consumerOnly = launch({ WORKER_QUEUES: "pod-artwork", WORKER_SCHEDULERS: "none" }), consumerReady = await consumerOnly.ready();
    assert.deepEqual(consumerReady.queues, [QueueName.PodArtwork]); assert.deepEqual(consumerReady.schedulers, []);
    const selectedTask = await createTask(); await waitFor(async () => (await row(selectedTask.id)).task.status === "awaiting_review"); await verifyOutput(selectedTask.id);
    assert.equal(requests.get(selectedTask.id), 1); assert.equal(await consumerOnly.stop(), 0);
    pass("W10", "Selected consumer without timers produces the original checked artifact exactly once");

    const timerOnly = launch({ ...invalidUnusedKeys, WORKER_QUEUES: "none", WORKER_SCHEDULERS: "workflowAttentionScheduler" }), timerReady = await timerOnly.ready();
    assert.deepEqual(timerReady.queues, []); assert.deepEqual(timerReady.schedulers, ["workflowAttentionScheduler"]);
    assert.equal(await (await profileQueue.getJob(profileJob))?.getState(), "waiting"); assert.equal(await timerOnly.stop(), 0);
    pass("W11", "An explicitly selected attention timer does not construct consumers or unrelated encrypted domains");

    for (const selection of [{ WORKER_QUEUES: "media", WORKER_SCHEDULERS: "workflowNodeScheduler" }, { WORKER_QUEUES: "order-design", ORDER_DESIGN_AGENT_ENABLED: "false" }]) {
      const invalid = launch({ ...selection, DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/unreachable" });
      assert.equal(await bounded(invalid.closed), 1); assert(!invalid.events.some(event => event.state === "ready"));
      assert(invalid.events.some(event => event.code === "WORKER_RUNTIME_SELECTION_INVALID"));
    }
    assert.equal(await (await profileQueue.getJob(profileJob))?.getState(), "waiting");
    await (await profileQueue.getJob(profileJob))!.remove();
    pass("W12", "Unowned timers and unavailable optional consumers fail selection before opening a database");
  } finally { await profileQueue.close(); }

  const inventory = await inspectLocalWorkerQueues({ includeDurable: true });
  assert(inventory.durable?.transactionReadOnly && inventory.durable.databaseSnapshotConsistent);
  assert.equal(inventory.durable.rowPayloadsRead, false); assert.equal(inventory.workerStartAuthorized, false);
  const artworkStates = inventory.durable.tables.find(table => table.table === "pod_artwork_tasks")!.states;
  assert.equal(artworkStates.reduce((sum, state) => sum + Number(state.count), 0), 4);
  assert(!JSON.stringify(inventory).includes(context.tenantId) && !JSON.stringify(inventory).includes(context.userId));
  pass("W13", "Read-only durable inventory reports retained work without exposing row payloads or granting startup");
  for (const child of children) { const logs = child.logs(); for (const key of Object.values(keys)) assert(!logs.includes(key)); }
  assert.equal([...requests.values()].reduce((sum, value) => sum + value, 0), 4);
} finally {
  await Promise.allSettled(children.map(child => child.stop(false)));
  for (const response of held.values()) response.destroy(); modelServer.closeAllConnections(); if (modelServer.listening) await new Promise<void>(resolve => modelServer.close(() => resolve()));
  await dispatcher.close(); await database.client.end();
  for (const child of children) await writeFile(path.join(outputDirectory, `child-${++sequence}.log`), child.logs());
  await writeFile(path.join(outputDirectory, "runtime-proof.json"), JSON.stringify({ standaloneStandardRunTs: true, cases, childProcesses: children.length, childrenTerminal: children.every(child => child.child.exitCode !== null || child.child.signalCode !== null), modelRequests: [...requests].map(([taskId, count]) => ({ taskId, count })), realPaidCalls: 0 }, null, 2));
}
assert.equal(cases.length, 13);
process.stdout.write(JSON.stringify({ runtimeCasesPassed: cases.length, standardConsumersVerified: 27, childProcesses: children.length, syntheticModelRequests: 4, realPaidCalls: 0, outputDirectory }) + "\n");
