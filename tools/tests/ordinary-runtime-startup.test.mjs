import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { URL } from "node:url";
import test from "node:test";
import { createOrdinaryRuntimeRunner, runtimeEnvironment } from "../scripts/ordinary-runtime.mjs";
import { acquireStartupGate, assertStartupGate, closeStartupGate } from "../scripts/runtime-startup-gate.mjs";

// Only orchestration dependencies are synthetic. The Windows named pipe and
// the explicitly owned node -e/IPC children are real. No fixture file, Docker,
// application port, environment file, database, worker or provider is used.
const windows = { skip: process.platform !== "win32", timeout: 30_000 };
const blocked = /^Error: ORDINARY_RUNTIME_ANOTHER_START_IN_PROGRESS$/;
const gateModule = new URL("../scripts/runtime-startup-gate.mjs", import.meta.url).href;
const syntheticRoot = () => path.resolve("tmp", "ordinary-startup-memory-" + randomUUID());
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("SYNTHETIC_STARTUP_TIMEOUT_" + label)), 7000);
    })]);
  } finally { clearTimeout(timer); }
}
const outcome = pending => pending.then(value => ({ value }), error => ({ error }));
async function gateAvailable(root) {
  const gate = await acquireStartupGate(root);
  try { assertStartupGate(root, gate); } finally { await closeStartupGate(gate); }
  assert.equal(gate.listening, false);
}
async function gateBlocked(root) {
  let unexpected;
  try { await assert.rejects(async () => { unexpected = await acquireStartupGate(root); }, blocked); }
  finally { if (unexpected?.listening) await closeStartupGate(unexpected); }
}
function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}
function childExit(child) {
  return exited(child) ? Promise.resolve() : new Promise(resolve => child.once("exit", resolve));
}
function ownedProcesses(t) {
  const children = new Set();
  t.after(async () => {
    for (const child of children) {
      const done = childExit(child);
      if (!exited(child)) child.kill();
      await bounded(done, "owned_child_exit");
      assert.equal(exited(child), true);
    }
  });
  return source => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      env: runtimeEnvironment({}), stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
    });
    children.add(child); return child;
  };
}
function message(child) {
  return bounded(new Promise((resolve, reject) => {
    const done = value => { cleanup(); resolve(value); };
    const failed = error => { cleanup(); reject(error); };
    const ended = () => failed(new Error("SYNTHETIC_STARTUP_CHILD_EXITED_BEFORE_MESSAGE"));
    function cleanup() { child.removeListener("message", done); child.removeListener("error", failed); child.removeListener("exit", ended); }
    child.once("message", done); child.once("error", failed); child.once("exit", ended);
  }), "child_message");
}

function fixture(t, { root = syntheticRoot(), initial = ["missing", "missing"], hooks = {} } = {}) {
  const signals = new EventEmitter(), events = [], holds = new Map(), gates = new Set(), runs = [];
  const children = [], stopped = [], reuse = { pid: 700001, component: "api", exitCode: null, signalCode: null };
  let gate, mode, started = false, inspection = 0;
  const prepared = { manifest: { sourceSha256: "a".repeat(64), migrations: 188, candidate: "b".repeat(32), buildId: "synthetic-startup",
    studioRuntime: { bundleId: "c".repeat(64), deploymentSha256: "d".repeat(64) } }, state: { components: {} }, environment: {}, plans: [] };
  const rows = decisions => decisions.map((decision, index) => ({ component: index ? "web" : "api", decision,
    pid: decision === "reuse" ? reuse.pid + index : null, listenerPid: decision === "reuse" ? reuse.pid + index : null }));
  const cleanupEntered = deferred(), ownerWaitEntered = deferred(), ownerFinished = deferred();
  async function stage(name) {
    events.push(name);
    if (mode === "start" && !["wait", "report"].includes(name)) assertStartupGate(root, gate);
    const hold = holds.get(name);
    if (hold) { hold.entered.resolve(); await hold.release.promise; }
    if (hooks.stage) await hooks.stage(name);
  }
  const defaults = {
    async acquireGate(selectedRoot) {
      events.push("gate.acquire"); assert.equal(selectedRoot, root);
      gate = await acquireStartupGate(root); gates.add(gate); return gate;
    },
    async closeGate(selected) {
      events.push("gate.close"); assert.equal(selected, gate); await closeStartupGate(selected);
    },
    async prepareRuntime(selectedRoot) { assert.equal(selectedRoot, root); await stage("prepare"); return prepared; },
    async studioRuntime(selectedMode, selectedGate) {
      assert.equal(selectedMode, mode); assert.equal(selectedGate, mode === "start" ? gate : undefined);
      await stage("studio"); return { bundleId: prepared.manifest.studioRuntime.bundleId, healthy: true };
    },
    async verifyStorage(value) { assert.equal(value, prepared); await stage("storage"); return true; },
    async databaseMigrations(selectedRoot, value) { assert.equal(selectedRoot, root); assert.equal(value, prepared); await stage("database"); return 188; },
    async inspectRuntime(value) { assert.equal(value, prepared); await stage("inspect:" + ++inspection); return rows(started ? ["reuse", "reuse"] : initial); },
    async startMissing(selectedRoot, value, context) {
      assert.equal(selectedRoot, root); assert.equal(value, prepared); await stage("startMissing");
      for (const [index, decision] of initial.entries()) {
        if (decision === "reuse") continue;
        await stage(index ? "spawn:web" : "spawn:api"); context.assertNotInterrupted();
        const child = { pid: 800001 + index, component: index ? "web" : "api", exitCode: null, signalCode: null };
        context.children.push(child); children.push(child); await stage("after-owned-spawn"); context.assertNotInterrupted();
      }
      started = true;
    },
    async stopChildren(owned) {
      await stage("stop"); cleanupEntered.resolve();
      assert.equal(owned.includes(reuse), false); for (const child of owned) { stopped.push(child); child.exitCode = 0; }
    },
    async waitChildren(owned) {
      events.push("wait"); assert.equal(owned.includes(reuse), false); ownerWaitEntered.resolve();
      if (hooks.holdOwner) await ownerFinished.promise;
    },
    reportStarted(report) { events.push("report"); assert.equal(gate.listening, false); assert.equal(report.migrations, 188); },
    signals,
  };
  const overrides = Object.fromEntries(Object.entries(hooks).filter(([key]) => key in defaults));
  const runner = createOrdinaryRuntimeRunner({ ...defaults, ...overrides });
  const f = { root, signals, events, prepared, children, stopped, reuse, cleanupEntered, ownerWaitEntered, ownerFinished,
    get gate() { return gate; },
    setStarted(value) { started = value; },
    stage,
    hold(name) { const hold = { entered: deferred(), release: deferred() }; holds.set(name, hold); return hold; },
    run(selectedMode = "start") { mode = selectedMode; const pending = outcome(runner(root, selectedMode)); runs.push(pending); return pending; },
  };
  t.after(async () => {
    for (const hold of holds.values()) hold.release.resolve(); ownerFinished.resolve();
    await bounded(Promise.all(runs), "runner_teardown");
    for (const selected of gates) if (selected.listening) await closeStartupGate(selected);
    assert.equal(signals.listenerCount("SIGINT"), 0); assert.equal(signals.listenerCount("SIGTERM"), 0);
    assert.equal([...gates].some(selected => selected.listening), false);
    await gateAvailable(root);
  });
  return f;
}

test("one real OS reservation covers prepare Studio up readiness both spawn stages and final stability", windows, async t => {
  const f = fixture(t);
  const stages = ["prepare", "studio", "storage", "database", "inspect:1", "spawn:api", "spawn:web", "inspect:2"];
  const holds = stages.map(name => f.hold(name)), running = f.run();
  for (const [index, stage] of stages.entries()) {
    await bounded(holds[index].entered.promise, stage); assertStartupGate(f.root, f.gate);
    const before = f.events.length, other = await f.run();
    assert.match(String(other.error), blocked); assert.deepEqual(f.events.slice(before), ["gate.acquire"]);
    holds[index].release.resolve();
  }
  assert.deepEqual(await bounded(running, "complete_start"), { value: null });
  assert.equal(f.children.length, 2); assert.equal(f.stopped.length, 0);
  assert(f.events.indexOf("gate.close") > f.events.indexOf("inspect:2"));
  assert(f.events.indexOf("report") > f.events.indexOf("gate.close"));
  await gateAvailable(f.root);
});

test("a healthy reused API and Web return without stopping spawning reporting or waiting and release the gate", windows, async t => {
  const forbidden = () => assert.fail("healthy services must remain untouched");
  const f = fixture(t, { initial: ["reuse", "reuse"], hooks: { startMissing: forbidden, stopChildren: forbidden, waitChildren: forbidden, reportStarted: forbidden } });
  const result = await f.run(); assert.equal(result.error, undefined); assert.equal(result.value.mode, "start");
  assert(result.value.components.every(row => row.decision === "reuse"));
  assert.deepEqual(f.events, ["gate.acquire", "prepare", "studio", "storage", "database", "inspect:1", "gate.close"]);
  assert.equal(f.reuse.exitCode, null); await gateAvailable(f.root);
});

test("status stays read only even while another process owns the startup gate and failures never invoke cleanup", windows, async t => {
  const f = fixture(t, { initial: ["reuse", "reuse"] });
  const gate = await acquireStartupGate(f.root);
  try {
    const result = await f.run("status"); assert.equal(result.error, undefined); assert.equal(result.value.mode, "status");
    assert.deepEqual(f.events, ["prepare", "studio", "storage", "database", "inspect:1"]);
    assert.equal(f.signals.listenerCount("SIGINT"), 0); assert.equal(f.signals.listenerCount("SIGTERM"), 0);
    const primary = new Error("SYNTHETIC_STATUS_READ_FAILED");
    const bad = fixture(t, { root: f.root, hooks: { stage(name) { if (name === "studio") throw primary; } } });
    assert.equal((await bad.run("status")).error, primary); assert.deepEqual(bad.events, ["prepare", "studio"]);
    assert.equal(bad.stopped.length, 0); assertStartupGate(f.root, gate);
  } finally { await closeStartupGate(gate); }
});

test("invalid modes fail before acquiring the gate or touching any prepared resource", windows, async t => {
  const f = fixture(t); const result = await f.run("restart");
  assert.match(String(result.error), /^Error: ORDINARY_RUNTIME_USE_DAILY_STATUS_OR_START$/); assert.deepEqual(f.events, []);
});

test("preflight and partial startup errors preserve the primary error release the gate and only clean new children", windows, async t => {
  for (const at of ["prepare", "studio", "storage", "database", "inspect:1", "spawn:web", "inspect:2"]) {
    await t.test(at, async sub => {
      const primary = new Error("SYNTHETIC_FAILURE_" + at);
      const f = fixture(sub, { initial: at === "inspect:2" ? ["reuse", "missing"] : ["missing", "missing"],
        hooks: { stage(name) { if (name === at) throw primary; } } });
      assert.equal((await f.run()).error, primary); assert.equal(f.reuse.exitCode, null);
      assert.equal(f.stopped.includes(f.reuse), false); assert.deepEqual(f.stopped, f.children);
      assert.equal(f.events.includes("report"), false); await gateAvailable(f.root);
    });
  }
  for (const [name, hooks, expected] of [
    ["unavailable storage", { verifyStorage: async () => false }, "STORAGE_UNAVAILABLE"],
    ["wrong migration count", { databaseMigrations: async () => 187 }, "DATABASE_PAIR_CHANGED"],
    ["not stable after start", { inspectRuntime: async () => [{ component: "web", decision: "missing" }] }, "START_FAILED"],
  ]) await t.test(name, async sub => {
    const f = fixture(sub, { hooks }); assert.equal((await f.run()).error.message, "ORDINARY_RUNTIME_" + expected);
    assert.deepEqual(f.stopped, f.children); assert.equal(f.reuse.exitCode, null); await gateAvailable(f.root);
  });
});

test("SIGINT and SIGTERM share one owned cleanup and interruption forbids another spawn before releasing the gate", windows, async t => {
  const f = fixture(t, { initial: ["reuse", "missing"] }), hold = f.hold("after-owned-spawn"), running = f.run();
  await bounded(hold.entered.promise, "signal_boundary"); assert.equal(f.children.length, 1);
  f.signals.emit("SIGINT"); await bounded(f.cleanupEntered.promise, "signal_cleanup"); f.signals.emit("SIGTERM");
  await gateBlocked(f.root); hold.release.resolve();
  const result = await bounded(running, "interrupted_start"); assert.equal(result.error.message, "ORDINARY_RUNTIME_START_INTERRUPTED");
  assert.equal(f.events.filter(value => value === "stop").length, 1); assert.deepEqual(f.stopped, f.children);
  assert.equal(f.reuse.exitCode, null); assert.equal(f.events.includes("report"), false); await gateAvailable(f.root);
});

test("a cleanup failure holds the real gate until the actual owned IPC child exits and preserves both errors", windows, async t => {
  const primary = new Error("SYNTHETIC_FINAL_INSPECT_FAILED"), cleanup = new Error("SYNTHETIC_KILL_NOT_CONFIRMED");
  const spawnOwned = ownedProcesses(t), waitEntered = deferred(); let child;
  const f = fixture(t, { initial: ["reuse", "missing"], hooks: {
    stage(name) { if (name === "inspect:2") throw primary; },
    async startMissing(selectedRoot, prepared, context) {
      assert.equal(selectedRoot, f.root); assert.equal(prepared, f.prepared); assertStartupGate(f.root, f.gate);
      context.assertNotInterrupted();
      child = spawnOwned("process.on('message', value => { if(value === 'finish') process.exit(0); }); process.send('ready');");
      context.children.push(child); f.children.push(child); assert.equal(await message(child), "ready"); f.setStarted(true);
    },
    async stopChildren(children) { assert.deepEqual(children, [child]); assert.equal(children.includes(f.reuse), false); throw cleanup; },
    async waitChildren(children) {
      assert.deepEqual(children, [child]); assertStartupGate(f.root, f.gate); waitEntered.resolve(); await childExit(child);
    },
  } });
  let finished = false; const running = f.run().then(value => { finished = true; return value; });
  try {
    await bounded(waitEntered.promise, "cleanup_wait"); assert.equal(finished, false); assert.equal(exited(child), false);
    await gateBlocked(f.root); child.send("finish");
    const result = await bounded(running, "cleanup_actual_exit");
    assert(result.error instanceof AggregateError); assert.equal(result.error.message, "ORDINARY_RUNTIME_OWNED_CHILD_CLEANUP_FAILED");
    assert.deepEqual(result.error.errors, [primary, cleanup]); assert.equal(exited(child), true);
    assert.equal(f.reuse.exitCode, null); await gateAvailable(f.root);
  } finally {
    if (child) { const done = childExit(child); if (!exited(child)) child.kill(); await bounded(done, "cleanup_fixture_exit"); }
  }
});

test("the gate releases at stable startup while the first owner still waits and a second caller can safely reuse", windows, async t => {
  const f = fixture(t, { hooks: { holdOwner: true } }); let firstSettled = false;
  const first = f.run().then(value => { firstSettled = true; return value; });
  await bounded(f.ownerWaitEntered.promise, "stable_owner_wait"); assert.equal(firstSettled, false);
  assert.equal(f.gate.listening, false); await gateAvailable(f.root);
  const count = f.children.length, second = await f.run(); assert.equal(second.error, undefined);
  assert(second.value.components.every(row => row.decision === "reuse")); assert.equal(f.children.length, count); assert.equal(f.stopped.length, 0);
  assert.equal(firstSettled, false); f.ownerFinished.resolve(); assert.deepEqual(await bounded(first, "owner_done"), { value: null });
});

test("independent Windows processes share the same gate and abnormal owner exit leaves no stale reservation", windows, async t => {
  const root = syntheticRoot(), spawnOwned = ownedProcesses(t);
  const childSource = selectedRoot => `
    import { acquireStartupGate, closeStartupGate } from ${JSON.stringify(gateModule)};
    try {
      const gate = await acquireStartupGate(${JSON.stringify(selectedRoot)});
      process.on('message', async value => { if(value === 'close') { await closeStartupGate(gate); process.send('closed'); process.disconnect(); } });
      process.send('acquired');
    } catch(error) { process.send({ error: error.message }); process.disconnect(); }
  `;
  let held = await acquireStartupGate(root);
  try {
    const competitor = spawnOwned(childSource(root.toUpperCase()));
    assert.deepEqual(await message(competitor), { error: "ORDINARY_RUNTIME_ANOTHER_START_IN_PROGRESS" });
    await bounded(childExit(competitor), "competing_child_exit"); assert.equal(competitor.exitCode, 0);
    await closeStartupGate(held); held = null;
    const owner = spawnOwned(childSource(root)); assert.equal(await message(owner), "acquired"); await gateBlocked(root);
    const ownerDone = childExit(owner); owner.kill(); await bounded(ownerDone, "abnormal_gate_owner_exit");
    assert.equal(exited(owner), true); await gateAvailable(root);
    const successor = spawnOwned(childSource(root)); assert.equal(await message(successor), "acquired");
    const closed = message(successor); successor.send("close"); assert.equal(await closed, "closed");
    await bounded(childExit(successor), "successor_closed_exit"); assert.equal(successor.exitCode, 0); await gateAvailable(root);
  } finally { if (held?.listening) await closeStartupGate(held); }
});
