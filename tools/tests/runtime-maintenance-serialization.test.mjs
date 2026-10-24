import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import nodeFs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import { acquireStartupGate, closeStartupGate } from "../scripts/runtime-startup-gate.mjs";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const preload = import.meta.url, mode = process.env.YUMMYAI_MAINTENANCE_SERIALIZATION_TEST;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const encode = value => JSON.stringify(value, null, 2) + "\n";
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const id = character => character.repeat(64);
const fixtureId = "00000000-0000-4000-8000-000000000001";

// This same source is an explicit --import hook in each owned child. Install
// fences before loading the actual CLI; no child can reach Docker, private
// files, network fetch, or filesystem mutations even if serialization breaks.
if (mode) {
  const audit = value => { if (process.send) process.send({ audit: value }); };
  const rejected = code => Object.assign(new Error("SYNTHETIC_" + code), { code });
  const files = new Map(), dockerResponses = new Map();
  const absolute = relative => path.resolve(root, relative).toLowerCase();
  const save = (relative, value) => { const bytes = Buffer.from(encode(value)); files.set(absolute(relative), bytes); return bytes; };
  const modelBytes = save(".artifacts/yummyai-compose/runtime.json", { services: {} });
  const baselineBytes = save(".artifacts/yummyai-compose/baseline.private.json", { inspections: [] });
  save(".artifacts/yummyai-compose/manifest.json", { version: 1, project: "yummyai", runtimeSha256: sha(modelBytes), baselineSha256: sha(baselineBytes), imageChanges: [], imageAdoptions: [] });
  if (mode === "healthy") {
    const record = { version: 2, project: "yummyai", service: "studio-runtime", deploymentId: id("a"), bundleId: id("b"), imageId: "sha256:" + id("c"), entryImageId: "sha256:" + id("d"),
      origin: "http://127.0.0.1:4176", artifactManifest: `.artifacts/studio-runtime-releases/${id("b")}/manifest.json`, composeFile: `.artifacts/studio-runtime-deployments/${id("a")}/compose.json` };
    const program = "process.exit(0)"; record.entryProgramSha256 = sha(program);
    record.artifactManifestSha256 = sha(save(record.artifactManifest, { synthetic: true }));
    record.composeSha256 = sha(save(record.composeFile, { services: { "studio-runtime-entry": { command: ["node", "-e", program] } } }));
    const networkNames = ["yummyai_studio-runtime", "yummyai_studio-runtime-entry"], names = ["yummyai-studio-runtime", "yummyai-studio-runtime-entry"];
    const containers = names.map((name, index) => ({ Id: id(index ? "f" : "e"), Image: index ? record.entryImageId : record.imageId,
      Config: { User: "1000:1000", Cmd: index ? ["node", "-e", program] : ["node", "server.mjs"], Labels: { "com.docker.compose.project": "yummyai", "com.docker.compose.service": index ? "studio-runtime-entry" : "studio-runtime",
        "io.yummyai.studio.bundle": record.bundleId, "io.yummyai.studio.deployment": record.deploymentId } },
      HostConfig: { ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], PortBindings: index ? { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "4176" }] } : {} }, Mounts: [],
      NetworkSettings: { Networks: Object.fromEntries(networkNames.slice(0, index ? 2 : 1).map(value => [value, {}])), Ports: index ? { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "4176" }] } : {} }, State: { Running: true, Health: { Status: "healthy" } } }));
    const comparable = value => ({ Config: value.Config, HostConfig: value.HostConfig, Mounts: value.Mounts, networks: Object.keys(value.NetworkSettings.Networks).sort() });
    const pair = { runtime: comparable(containers[0]), entry: comparable(containers[1]) };
    record.baselineFile = `.artifacts/studio-runtime-deployments/${record.deploymentId}/baseline.json`;
    record.baselineSha256 = sha(save(record.baselineFile, { comparable: pair, sha256: sha(stable(pair)) }));
    save(".artifacts/studio-runtime-deployments/current.json", record);
    dockerResponses.set(JSON.stringify(["image", "inspect", record.imageId]), JSON.stringify([{ Id: record.imageId, Config: { Labels: { "io.yummyai.studio.bundle": record.bundleId } } }]));
    dockerResponses.set(JSON.stringify(["image", "inspect", record.entryImageId]), JSON.stringify([{ Id: record.entryImageId, RepoDigests: ["node@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6"] }]));
    for (const [index, name] of names.entries()) {
      dockerResponses.set(JSON.stringify(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"]), name);
      dockerResponses.set(JSON.stringify(["inspect", name]), JSON.stringify([containers[index]]));
    }
    for (const [index, name] of networkNames.entries()) {
      dockerResponses.set(JSON.stringify(["network", "ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"]), name);
      dockerResponses.set(JSON.stringify(["network", "inspect", name]), JSON.stringify([{ Driver: "bridge", Internal: !index,
        Labels: { "com.docker.compose.project": "yummyai", "com.docker.compose.network": index ? "studio-runtime-entry" : "studio-runtime" },
        Options: index ? { "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1" } : { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" }, Containers: Object.fromEntries(containers.slice(index ? 1 : 0).map(value => [value.Id, {}])) }]));
    }
    const { mock } = await import("node:test");
    mock.module(new URL("../scripts/studio-runtime-artifact.mjs", import.meta.url).href, { namedExports: { verifyStudioRuntime: async () => ({ id: record.bundleId }) } });
  }
  nodeFs.lstat = async () => {
    audit({ kind: "filesystem-read" });
    if (mode === "blocked") throw rejected("PRIVATE_READ_BLOCKED");
    return { isFile: () => true, isSymbolicLink: () => false };
  };
  nodeFs.readFile = async file => {
    audit({ kind: "filesystem-read" });
    if (mode === "blocked") throw rejected("PRIVATE_READ_BLOCKED");
    const bytes = files.get(path.resolve(file).toLowerCase()); if (!bytes) throw rejected("ENOENT");
    return Buffer.from(bytes);
  };
  for (const method of ["writeFile", "appendFile", "mkdir", "unlink", "rm", "rename", "copyFile", "chmod"]) nodeFs[method] = async () => {
    audit({ kind: "filesystem-mutation", method }); throw rejected("FILESYSTEM_MUTATION_BLOCKED");
  };
  const fakeExec = (command, args) => {
    const docker = path.basename(command).toLowerCase() === "docker";
    audit({ kind: docker ? "docker" : "subprocess", verb: args?.[0] ?? "", mutation: args?.some(value => ["up", "rm", "create", "build", "pull", "down", "start", "stop"].includes(value)) ?? false });
    const response = docker && dockerResponses.get(JSON.stringify(args));
    if (response === undefined) throw rejected("SUBPROCESS_BLOCKED");
    return { stdout: response + "\n", stderr: "" };
  };
  childProcess.execFile = () => { audit({ kind: "subprocess" }); throw rejected("SUBPROCESS_BLOCKED"); };
  childProcess.execFile[promisify.custom] = async (command, args) => fakeExec(command, args);
  childProcess.execFileSync = (command, args) => fakeExec(command, args).stdout;
  childProcess.spawn = () => { audit({ kind: "subprocess" }); throw rejected("SUBPROCESS_BLOCKED"); };
  syncBuiltinESMExports();
  globalThis.fetch = async () => { audit({ kind: "network-fetch" }); throw rejected("FETCH_BLOCKED"); };
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function(options, ...args) {
    if (options?.port === 43981) { audit({ kind: "legacy-image-lock" }); throw rejected("LEGACY_IMAGE_LOCK_BLOCKED"); }
    return listen.call(this, options, ...args);
  };
} else {
  const { default: test, after } = await import("node:test");
  const scripts = { studio: fileURLToPath(new URL("../scripts/studio-runtime-deployment.mjs", import.meta.url)), compose: fileURLToPath(new URL("../scripts/unified-compose.mjs", import.meta.url)) };
  const ownedChildren = [];
  after(async () => {
    for (const launched of ownedChildren) {
      assert.ok(launched.exitCode !== null || launched.signalCode !== null);
      assert.throws(() => process.kill(launched.pid, 0), error => error.code === "ESRCH", "only the recorded synthetic child PID is probed after close");
    }
    const available = await acquireStartupGate(root); await closeStartupGate(available);
    process.stdout.write(JSON.stringify({ ownedChildrenExited: ownedChildren.length, workspaceGateReacquiredAndClosed: true, diskOutputs: 0 }) + "\n");
  });
  async function child(args, fixture = "blocked") {
    const inherited = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC", "PATHEXT", "OS", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"];
    const env = Object.fromEntries(inherited.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    Object.assign(env, { NODE_OPTIONS: "", NODE_NO_WARNINGS: "1", TSX_DISABLE_CACHE: "1", YUMMYAI_MAINTENANCE_SERIALIZATION_TEST: fixture });
    const launched = childProcess.spawn(process.execPath, [...(fixture === "healthy" ? ["--experimental-test-module-mocks"] : []), "--import", preload, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    ownedChildren.push(launched);
    let stdout = "", stderr = "", timedOut = false; const audit = [], messages = [];
    launched.stdout.on("data", bytes => { stdout += bytes; if (stdout.length > 65536) launched.kill(); });
    launched.stderr.on("data", bytes => { stderr += bytes; if (stderr.length > 65536) launched.kill(); });
    launched.on("message", value => { if (value.audit) audit.push(value.audit); else messages.push(value); });
    const timer = setTimeout(() => { timedOut = true; launched.kill(); }, 15_000);
    try {
      const exit = await new Promise((resolve, reject) => { launched.once("error", reject); launched.once("close", (code, signal) => resolve({ code, signal })); });
      assert.equal(timedOut, false, "owned synthetic CLI completed before its deadline");
      return { ...exit, stdout, stderr, audit, messages };
    } finally { clearTimeout(timer); if (launched.exitCode === null && launched.signalCode === null) launched.kill(); }
  }
  const commands = [
    ["Studio start", scripts.studio, ["start"]],
    ["Studio adopt", scripts.studio, ["adopt", `.artifacts/studio-runtime-deployments/${id("a")}/prepared.json`]],
    ["Studio recover", scripts.studio, ["recover"]],
    ["image set", scripts.compose, ["set-image", "--service", "sub2api", "--image", "weishaw/sub2api:v2"]],
    ["image rollback staging", scripts.compose, ["rollback-image", "--change", fixtureId]],
    ["image review", scripts.compose, ["review-image", "--change", fixtureId]],
    ["image adoption", scripts.compose, ["adopt-image", "--review", fixtureId, "--sha256", id("a")]],
    ["image recovery", scripts.compose, ["recover-image", "--transition", fixtureId, "--use", "before"]],
    ["unified start", scripts.compose, ["start"]],
    ["unified legacy start", scripts.compose, ["start-legacy"]],
    ["unified infrastructure start", scripts.compose, ["infrastructure", "up"]],
    ["unified capture", scripts.compose, ["capture"]],
  ];
  for (const [name, script, args] of commands) test(`an independent ${name} CLI rejects a held workspace gate before all private reads and Docker effects`, { timeout: 20_000 }, async () => {
    const gate = await acquireStartupGate(root);
    try {
      const result = await child([script, ...args]);
      assert.equal(result.code, 1); assert.equal(result.signal, null); assert.equal(result.stdout, "");
      assert.equal(result.stderr, "ORDINARY_RUNTIME_ANOTHER_START_IN_PROGRESS\n"); assert.deepEqual(result.audit, []);
    } finally { await closeStartupGate(gate); }
  });
  for (const [name, script, args] of [["Studio", scripts.studio, ["status"]], ["image", scripts.compose, ["image-status"]]]) test(`${name} status stays read only and can run while maintenance owns the gate`, { timeout: 20_000 }, async () => {
    const gate = await acquireStartupGate(root);
    try {
      const result = await child([script, ...args], "readonly"); assert.equal(result.code, 0); assert.equal(result.stderr, "");
      assert.equal(result.audit.some(row => row.kind !== "filesystem-read"), false);
      if (name === "Studio") assert.equal(JSON.parse(result.stdout), null);
      else assert.deepEqual(JSON.parse(result.stdout), { operation: "image-status", recoveryRequired: false, pending: [], reviewedAdoptions: 0, deploymentChanged: false });
    } finally { await closeStartupGate(gate); }
  });
  test("a healthy synthetic Studio pair is reused without Compose up and a borrowed gate remains owned by its caller", { timeout: 20_000 }, async () => {
    const source = `
      import assert from 'node:assert/strict';
      import { acquireStartupGate, assertStartupGate, closeStartupGate } from ${JSON.stringify(new URL("../scripts/runtime-startup-gate.mjs", import.meta.url).href)};
      import { startStudioRuntimeDeployment } from ${JSON.stringify(new URL("../scripts/studio-runtime-deployment.mjs", import.meta.url).href)};
      const root = ${JSON.stringify(root)}, gate = await acquireStartupGate(root);
      try {
        const result = await startStudioRuntimeDeployment({ startupGate: gate });
        assert.equal(result.bundleId, ${JSON.stringify(id("b"))}); assert.equal(result.health, 'healthy');
        assertStartupGate(root, gate);
        await assert.rejects(acquireStartupGate(root), /^Error: ORDINARY_RUNTIME_ANOTHER_START_IN_PROGRESS$/);
        process.send({ result: 'healthy_reused_borrow_retained' });
      } finally { await closeStartupGate(gate); }
      const released = await acquireStartupGate(root); await closeStartupGate(released);
    `;
    const result = await child(["--input-type=module", "--eval", source], "healthy");
    assert.equal(result.code, 0); assert.equal(result.stderr, ""); assert.deepEqual(result.messages, [{ result: "healthy_reused_borrow_retained" }]);
    assert.ok(result.audit.some(row => row.kind === "docker")); assert.equal(result.audit.some(row => row.mutation || !["docker", "filesystem-read"].includes(row.kind)), false);
  });
  test("all production mutations reject forged closed or cross-root gates before inner reservations or private reads", { timeout: 20_000 }, async () => {
    const source = `
      import assert from 'node:assert/strict';
      import { acquireStartupGate, closeStartupGate } from ${JSON.stringify(new URL("../scripts/runtime-startup-gate.mjs", import.meta.url).href)};
      import * as studio from ${JSON.stringify(new URL("../scripts/studio-runtime-deployment.mjs", import.meta.url).href)};
      import * as images from ${JSON.stringify(new URL("../scripts/unified-compose-image-lifecycle.mjs", import.meta.url).href)};
      const root = ${JSON.stringify(root)}, other = await acquireStartupGate(root + '/synthetic-uncreated-lock-root'), closed = await acquireStartupGate(root);
      await closeStartupGate(closed);
      const calls = gate => [
        () => studio.startStudioRuntimeDeployment({ startupGate: gate }),
        () => studio.adoptStudioRuntimeDeployment('unused', { startupGate: gate }),
        () => studio.recoverStudioRuntimeDeployment({ startupGate: gate }),
        () => images.setAppImage('sub2api', 'weishaw/sub2api:v2', { startupGate: gate }),
        () => images.stageAppImageRollback(${JSON.stringify(fixtureId)}, { startupGate: gate }),
        () => images.reviewAppImage(${JSON.stringify(fixtureId)}, { startupGate: gate }),
        () => images.adoptAppImage(${JSON.stringify(fixtureId)}, ${JSON.stringify(id("a"))}, { startupGate: gate }),
        () => images.recoverAppImageTransition(${JSON.stringify(fixtureId)}, 'before', { startupGate: gate }),
      ];
      try { for (const gate of [{ listening: true }, closed, other]) for (const operation of calls(gate))
        await assert.rejects(operation, /^Error: ORDINARY_RUNTIME_INVALID_STARTUP_GATE$/);
      } finally { await closeStartupGate(other); }
      process.send({ result: 'all_24_invalid_gate_calls_rejected' });
    `;
    const result = await child(["--input-type=module", "--eval", source]);
    assert.equal(result.code, 0); assert.equal(result.stderr, ""); assert.deepEqual(result.audit, []);
    assert.deepEqual(result.messages, [{ result: "all_24_invalid_gate_calls_rejected" }]);
  });
  test("production image borrowing keeps the global gate outside the legacy image lock and retains it after inner failure", { timeout: 20_000 }, async () => {
    const source = `
      import assert from 'node:assert/strict';
      import { acquireStartupGate, assertStartupGate, closeStartupGate } from ${JSON.stringify(new URL("../scripts/runtime-startup-gate.mjs", import.meta.url).href)};
      import { setAppImage } from ${JSON.stringify(new URL("../scripts/unified-compose-image-lifecycle.mjs", import.meta.url).href)};
      const root = ${JSON.stringify(root)}, gate = await acquireStartupGate(root);
      try {
        await assert.rejects(setAppImage('sub2api', 'weishaw/sub2api:v2', { startupGate: gate }), /^Error: SYNTHETIC_LEGACY_IMAGE_LOCK_BLOCKED$/);
        assertStartupGate(root, gate);
        await assert.rejects(acquireStartupGate(root), /^Error: ORDINARY_RUNTIME_ANOTHER_START_IN_PROGRESS$/);
      } finally { await closeStartupGate(gate); }
      const released = await acquireStartupGate(root); await closeStartupGate(released);
      process.send({ result: 'global_then_legacy_borrow_retained' });
    `;
    const result = await child(["--input-type=module", "--eval", source]);
    assert.equal(result.code, 0); assert.equal(result.stderr, ""); assert.deepEqual(result.audit, [{ kind: "legacy-image-lock" }]);
    assert.deepEqual(result.messages, [{ result: "global_then_legacy_borrow_retained" }]);
  });
}
