import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import fs from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import { acquireStartupGate, applyStorageOverlay, componentDecision, localPath, runtimeEnvironment, runtimePlans, stopSpawnedChildren, validateRuntimeManifest } from "../scripts/ordinary-runtime.mjs";
import { orderWorkerProfile, orderWorkerQueues, orderWorkerSchedulers, orderWorkerProfiles, orderWorkerReady } from "../scripts/ordinary-worker-runtime.mjs";

const root = path.resolve("ordinary-runtime-fixture");
const manifest = {
  schemaVersion: 1, scope: "adopted-personal-runtime", snapshot: ".artifacts/ordinary-api-source-148-example",
  sourceManifest: "docs/project-control/checkpoints/source-example.json", sourceManifestSha256: "1".repeat(64),
  sourceSha256: "2".repeat(64), sourceFiles: 2598, migrations: 148, candidate: "3".repeat(32), buildId: "fixture-build",
  envSha256: "4".repeat(64), overlay: ".artifacts/ordinary-runtime-recovery-example/storage.env", overlaySha256: "5".repeat(64), storageEndpoint: "http://127.0.0.1:19000",
};
const environment = { WEB_AUTH_MODE: "personal", WEB_ORIGIN: "http://localhost:3000", API_BASE_URL: "http://127.0.0.1:8000", ERP_SESSION_ENCRYPTION_KEY: "fixture-only", OIDC_ISSUER: "http://localhost:8081/realms/yummyai", DATABASE_URL: "fixture-only-not-connected", LOCAL_OIDC_CLIENT_SECRET: "fixture-only" };
const expected = { pid: 1234, listenerPid: 1234, creationDate: "2026-10-22T00:00:00Z", commandSha256: "6".repeat(64) };
const identity = { pid: 1234, creationDate: expected.creationDate, commandSha256: expected.commandSha256 };

async function removeOwnedEnvironmentFixture(temporaryRoot, folder, files) {
  assert.ok(folder.startsWith(path.join(temporaryRoot, "ordinary-runtime-env-6c5e9a20-")));
  assert.equal((await fs.lstat(folder)).isSymbolicLink(), false);
  for (const file of files) {
    try { assert.equal((await fs.lstat(file)).isFile(), true); assert.equal((await fs.lstat(file)).isSymbolicLink(), false); await fs.unlink(file); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await fs.rmdir(folder);
  await assert.rejects(fs.lstat(folder), { code: "ENOENT" });
}

test("runtime manifest rejects executable injection and untrusted storage destinations", () => {
  assert.equal(validateRuntimeManifest(manifest), manifest);
  for (const extra of [{ command: "browser" }, { args: ["https://example.test"] }]) assert.throws(() => validateRuntimeManifest({ ...manifest, ...extra }), /INVALID_MANIFEST/);
  for (const storageEndpoint of ["https://example.test", "http://127.0.0.1:8080", "http://name:secret@127.0.0.1:19000", "http://127.0.0.1:19000/?next=x"])
    assert.throws(() => validateRuntimeManifest({ ...manifest, storageEndpoint }));
  assert.throws(() => validateRuntimeManifest({ ...manifest, snapshot: "apps/api" }), /INVALID_MANIFEST/);
  assert.throws(() => validateRuntimeManifest({ ...manifest, candidate: "unreviewed" }), /INVALID_MANIFEST/);
});

test("Studio is enabled only by a v2 manifest pinning its exact bundle and deployment record", () => {
  const paired = { ...manifest, schemaVersion: 2, studioRuntime: { bundleId: "a".repeat(64), deploymentSha256: "b".repeat(64) } };
  assert.equal(validateRuntimeManifest(paired), paired);
  for (const studioRuntime of [null, {}, { ...paired.studioRuntime, bundleId: "latest" }, { ...paired.studioRuntime, deploymentSha256: "bad" }, { ...paired.studioRuntime, origin: "https://external.test" }])
    assert.throws(() => validateRuntimeManifest({ ...paired, studioRuntime }), /INVALID_STUDIO_PAIR/);
  assert.throws(() => validateRuntimeManifest({ ...manifest, studioRuntime: paired.studioRuntime }), /INVALID_MANIFEST/);
  const ambient = { ...environment, CANVAS_STUDIO_PRODUCTION_ENABLED: "1", CANVAS_STUDIO_URL: "https://external.test" };
  const oldWeb = runtimePlans(root, manifest, ambient)[1];
  const pairedWeb = runtimePlans(root, paired, ambient)[1];
  assert.equal(oldWeb.env.CANVAS_STUDIO_PRODUCTION_ENABLED, "0");
  assert.equal(pairedWeb.env.CANVAS_STUDIO_PRODUCTION_ENABLED, "1");
  assert.equal(pairedWeb.env.CANVAS_STUDIO_URL, "http://127.0.0.1:4176");
  assert.deepEqual(runtimePlans(root, paired, ambient).map(plan => plan.component), ["api", "web"]);
});

test("snapshot and configuration paths cannot escape the reviewed workspace", () => {
  for (const name of ["../outside", "C:/outside", "/outside", "x/../outside", "x\\outside", "x//outside"])
    assert.throws(() => localPath(root, name), /INVALID_PATH/);
  assert.equal(localPath(root, ".env"), path.join(root, ".env"));
});

test("only a v3 manifest enables the exact reviewed order consumers and loopback health", () => {
  const selected = { ...manifest, schemaVersion: 3,
    studioRuntime: { bundleId: "a".repeat(64), deploymentSha256: "b".repeat(64) }, workerRuntime: { profile: orderWorkerProfile } };
  const plans = runtimePlans(root, selected, { ...environment, WORKER_QUEUES: "all", WORKER_SCHEDULERS: "all", WORKER_HEALTH_PORT: "9000" });
  assert.deepEqual(plans.map(plan => plan.component), ["api", "web", "worker"]);
  const worker = plans[2];
  assert.equal(worker.cwd, path.join(root, manifest.snapshot, "apps/worker"));
  assert.deepEqual(worker.args.slice(-3), ["--import", "tsx", "src/run.ts"]);
  const effective = runtimeEnvironment(environment, worker.env);
  assert.equal(effective.WORKER_QUEUES, orderWorkerQueues.join(","));
  assert.equal(effective.WORKER_SCHEDULERS, orderWorkerSchedulers.join(","));
  assert.equal(worker.health, "http://127.0.0.1:8001/health");
  assert.equal(effective.WORKER_HEALTH_PORT, "8001");
  for (const workerRuntime of [null, {}, { profile: "all" }, { profile: orderWorkerProfile, queues: ["media"] }])
    assert.throws(() => validateRuntimeManifest({ ...selected, workerRuntime }), /INVALID_WORKER_PROFILE/);
  assert.throws(() => validateRuntimeManifest({ ...selected, schemaVersion: 2 }), /INVALID_MANIFEST/);
});

test("Worker HTTP success cannot hide a different PID or extra background consumers", () => {
  const healthy = { state: "ready", pid: 1234, queues: [...orderWorkerQueues], schedulers: [...orderWorkerSchedulers] };
  assert.equal(orderWorkerReady(healthy, 1234), true);
  assert.equal(orderWorkerReady({ ...healthy, queues: [...healthy.queues].reverse() }, 1234), true);
  for (const change of [{ state: "starting" }, { pid: 5678 }, { queues: [...healthy.queues, "media"] }, { queues: healthy.queues.slice(1) },
    { schedulers: [...healthy.schedulers, "aiAssistScheduler"] }]) assert.equal(orderWorkerReady({ ...healthy, ...change }, 1234), false);
});

test("the new order profile adds only private-order retention and never widens a restored v1 manifest", () => {
  const selected = { ...manifest, schemaVersion: 3, studioRuntime: { bundleId: "a".repeat(64), deploymentSha256: "b".repeat(64) },
    workerRuntime: { profile: "order-fulfillment-v2" } };
  const [,, worker] = runtimePlans(root, selected, { ...environment, WORKER_QUEUES: "all", WORKER_SCHEDULERS: "all" });
  assert.equal(worker.workerProfile, "order-fulfillment-v2");
  assert.deepEqual(worker.env.WORKER_QUEUES.split(","), [...orderWorkerQueues, "amazon-order-report-retention"]);
  assert.equal(worker.env.WORKER_SCHEDULERS, orderWorkerSchedulers.join(","));
  const current = { state: "ready", pid: 1234, ...orderWorkerProfiles[worker.workerProfile] };
  assert.equal(orderWorkerReady(current, 1234, worker.workerProfile), true);
  assert.equal(orderWorkerReady(current, 1234, orderWorkerProfile), false);
  assert.equal(orderWorkerReady({ ...current, queues: orderWorkerQueues }, 1234, worker.workerProfile), false);
  assert.equal(orderWorkerReady(current, 1234, "all"), false);
  const [,, restored] = runtimePlans(root, { ...selected, workerRuntime: { profile: orderWorkerProfile } }, environment);
  assert.deepEqual(restored.env.WORKER_QUEUES.split(","), orderWorkerQueues);
  for (const profile of ["toString", "__proto__", "order-fulfillment-v3"])
    assert.throws(() => validateRuntimeManifest({ ...selected, workerRuntime: { profile } }), /INVALID_WORKER_PROFILE/);
});

test("owned daily Worker receives graceful shutdown and waits for its real process exit", { skip: process.platform !== "win32", timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, ["-e", "process.on('message', message => { if (message?.type === 'worker.shutdown') setTimeout(() => process.exit(0), 20); }); process.send('ready');"],
    { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  child.dailyWorker = true;
  try {
    await new Promise((resolve, reject) => { child.once("error", reject); child.once("message", resolve); });
    await stopSpawnedChildren([child]);
    assert.equal(child.exitCode, 0);
    assert.equal(child.killed, false);
  } finally { if (child.exitCode === null && !child.signalCode) child.kill(); }
});

test("the exact original API and Web plans use files and argv without shell URL launch", () => {
  const plans = runtimePlans(root, manifest, environment);
  assert.deepEqual(plans.map((plan) => [plan.component, plan.port]), [["api", 8000], ["web", 3000]]);
  assert.equal(plans[0].cwd, path.join(root, manifest.snapshot, "apps/api"));
  assert.equal(plans[1].cwd, path.join(root, manifest.snapshot, ".artifacts/local-web-releases", manifest.candidate, "apps/web"));
  assert.ok(plans[1].args.includes("start"));
  assert.ok(plans[1].args.includes(path.join(root, manifest.snapshot, "apps/web/node_modules/next/dist/bin/next")));
  assert.ok(plans.every((plan) => plan.args.filter((arg) => arg.startsWith("--env-file=")).length === 2));
  assert.doesNotMatch(JSON.stringify(plans.map((plan) => plan.args)), /https?:|Start-Process|cmd\.exe|powershell|worker|migrate/);
  assert.equal(plans[1].env.NODE_ENV, "production");
});

test("demo, test, service identity and wrong endpoint modes never become daily operation", () => {
  for (const override of [{ WEB_AUTH_MODE: "local-service" }, { E2E_ISOLATED_DAILY: "1" }, { DEMO_MODE: "1" }, { FACTORY_PORTAL_ONLY: "1" }, { WEB_ORIGIN: "http://elsewhere.test" }, { API_BASE_URL: "http://localhost:8130" }])
    assert.throws(() => runtimePlans(root, manifest, { ...environment, ...override }), /PERSONAL_ENVIRONMENT_REQUIRED/);
});

test("inherited Node injection, test flags and unrelated provider credentials are not forwarded", () => {
  const result = runtimeEnvironment(environment, { NODE_ENV: "production" }, { PATH: "fixture-path", NODE_OPTIONS: "--require attacker", E2E_ISOLATED_DAILY: "1", OPENAI_API_KEY: "fixture-unrelated", S3_ENDPOINT: "https://elsewhere.test" });
  assert.equal(result.PATH, "fixture-path");
  for (const key of ["NODE_OPTIONS", "E2E_ISOLATED_DAILY", "OPENAI_API_KEY", "S3_ENDPOINT"]) assert.equal(result[key], undefined);
  assert.equal(result.NODE_ENV, "production");
  assert.throws(() => runtimeEnvironment({ ...environment, NODE_OPTIONS: "--import attacker" }), /NODE_INJECTION_UNSUPPORTED/);
});

test("actual Node uses the reviewed storage fallback even when the original env file has port 9000", async () => {
  const temporaryRoot = fileURLToPath(new URL("../../tmp/", import.meta.url));
  await fs.mkdir(temporaryRoot, { recursive: true });
  assert.equal((await fs.lstat(temporaryRoot)).isSymbolicLink(), false);
  assert.equal(path.resolve(await fs.realpath(temporaryRoot)).toLowerCase(), path.resolve(temporaryRoot).toLowerCase());
  const folder = await fs.mkdtemp(path.join(temporaryRoot, "ordinary-runtime-env-6c5e9a20-"));
  const base = path.join(folder, "base.env"), overlay = path.join(folder, "storage.env");
  try {
    await fs.writeFile(base, "S3_ENDPOINT=http://127.0.0.1:9000\n", { flag: "wx" });
    await fs.writeFile(overlay, "S3_ENDPOINT=http://127.0.0.1:19000\n", { flag: "wx" });
    const effective = applyStorageOverlay({ ...environment, S3_ENDPOINT: "http://127.0.0.1:9000" }, { S3_ENDPOINT: manifest.storageEndpoint }, manifest);
    const result = spawnSync(process.execPath, [`--env-file=${base}`, `--env-file=${overlay}`, "--input-type=module", "-e", "process.stdout.write(process.env.S3_ENDPOINT)"],
      { env: runtimeEnvironment(effective), encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, manifest.storageEndpoint);
    assert.throws(() => applyStorageOverlay(environment, { S3_ENDPOINT: manifest.storageEndpoint, NODE_OPTIONS: "--import attacker" }, manifest), /INVALID_STORAGE_OVERLAY/);
  } finally {
    await removeOwnedEnvironmentFixture(temporaryRoot, folder, [base, overlay]);
  }
});

test("HTTP 200 cannot authorize an unknown or recycled service; correct identity is reused", () => {
  const input = { listening: true, healthy: true, identity, expected, listenerPid: 1234 };
  assert.equal(componentDecision(input), "reuse");
  assert.equal(componentDecision(input), "reuse");
  for (const override of [{ expected: undefined }, { identity: { ...identity, creationDate: "new-process" } }, { identity: { ...identity, commandSha256: "7".repeat(64) } }, { listenerPid: 5678 }])
    assert.throws(() => componentDecision({ ...input, ...override }), /UNRECOGNIZED_LISTENER/);
  assert.throws(() => componentDecision({ ...input, healthy: false }), /OWNED_PROCESS_UNHEALTHY/);
  assert.throws(() => componentDecision({ ...input, listening: false }), /OWNED_PROCESS_UNHEALTHY/);
  assert.equal(componentDecision({ ...input, listening: false, identity: null }), "missing");
});

test("the actual CLI refuses extra arguments before any service or database work", () => {
  const entry = fileURLToPath(new URL("../scripts/ordinary-runtime.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [entry, "start", "https://example.test"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^ORDINARY_RUNTIME_USE_DAILY_STATUS_OR_START\r?\n$/);
  assert.equal(result.stdout, "");
});

test("actual Windows child shutdown waits for owned exit and preserves a reused process", { skip: process.platform !== "win32" }, async () => {
  const children = [];
  try {
    for (let index = 0; index < 2; index++) {
      const child = spawn(process.execPath, ["-e", "process.stdout.write('ready');setTimeout(()=>process.exit(0),15000)"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      children.push(child);
      await new Promise((resolve, reject) => { child.once("error", reject); child.stdout.once("data", resolve); });
    }
    await stopSpawnedChildren([children[0]]);
    assert.ok(children[0].exitCode !== null || children[0].signalCode);
    assert.equal(children[1].exitCode, null);
    assert.equal(children[1].signalCode, null);
  } finally { await stopSpawnedChildren(children); }
});

test("actual Windows startup gate excludes concurrent starts and releases without a stale file", { skip: process.platform !== "win32" }, async () => {
  const name = path.resolve("tmp", `ordinary-runtime-gate-fixture-${process.pid}`);
  let gate = await acquireStartupGate(name);
  try { await assert.rejects(acquireStartupGate(name), /ANOTHER_START_IN_PROGRESS/); }
  finally { await new Promise((resolve) => gate.close(resolve)); }
  gate = await acquireStartupGate(name);
  await new Promise((resolve) => gate.close(resolve));
});
