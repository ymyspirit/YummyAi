import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";
import { assertOwnedRestartPostgres, restartOwnedPostgres, type OwnedRestartPostgres } from "./isolated-postgres.mts";
import { Permission } from "../../packages/authz/src/index.js";
import type { TenantContext } from "../../packages/contracts/src/index.js";
import { normalizeProductionCommand, ProductionCommandViewSchema, ProductionCommandListSchema,
  type PrepareProductionCommand } from "../../packages/contracts/src/order/production-command.js";
import { WholeOrderFulfillmentViewSchema } from "../../packages/contracts/src/order/whole-fulfillment.js";
import type { OrderWorkDetail } from "../../packages/contracts/src/order/workspace.js";
import { connectDatabase, withTenant, productionCommandIntents, productionCommandAttempts, productionOrders,
  productionOrderVersions, productionManufacturingBindings, manufacturingRecipes, manufacturingRecipeVersions, orderDesignAgentRuns } from "../../packages/database/src/index.js";
import { productionCommandDescriptor } from "../../apps/api/src/orders/production-command-fence.js";
import { prepareNativeProduction } from "../../apps/web/e2e/native-production-fixture.js";
import { prepareDeliveryOrder } from "../../apps/web/e2e/production-delivery-fixture.js";
import { startProductionEditorWorker, stopProductionEditorWorker } from "../../apps/web/e2e/production-editor-fixture.js";
import { actors } from "../../apps/web/e2e/erp-identity-fixture.js";
import { centerApi } from "../../apps/web/e2e/order-centers-fixture.js";

// Refuse ordinary databases and unowned containers before opening a connection.
const databaseUrl = new URL(requireDisposableIntegrationEnvironment());
const identity = JSON.parse(process.env.YUMMYAI_RESTART_POSTGRES ?? "null") as OwnedRestartPostgres | null;
assert.ok(identity, "Dedicated restart container is required");
await assertOwnedRestartPostgres(identity);
assert.equal(databaseUrl.hostname, "127.0.0.1");
assert.equal(Number(databaseUrl.port), identity.port);
assert.equal(process.env.API_BASE_URL, "http://127.0.0.1:8130");
assert.ok(process.env.API_ACCESS_TOKEN && process.env.ERP_FIXTURE_ACTORS);
const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.resolve(process.env.YUMMYAI_TEST_CACHE_DIR!);
const relativeOutput = path.relative(path.join(root, "tmp"), output);
assert.ok(relativeOutput && !relativeOutput.startsWith("..") && !path.isAbsolute(relativeOutput));
assert.ok(!(await fs.lstat(output)).isSymbolicLink());
const evidencePath = path.join(output, "production-restart-proof.json");
await fs.writeFile(evidencePath, "{}\n", { flag: "wx" });
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const { sql, eq, inArray } = require("drizzle-orm");
const actor = actors().operator;
const context: TenantContext = { tenantId: actor.tenantId, userId: actor.userId, permissions: Object.values(Permission), dataScope: "tenant" };
const database = connectDatabase();
const proof: Record<string, unknown> = { startedAt: new Date().toISOString(), postgres: identity, cases: [], apiProcesses: [], postgresRestarts: [],
  ordinaryDatabaseRestarted: false, ordinaryWorkerStarted: false, fixtureOnly: true, factoryContacted: false,
  manufacturingRule: "ps-pillow-2026-09-17", automaticAgentRuleSnapshot: "not_applicable_human_executor_no_agent_run_no_backfill" };
let step = "initializing", api: ChildProcess | undefined, worker: ChildProcess | undefined;
let apiIndex = 0;
const releases: Array<() => void> = [];
const connections: ReturnType<typeof connectDatabase>[] = [];
const save = () => fs.writeFile(evidencePath, JSON.stringify(proof, null, 2) + "\n");
async function pass(name: string, details?: unknown) {
  (proof.cases as unknown[]).push({ name, passedAt: new Date().toISOString(), details }); await save();
  process.stdout.write(JSON.stringify({ productionRestartCase: name, result: "pass" }) + "\n");
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function poll<T>(read: () => Promise<T>, valid: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (true) { const value = await read(); if (valid(value)) return value; if (Date.now() >= until) throw Error(`Timed out at ${step}`); await delay(100); }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function waitSignal<T>(signal: Promise<T>, done: Promise<unknown>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([signal, done.then(() => { throw Error(`Lock failed at ${step}`); }),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`Lock timed out at ${step}`)), 30_000); })]); }
  finally { clearTimeout(timer!); }
}
async function request(resource: string, input?: unknown) {
  const response = await fetch(`${process.env.API_BASE_URL}/v1/${resource}`, { method: input === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}`, ...(input === undefined ? {} : { "content-type": "application/json" }) },
    body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(90_000) });
  assert.ok(response.ok, `HTTP ${response.status} at ${step}`);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return response.json();
}
const commandGet = async (id: string) => ProductionCommandViewSchema.parse(await request(`order-centers/production-commands/${id}`));
const commandExecute = async (id: string) => ProductionCommandViewSchema.parse(await request(`order-centers/production-commands/${id}/execute`, {}));
async function rows(id: string) {
  return withTenant(database.db, context, async tx => (await tx.select().from(productionCommandIntents).where(eq(productionCommandIntents.id, id)))[0]!);
}
const productionRows = (orderId: string) => withTenant(database.db, context, tx => tx.select().from(productionOrders).where(eq(productionOrders.orderId, orderId)));
const immutable = (row: Awaited<ReturnType<typeof rows>>) => ({ id: row.id, kind: row.kind, targetId: row.targetId, lineIds: row.lineIds, requestKey: row.requestKey,
  requestChecksum: row.requestChecksum, ownerChecksum: row.ownerChecksum, authority: createHash("sha256").update(JSON.stringify(row.authoritySnapshot)).digest("hex"),
  encryptedInput: createHash("sha256").update(row.encryptedInput ?? "").digest("hex"), expiresAt: row.expiresAt.toISOString() });
async function startApi() {
  assert.ok(!api || api.exitCode !== null || api.signalCode !== null);
  // Only a directly spawned, owned Node child is terminated below.
  api = spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "src/main.ts"], {
    cwd: path.join(root, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: "8130", TSX_DISABLE_CACHE: "1" },
  });
  const child = api, number = ++apiIndex, log = await fs.open(path.join(output, `owned-api-${number}.log`), "wx");
  child.stdout?.on("data", chunk => { void log.appendFile(chunk); });
  child.stderr?.on("data", chunk => { void log.appendFile(chunk); });
  child.once("close", () => { void log.close(); });
  await poll(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw Error("Owned acceptance API exited during startup");
    try { return (await fetch(`${process.env.API_BASE_URL}/health`, { signal: AbortSignal.timeout(1500) })).status; } catch { return 0; }
  }, status => status === 200, 45_000);
  (proof.apiProcesses as unknown[]).push({ number, pid: child.pid, readyAt: new Date().toISOString() }); await save();
}
async function stopApi() {
  const child = api;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  assert.ok(child.pid && child.pid !== process.pid);
  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Owned API did not exit")), 10_000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
  assert.ok(child.kill("SIGKILL")); await exited;
  await pass("owned_api_process_terminated", { pid: child.pid, signal: child.signalCode, exitCode: child.exitCode });
}
async function restartDatabase() {
  const restart = await restartOwnedPostgres(identity!);
  (proof.postgresRestarts as unknown[]).push(restart); await save();
}
function fixtureConnection() { const connection = connectDatabase(); connections.push(connection); return connection; }
async function holdManufacturing(versionId: string) {
  const ready = deferred<void>(), release = deferred<void>(); releases.push(() => release.resolve());
  const connection = fixtureConnection();
  const done = withTenant(connection.db, context, async tx => {
    const [version] = await tx.select({ recipeId: manufacturingRecipeVersions.recipeId }).from(manufacturingRecipeVersions).where(eq(manufacturingRecipeVersions.id, versionId));
    assert.ok(version);
    await tx.select({ id: manufacturingRecipes.id }).from(manufacturingRecipes).where(eq(manufacturingRecipes.id, version.recipeId)).for("update");
    ready.resolve(); await release.promise;
  }).then(() => true, () => false);
  await waitSignal(ready.promise, done); return { release: () => release.resolve(), done };
}
async function holdWorkEvents() {
  // This owner connection controls infrastructure locks only. Business reads and
  // writes still use real HTTP ownership or withTenant/non-owner RLS.
  const connection = fixtureConnection(), ready = deferred<number>(), release = deferred<void>(); releases.push(() => release.resolve());
  const done = connection.client.begin(async tx => {
    await tx.unsafe("lock table order_work_events in share mode");
    const [result] = await tx.unsafe("select pg_backend_pid() as pid"); ready.resolve(result!.pid); await release.promise;
  }).then(() => true, () => false);
  return { pid: await waitSignal(ready.promise, done), release: () => release.resolve(), done };
}
async function blockedBy(pid: number) {
  const values = await database.client.unsafe("select pid,wait_event_type,wait_event from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))", [pid]);
  return values.map(value => ({ pid: value.pid as number, waitEventType: value.wait_event_type as string, waitEvent: value.wait_event as string }));
}
async function queueBusinessLock(key: string) {
  const connection = fixtureConnection(), entered = deferred<void>(), submitted = deferred<number>(), release = deferred<void>(); releases.push(() => release.resolve());
  const done = withTenant(connection.db, context, async tx => {
    const [record] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`); submitted.resolve(record!.pid);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`); entered.resolve(); await release.promise;
  }).then(() => true, () => false);
  return { pid: await waitSignal(submitted.promise, done), entered: entered.promise, release: () => release.resolve(), done };
}
const beginExecution = (id: string) => commandExecute(id).then(value => ({ value }), () => ({ interrupted: true }));
async function closedTransactionRegression(client: ReturnType<typeof connectDatabase>["client"], mode: string) {
  const ready = deferred<number>(), resume = deferred<void>(), completed = deferred<void>(); releases.push(() => resume.resolve());
  let lateQueryRejected = false;
  const transaction = client.begin(async tx => {
    const [backend] = await tx.unsafe("select pg_backend_pid() as pid"); ready.resolve(backend!.pid);
    await resume.promise;
    try { await tx.unsafe("select 73019 as must_not_run_on_reused_transaction"); }
    catch (error) { lateQueryRejected = (error as { code?: string }).code === "CONNECTION_CLOSED"; }
    finally { completed.resolve(); }
  }).then(() => ({ code: "unexpected_commit" }), error => ({ code: (error as { code?: string }).code }));
  try {
    const pid = await ready.promise;
    const [terminated] = await database.client.unsafe("select pg_terminate_backend($1::int) as terminated", [pid]);
    assert.equal(terminated!.terminated, true); assert.equal((await transaction).code, "CONNECTION_CLOSED");
    const [replacement] = await client.unsafe("select pg_backend_pid() as pid, 42 as answer");
    assert.equal(replacement!.answer, 42); assert.notEqual(replacement!.pid, pid);
    resume.resolve(); await completed.promise; assert.equal(lateQueryRejected, true);
    assert.equal((await client.unsafe("select 43 as answer"))[0]!.answer, 43);
    await pass(`driver_${mode}_closed_transaction_rejects_late_query_after_pool_reuse`, { originalBackendPid: pid, replacementBackendPid: replacement!.pid });
  } finally { resume.resolve(); await client.end({ timeout: 2 }); }
}

try {
  step = "closed_transaction_regression";
  await closedTransactionRegression(connectDatabase().client, "esm");
  const databaseRequire = createRequire(new URL("../../packages/database/package.json", import.meta.url));
  await closedTransactionRegression(databaseRequire("postgres")(databaseUrl.href, { max: 1, prepare: false }), "cjs");
  step = "source_fixtures"; await startApi();
  const native = await prepareNativeProduction();
  worker = await startProductionEditorWorker();
  const single = await prepareDeliveryOrder(1, false, { release: false });
  const whole = await prepareDeliveryOrder(2, false, { release: false });
  await stopProductionEditorWorker(worker); worker = undefined;
  const due = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const nativeCommand = normalizeProductionCommand({ kind: "approved_design", targetId: native.orderId, input: {
    orderLineId: native.lineId, factoryId: native.factoryId, factoryVersionId: native.factoryVersionId, capabilityVersionId: native.capabilityVersionId,
    routingDecisionId: native.routingDecisionId, purchaseOrderVersionId: native.purchaseOrderVersionId, designVersionId: native.designVersionId,
    productionAssetIds: native.productionAssetIds, manufacturing: native.manufacturing, capacityPlan: native.capacityPlan,
    productConfirmation: { specificationVersionId: native.specificationVersionId, note: "Synthetic original product and owned design reviewed" },
    expectedCompletionAt: due, instructions: "Synthetic restart native arrangement No factory contact", idempotencyKey: randomUUID(),
  } });
  async function reviewedCommand(data: typeof single, kind: "reviewed_line" | "reviewed_order") {
    const detail = await centerApi<OrderWorkDetail>(`order-centers/lines/${data.lines[0]}`);
    const plan = WholeOrderFulfillmentViewSchema.parse(await centerApi(`order-centers/orders/${detail.line.orderId}/fulfillment`));
    const factory = plan.factories.find(item => item.factoryId === data.factoryId); assert.ok(factory);
    const items = plan.items.map(item => { assert.ok(item.renderId); return { lineId: item.lineId, quantity: item.quantity,
      expectedRevision: item.expectedRevision, expectedProjectionVersion: item.expectedProjectionVersion, renderId: item.renderId,
      capabilityVersionId: factory.items.find(pin => pin.lineId === item.lineId)!.capabilityVersionId,
      capacityPlan: data.capacity.capacityPlan,
      manufacturing: { versionId: data.manufacturing.versionId, orderUnitConfirmed: true } }; });
    const common = { supplierId: factory.supplierId, factoryId: factory.factoryId, factoryVersionId: factory.factoryVersionId,
      expectedCompletionAt: due, instructions: `Synthetic restart ${kind} arrangement No factory contact`, idempotencyKey: randomUUID() };
    const { lineId: _lineId, ...lineInput } = items[0]!; void _lineId;
    return normalizeProductionCommand(kind === "reviewed_order" ? { kind, targetId: plan.orderId, input: { ...common, items } }
      : { kind, targetId: data.lines[0], input: { ...common, ...lineInput } });
  }
  const commands = [nativeCommand, await reviewedCommand(single, "reviewed_line"), await reviewedCommand(whole, "reviewed_order")];
  const saved: Array<{ command: PrepareProductionCommand; id: string; orderId: string; original: ReturnType<typeof immutable> }> = [];
  for (const command of commands) {
    const view = ProductionCommandViewSchema.parse(await request("order-centers/production-commands", command));
    assert.equal(view.status, "prepared"); assert.equal(view.canExecute, true);
    saved.push({ command, id: view.id, orderId: view.orderId, original: immutable(await rows(view.id)) });
  }
  const agentRuns = await withTenant(database.db, context, tx => tx.select({ id: orderDesignAgentRuns.id }).from(orderDesignAgentRuns).where(inArray(orderDesignAgentRuns.workItemId, [...single.lines, ...whole.lines])));
  assert.equal(agentRuns.length, 0);
  proof.originalIntents = saved.map(item => ({ id: item.id, orderId: item.orderId, original: item.original })); await save();
  step = "prepared_restart"; await stopApi(); await restartDatabase(); await startApi();
  for (const item of saved) {
    const view = await commandGet(item.id); assert.equal(view.status, "prepared"); assert.equal(view.canExecute, true);
    assert.deepEqual(immutable(await rows(item.id)), item.original); assert.equal((await productionRows(item.orderId)).length, 0);
  }
  await pass("prepared_originals_survive_real_api_and_postgres_restart");

  step = "native_claim_process_crash";
  const first = saved[0]!, lock = await holdManufacturing(native.manufacturing.versionId);
  const nativeCall = beginExecution(first.id);
  const claimed = await poll(() => rows(first.id), row => row.status === "executing" && row.generation === 1);
  assert.ok(claimed.leaseExpiresAt); assert.equal((await productionRows(first.orderId)).length, 0);
  await stopApi(); lock.release(); assert.equal(await lock.done, true); await nativeCall;
  await startApi(); assert.equal((await commandGet(first.id)).canExecute, false);
  await pass("claimed_native_api_crash_leaves_zero_productions_and_original_lease", { leaseExpiresAt: claimed.leaseExpiresAt });

  step = "single_transaction_database_crash";
  const second = saved[1]!, table = await holdWorkEvents(), singleCall = beginExecution(second.id);
  const blocked = await poll(() => blockedBy(table.pid), entries => entries.length > 0);
  assert.equal((await rows(second.id)).status, "executing");
  assert.equal((await productionRows(second.orderId)).length, 0);
  const survivingApiPid = api!.pid; await restartDatabase(); table.release(); await table.done; await singleCall;
  assert.equal(api!.pid, survivingApiPid); assert.equal(api!.exitCode, null);
  assert.equal((await productionRows(second.orderId)).length, 0);
  assert.deepEqual(immutable(await rows(second.id)), second.original);
  await pass("reviewed_line_database_crash_rolls_back_business_transaction", { blocked, apiPid: survivingApiPid });

  step = "whole_committed_before_journal_seal";
  const third = saved[2]!, table2 = await holdWorkEvents(), wholeCall = beginExecution(third.id);
  await poll(() => blockedBy(table2.pid), entries => entries.length > 0);
  const business = await queueBusinessLock(productionCommandDescriptor(third.command).lockKey);
  await poll(() => database.client.unsafe("select wait_event from pg_stat_activity where pid=$1 and wait_event_type='Lock'", [business.pid]), entries => entries.length === 1);
  table2.release(); assert.equal(await table2.done, true); await waitSignal(business.entered, business.done);
  const committedWhole = await productionRows(third.orderId); assert.equal(committedWhole.length, 2);
  assert.equal((await rows(third.id)).status, "executing"); assert.equal((await rows(third.id)).resultIds, null);
  await stopApi(); business.release(); assert.equal(await business.done, true); await wholeCall;
  await restartDatabase(); await startApi();
  const reconciled = await commandGet(third.id); assert.equal(reconciled.status, "succeeded");
  assert.deepEqual([...reconciled.receipt!.productionOrderIds].sort(), committedWhole.map(row => row.id).sort());
  assert.equal((await productionRows(third.orderId)).length, 2);
  await pass("whole_commit_survives_preseal_api_crash_and_reconciles_exact_owner_ids", { productionOrderIds: reconciled.receipt!.productionOrderIds });

  for (const item of saved) {
    step = `resume_${item.command.kind}`;
    let current = await commandGet(item.id);
    const eligibilityDeadline = Date.now() + 150_000;
    const [clock] = await withTenant(database.db, context, tx => tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`));
    proof.recoveryClock = { host: new Date().toISOString(), database: new Date(clock!.now).toISOString(), originalLeaseExpiresAt: current.leaseExpiresAt };
    const describe = () => ({ id: item.id, status: current.status, canExecute: current.canExecute, leaseExpiresAt: current.leaseExpiresAt,
      expiresAt: current.expiresAt, summaryPresent: Boolean(current.summary), errorCode: current.errorCode });
    proof.lastRecoveryView = describe(); await save();
    // The database owns expiry. Its clock may differ from the Windows host after
    // a VM/container restart. Poll real eligibility; never adjust the lease.
    while (current.status !== "succeeded" && !current.canExecute) {
      assert.ok(["prepared", "executing", "uncertain"].includes(current.status) && current.summary, JSON.stringify(describe()));
      assert.ok(Date.now() < eligibilityDeadline, JSON.stringify(describe()));
      assert.ok(current.leaseExpiresAt, "Unfinished command must expose its original lease");
      const remaining = new Date(current.leaseExpiresAt).getTime() - Date.now();
      await delay(Math.min(10_000, Math.max(200, remaining + 160)));
      process.stdout.write(JSON.stringify({ productionRestartWaiting: step, originalLeaseExpiresAt: current.leaseExpiresAt }) + "\n");
      current = await commandGet(item.id);
      proof.lastRecoveryView = describe(); await save();
    }
    const view = await commandExecute(item.id); assert.equal(view.status, "succeeded");
    assert.equal(view.receipt!.productionOrderIds.length, item.command.kind === "reviewed_order" ? 2 : 1);
    assert.deepEqual(immutable(await rows(item.id)), item.original);
    const repeated = await commandExecute(item.id); assert.deepEqual(repeated.receipt, view.receipt);
    assert.equal((await productionRows(item.orderId)).length, item.command.kind === "reviewed_order" ? 2 : 1);
    const attempts = await withTenant(database.db, context, tx => tx.select({ generation: productionCommandAttempts.generation, status: productionCommandAttempts.status })
      .from(productionCommandAttempts).where(eq(productionCommandAttempts.intentId, item.id)));
    assert.equal(attempts.filter(attempt => attempt.status === "succeeded").length, 1);
    assert.equal((await rows(item.id)).generation, item.command.kind === "reviewed_order" ? 1 : 2);
    await pass(`original_${item.command.kind}_id_only_resume_without_duplicate`, { attempts, productionOrderIds: view.receipt!.productionOrderIds });
  }
  step = "completed_unacknowledged_restart"; await stopApi(); await restartDatabase(); await startApi();
  const allIds: string[] = [];
  for (const item of saved) {
    const list = ProductionCommandListSchema.parse(await request(`order-centers/production-commands?orderId=${item.orderId}`));
    assert.equal(list.items.length, 1); assert.equal(list.items[0]!.id, item.id); assert.equal(list.items[0]!.status, "succeeded");
    allIds.push(...list.items[0]!.receipt!.productionOrderIds);
    await request(`order-centers/production-commands/${item.id}/acknowledge`, {});
    assert.deepEqual(ProductionCommandListSchema.parse(await request(`order-centers/production-commands?orderId=${item.orderId}`)).items, []);
    assert.equal((await rows(item.id)).encryptedInput, null);
  }
  assert.equal(new Set(allIds).size, 4);
  const bindings = await withTenant(database.db, context, tx => tx.select({ productionOrderId: productionOrderVersions.productionOrderId,
    sourceRenderId: productionOrderVersions.sourceRenderId, factoryVersionId: productionOrderVersions.factoryVersionId,
    capabilityVersionId: productionOrderVersions.capabilityVersionId, manufacturingVersionId: productionManufacturingBindings.manufacturingVersionId })
    .from(productionOrderVersions).innerJoin(productionManufacturingBindings, eq(productionManufacturingBindings.productionVersionId, productionOrderVersions.id))
    .where(inArray(productionOrderVersions.productionOrderId, allIds)));
  assert.equal(bindings.length, 4);
  for (const item of saved) for (const production of await productionRows(item.orderId)) {
    const binding = bindings.find(row => row.productionOrderId === production.id); assert.ok(binding);
    const input = item.command.input;
    const line = item.command.kind === "reviewed_order" ? item.command.input.items.find(line => line.lineId === production.orderLineId)! : item.command.input;
    assert.ok(line); assert.equal(production.createdBy, actor.userId);
    assert.equal(binding.manufacturingVersionId, line.manufacturing!.versionId);
    assert.equal(binding.factoryVersionId, input.factoryVersionId); assert.equal(binding.capabilityVersionId, line.capabilityVersionId);
    assert.equal(binding.sourceRenderId, "renderId" in line ? line.renderId : null);
  }
  assert.equal(bindings.filter(row => row.sourceRenderId !== null).length, 3);
  await pass("completed_unacknowledged_receipts_survive_restart_ack_redacts_body_keeps_four_original_bindings", { bindings });
  proof.passed = true;
} catch (error) {
  proof.passed = false; proof.failure = { step, name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    databaseCode: (error as { cause?: { code?: string } })?.cause?.code };
  await save();
  process.stderr.write(JSON.stringify({ productionRestartFailure: proof.failure }) + "\n"); process.exitCode = 1;
} finally {
  for (const release of releases) release();
  await stopProductionEditorWorker(worker).catch(() => { proof.workerCleanupFailed = true; proof.passed = false; process.exitCode = 1; });
  await stopApi().catch(() => { proof.apiCleanupFailed = true; proof.passed = false; process.exitCode = 1; });
  const closed = await Promise.allSettled(connections.map(connection => connection.client.end({ timeout: 3 })));
  if (closed.some(result => result.status === "rejected")) { proof.connectionCleanupFailed = true; proof.passed = false; process.exitCode = 1; }
  await database.client.end({ timeout: 3 });
  proof.finishedAt = new Date().toISOString(); await save();
  process.stdout.write(JSON.stringify({ productionRestartProof: { passed: proof.passed, cases: (proof.cases as unknown[]).length, evidencePath } }) + "\n");
}
