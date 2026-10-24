import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { parseEnv } from "node:util";
import { verifyLocalWebCandidate } from "./local-web-candidate.mjs";
import { acquireStartupGate, closeStartupGate } from "./runtime-startup-gate.mjs";
export { acquireStartupGate } from "./runtime-startup-gate.mjs";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const directory = ".artifacts/ordinary-runtime";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => { throw new Error(`ORDINARY_RUNTIME_${code}`); };
const hashPattern = /^[a-f0-9]{64}$/;

export function localPath(root, relative) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.split("/").some((part) => !part || part === "." || part === "..")) fail("INVALID_PATH");
  const absolute = path.resolve(root, relative);
  if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || !absolute.startsWith(path.resolve(root) + path.sep)) fail("INVALID_PATH");
  return absolute;
}

export function validateRuntimeManifest(value) {
  const keys = ["schemaVersion", "scope", "snapshot", "sourceManifest", "sourceManifestSha256", "sourceSha256", "sourceFiles", "migrations", "candidate", "buildId", "envSha256", "overlay", "overlaySha256", "storageEndpoint"];
  if (value?.schemaVersion === 2) keys.push("studioRuntime");
  if (!value || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) fail("INVALID_MANIFEST");
  if (![1, 2].includes(value.schemaVersion) || value.scope !== "adopted-personal-runtime" ||
      !/^\.artifacts\/ordinary-api-source-[A-Za-z0-9-]+$/.test(value.snapshot) ||
      !/^docs\/project-control\/checkpoints\/[A-Za-z0-9-]+\.json$/.test(value.sourceManifest) ||
      !/^\.artifacts\/ordinary-runtime-recovery-[A-Za-z0-9-]+\/storage\.env$/.test(value.overlay) ||
      !/^[a-f0-9]{32}$/.test(value.candidate) || !/^[A-Za-z0-9_-]{1,100}$/.test(value.buildId) ||
      !Number.isSafeInteger(value.sourceFiles) || value.sourceFiles < 1 ||
      !Number.isSafeInteger(value.migrations) || value.migrations < 1 ||
      [value.sourceManifestSha256, value.sourceSha256, value.envSha256, value.overlaySha256].some((hash) => !hashPattern.test(hash))) fail("INVALID_MANIFEST");
  if (value.schemaVersion === 2 && (!value.studioRuntime || Object.keys(value.studioRuntime).sort().join() !== "bundleId,deploymentSha256"
      || !hashPattern.test(value.studioRuntime.bundleId) || !hashPattern.test(value.studioRuntime.deploymentSha256))) fail("INVALID_STUDIO_PAIR");
  const endpoint = new URL(value.storageEndpoint);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !["9000", "19000", "19001", "19002", "19003"].includes(endpoint.port) ||
      endpoint.pathname !== "/" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) fail("UNTRUSTED_STORAGE_ENDPOINT");
  return value;
}

export function runtimePlans(root, manifest, environment) {
  validateRuntimeManifest(manifest);
  if (environment.WEB_AUTH_MODE !== "personal" || environment.FACTORY_PORTAL_ONLY === "1" ||
      environment.WEB_ORIGIN !== "http://localhost:3000" || environment.API_BASE_URL !== "http://127.0.0.1:8000" ||
      !environment.ERP_SESSION_ENCRYPTION_KEY || !environment.OIDC_ISSUER || !environment.DATABASE_URL ||
      !environment.LOCAL_OIDC_CLIENT_SECRET || Object.entries(environment).some(([key, value]) => /^(DEMO_|E2E_|YUMMYAI_TEST_)/.test(key) && value && value !== "0")) fail("PERSONAL_ENVIRONMENT_REQUIRED");
  const snapshot = localPath(root, manifest.snapshot);
  const files = [`--env-file=${path.join(root, ".env")}`, `--env-file=${localPath(root, manifest.overlay)}`];
  return [
    { component: "api", port: 8000, health: "http://127.0.0.1:8000/health", cwd: path.join(snapshot, "apps/api"),
      args: [...files, "--import", "tsx", "src/main.ts"], env: { NODE_ENV: "development", TSX_DISABLE_CACHE: "1", PORT: "8000" } },
    { component: "web", port: 3000, health: "http://localhost:3000/login", cwd: path.join(snapshot, ".artifacts/local-web-releases", manifest.candidate, "apps/web"),
      args: [...files, path.join(snapshot, "apps/web/node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "3000"],
      env: { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
        CANVAS_STUDIO_PRODUCTION_ENABLED: manifest.studioRuntime ? "1" : "0", CANVAS_STUDIO_URL: "http://127.0.0.1:4176" } },
  ];
}

export function componentDecision({ listening, healthy, identity, expected, listenerPid }) {
  if (!listening) {
    if (identity) fail("OWNED_PROCESS_UNHEALTHY");
    return "missing";
  }
  if (!expected || !identity || identity.pid !== expected.pid || identity.creationDate !== expected.creationDate ||
      identity.commandSha256 !== expected.commandSha256 || listenerPid !== expected.listenerPid) fail("UNRECOGNIZED_LISTENER");
  if (!healthy) fail("OWNED_PROCESS_UNHEALTHY");
  return "reuse";
}

export function runtimeEnvironment(base, overrides = {}, inherited = process.env) {
  const operatingSystemKeys = new Set(["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC", "PATHEXT", "OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]);
  if (base.NODE_OPTIONS || base.NODE_PATH) fail("NODE_INJECTION_UNSUPPORTED");
  return { ...Object.fromEntries(Object.entries(inherited).filter(([key]) => operatingSystemKeys.has(key))), ...base, ...overrides };
}

export function applyStorageOverlay(base, overlay, manifest) {
  if (Object.keys(overlay).length !== 1 || overlay.S3_ENDPOINT !== manifest.storageEndpoint) fail("INVALID_STORAGE_OVERLAY");
  // Node preserves inherited variables ahead of --env-file; pass the validated
  // effective endpoint, rather than reintroducing the old base-file endpoint.
  return { ...base, ...overlay };
}

export async function stopSpawnedChildren(children) {
  await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    if (!child.pid || child.exitCode !== null || child.signalCode) { resolve(); return; }
    const timer = setTimeout(() => { child.removeListener("exit", done); reject(Error("ORDINARY_RUNTIME_OWNED_CHILD_CLEANUP_FAILED")); }, 5000);
    function done() { clearTimeout(timer); resolve(); }
    child.once("exit", done);
    if (!child.killed) child.kill();
  })));
}

export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const command = `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress`;
  const output = execFileSync("pwsh", ["-NoProfile", "-Command", command], { encoding: "utf8", windowsHide: true }).trim();
  if (!output) return null;
  const value = JSON.parse(output);
  if (value.ProcessId !== pid || !value.CommandLine || !value.CreationDate) fail("PROCESS_IDENTITY_UNAVAILABLE");
  return { pid, parentPid: value.ParentProcessId, creationDate: value.CreationDate, commandSha256: sha(value.CommandLine) };
}

function listenerPid(port) {
  const command = `@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) | ConvertTo-Json -Compress`;
  const output = execFileSync("pwsh", ["-NoProfile", "-Command", command], { encoding: "utf8", windowsHide: true }).trim();
  if (!output) return null;
  const value = JSON.parse(output), values = Array.isArray(value) ? value : [value];
  if (values.length !== 1 || !Number.isSafeInteger(values[0])) fail("AMBIGUOUS_LISTENER");
  return values[0];
}

async function portListening(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(2000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", (error) => { socket.destroy(); if (error.code === "ECONNREFUSED") resolve(false); else reject(Error("ORDINARY_RUNTIME_PORT_STATE_UNKNOWN")); });
    socket.once("timeout", () => { socket.destroy(); reject(Error("ORDINARY_RUNTIME_PORT_STATE_UNKNOWN")); });
  });
}

async function health(url) {
  try { const response = await globalThis.fetch(url, { signal: globalThis.AbortSignal.timeout(5000), redirect: "manual" }); await response.body?.cancel(); return response.status === 200; }
  catch { return false; }
}

async function regular(root, relative) {
  const absolute = localPath(root, relative), stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || path.resolve(await fs.realpath(absolute)).toLowerCase() !== absolute.toLowerCase()) fail("FILE_NOT_REGULAR");
  return fs.readFile(absolute);
}

async function prepare(root) {
  const manifestBytes = await regular(root, directory + "/current.json");
  const manifest = validateRuntimeManifest(JSON.parse(manifestBytes));
  const base = await regular(root, ".env"), overlay = await regular(root, manifest.overlay), sourceBytes = await regular(root, manifest.sourceManifest);
  if (sha(base) !== manifest.envSha256 || sha(overlay) !== manifest.overlaySha256 || sha(sourceBytes) !== manifest.sourceManifestSha256) fail("CONFIGURATION_CHANGED");
  const environment = applyStorageOverlay(parseEnv(base.toString()), parseEnv(overlay.toString()), manifest);
  const plans = runtimePlans(root, manifest, environment), source = JSON.parse(sourceBytes);
  if (source.algorithm !== "runtime-source-v1" || source.sha256 !== manifest.sourceSha256 || source.files.length !== manifest.sourceFiles || sha(JSON.stringify(source.files)) !== manifest.sourceSha256) fail("SOURCE_MANIFEST_CHANGED");
  const snapshot = localPath(root, manifest.snapshot);
  for (const file of source.files) if (sha(await regular(snapshot, file.path)) !== file.sha256) fail("ADOPTED_SOURCE_CHANGED");
  const candidate = await verifyLocalWebCandidate(snapshot, manifest.candidate);
  if (candidate.manifest.sourceSha256 !== manifest.sourceSha256 || candidate.manifest.buildId !== manifest.buildId) fail("CANDIDATE_PAIR_CHANGED");
  const state = JSON.parse(await regular(root, directory + "/state.json"));
  if (state.schemaVersion !== 1 || state.manifestSha256 !== sha(manifestBytes)) fail("RUNTIME_STATE_CHANGED");
  if (manifest.studioRuntime) {
    const studioBytes = await regular(root, ".artifacts/studio-runtime-deployments/current.json");
    if (sha(studioBytes) !== manifest.studioRuntime.deploymentSha256 || JSON.parse(studioBytes).bundleId !== manifest.studioRuntime.bundleId) fail("STUDIO_PAIR_CHANGED");
    const { checkStudioRuntimeDeployment } = await import("./studio-runtime-deployment.mjs");
    await checkStudioRuntimeDeployment();
  }
  return { manifest, manifestSha256: sha(manifestBytes), environment, plans, state };
}

async function inspect(prepared) {
  const result = [];
  for (const plan of prepared.plans) {
    const listening = await portListening(plan.port), expected = prepared.state.components[plan.component];
    const identity = expected ? processIdentity(expected.pid) : null;
    const owner = listening ? listenerPid(plan.port) : null;
    const listener = owner ? processIdentity(owner) : null;
    if (listening && plan.component === "web" && expected?.listenerPid !== identity?.pid && listener?.parentPid !== identity?.pid) fail("UNRECOGNIZED_LISTENER");
    const decision = componentDecision({ listening, identity, expected, listenerPid: owner, healthy: listening && await health(plan.health) });
    result.push({ component: plan.component, decision, pid: identity?.pid ?? null, listenerPid: owner });
  }
  return result;
}

async function writeState(root, state) {
  const file = localPath(root, directory + "/state.json"), temporary = file + `.${process.pid}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { flag: "wx" }); await fs.rename(temporary, file); }
  finally { await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
}

async function databaseMigrations(root, prepared) {
  let check;
  try {
    check = execFileSync(process.execPath, ["--env-file=" + path.join(root, ".env"), "--import", "./apps/api/node_modules/tsx/dist/loader.mjs", "packages/database/src/migrate.ts", "--check"],
      { cwd: localPath(root, prepared.manifest.snapshot), env: runtimeEnvironment(prepared.environment, { TSX_DISABLE_CACHE: "1" }), encoding: "utf8", windowsHide: true, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch { fail("DATABASE_NOT_READY"); }
  try {
    const migrations = JSON.parse(check.trim()).migrations;
    if (!Number.isSafeInteger(migrations) || migrations < 1) fail("DATABASE_NOT_READY");
    return migrations;
  } catch { fail("DATABASE_NOT_READY"); }
}

async function startMissingComponents(root, prepared, { children, assertNotInterrupted }) {
  prepared.state = JSON.parse(await regular(root, directory + "/state.json"));
  if (prepared.state.manifestSha256 !== prepared.manifestSha256) fail("RUNTIME_STATE_CHANGED");
  // All callers already hold the coordination gate; recheck the live owner
  // immediately before each missing component is allowed to be created.
  const locked = await inspect(prepared);
  for (const plan of prepared.plans) {
    if (locked.find((row) => row.component === plan.component).decision === "reuse") continue;
    assertNotInterrupted();
    if (plan.component === "web") {
        // Reuse the original production identity/environment gate and verified
        // immutable candidate. Start Next directly so Windows shutdown has one
        // owned application PID rather than relying on launcher signal forwarding.
        try {
          execFileSync(process.execPath, ["--env-file=" + path.join(root, ".env"), "--env-file=" + localPath(root, prepared.manifest.overlay), "tools/scripts/check-web-env.mjs", "--production"],
            { cwd: localPath(root, prepared.manifest.snapshot), env: runtimeEnvironment(prepared.environment, plan.env), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
        } catch { fail("PERSONAL_WEB_PREFLIGHT_FAILED"); }
    }
    assertNotInterrupted();
    const child = spawn(process.execPath, plan.args, { cwd: plan.cwd, env: runtimeEnvironment(prepared.environment, plan.env), stdio: "inherit", windowsHide: true });
    children.push(child);
    let spawnError = false;
    child.once("error", () => { spawnError = true; });
    const deadline = Date.now() + 45_000;
    while (!await health(plan.health)) {
      assertNotInterrupted();
      if (spawnError || child.exitCode !== null || child.signalCode || Date.now() > deadline) fail("START_FAILED");
      await delay(250);
    }
    const identity = processIdentity(child.pid), owner = listenerPid(plan.port), listener = processIdentity(owner);
    if (!identity || owner !== child.pid || !listener) fail("START_IDENTITY_MISMATCH");
    prepared.state.components[plan.component] = { ...identity, listenerPid: owner };
    prepared.state.updatedAt = new Date().toISOString();
    await writeState(root, prepared.state);
  }
}

async function waitForChildren(children) {
  await Promise.all(children.map(child => new Promise(resolve => {
    if (!child.pid || child.exitCode !== null || child.signalCode) resolve();
    else child.once("exit", resolve);
  })));
}

/** Explicit module DI exercises the real orchestration without connecting test
 * doubles to business resources. There is no CLI or environment override. */
export function createOrdinaryRuntimeRunner({ acquireGate = acquireStartupGate, closeGate = closeStartupGate,
  prepareRuntime = prepare,
  studioRuntime = async (mode, gate) => {
    const studio = await import("./studio-runtime-deployment.mjs");
    return mode === "start" ? studio.startStudioRuntimeDeployment({ startupGate: gate }) : studio.checkStudioRuntimeDeployment({ live: true });
  },
  verifyStorage = prepared => health(prepared.manifest.storageEndpoint + "/minio/health/live"),
  databaseMigrations: readDatabaseMigrations = databaseMigrations, inspectRuntime = inspect,
  startMissing = startMissingComponents, stopChildren = stopSpawnedChildren, waitChildren = waitForChildren,
  reportStarted = report => process.stdout.write(JSON.stringify(report) + "\n"), signals = process } = {}) {
  return async (root, mode) => {
    if (!["status", "start"].includes(mode)) fail("USE_DAILY_STATUS_OR_START");
    if (process.platform !== "win32" || !/^v24\.17\./.test(process.version)) fail("SUPPORTED_WINDOWS_NODE_REQUIRED");
    const children = [];
    let interrupted = false, cleanup;
    const assertNotInterrupted = () => { if (interrupted) fail("START_INTERRUPTED"); };
    const cleanupOwned = () => cleanup ??= (async () => {
      try { await stopChildren(children); }
      catch (error) {
        // A timeout is not proof that a pending kill has finished. Keep the
        // gate until owned exits are observed, so another start cannot reuse
        // a process that this failed owner may still terminate.
        await waitChildren(children);
        throw error;
      }
    })();
    const stopOwned = () => { interrupted = true; void cleanupOwned().catch(() => {}); };
    const gate = mode === "start" ? await acquireGate(root) : null;
    if (gate) { signals.once("SIGINT", stopOwned); signals.once("SIGTERM", stopOwned); }
    try {
      let report;
      try {
        try {
          const prepared = await prepareRuntime(root);
          assertNotInterrupted();
          const studio = prepared.manifest.studioRuntime ? await studioRuntime(mode, gate ?? undefined) : null;
          assertNotInterrupted();
          if (!await verifyStorage(prepared)) fail("STORAGE_UNAVAILABLE");
          assertNotInterrupted();
          if (await readDatabaseMigrations(root, prepared) !== prepared.manifest.migrations) fail("DATABASE_PAIR_CHANGED");
          assertNotInterrupted();
          const observations = await inspectRuntime(prepared);
          report = { mode, recordedAt: new Date().toISOString(), sourceSha256: prepared.manifest.sourceSha256, migrations: prepared.manifest.migrations,
            candidate: prepared.manifest.candidate, buildId: prepared.manifest.buildId, components: observations,
            ...(studio ? { studioRuntime: studio } : {}), backgroundConsumersStarted: false, noSecurityPolicyChanged: true };
          assertNotInterrupted();
          if (mode === "status" || observations.every(row => row.decision === "reuse")) return report;
          await startMissing(root, prepared, { children, assertNotInterrupted });
          assertNotInterrupted();
          report.components = await inspectRuntime(prepared);
          if (report.components.some(row => row.decision !== "reuse")) fail("START_FAILED");
          assertNotInterrupted();
        } catch (error) {
          if (gate) {
            try { await cleanupOwned(); }
            catch (cleanupError) { throw new AggregateError([error, cleanupError], "ORDINARY_RUNTIME_OWNED_CHILD_CLEANUP_FAILED"); }
          }
          throw error;
        }
      } finally {
        if (gate) await closeGate(gate);
      }
      reportStarted(report);
      await waitChildren(children);
      return null;
    } finally {
      if (gate) { signals.removeListener("SIGINT", stopOwned); signals.removeListener("SIGTERM", stopOwned); }
    }
  };
}

export const runOrdinaryRuntime = createOrdinaryRuntimeRunner();

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) fail("USE_DAILY_STATUS_OR_START");
    const result = await runOrdinaryRuntime(workspace, process.argv[2]);
    if (result) process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    const message = error instanceof Error && /^(?:ORDINARY_RUNTIME|STUDIO_DEPLOYMENT)_[A-Z_]+$/.test(error.message) ? error.message : "ORDINARY_RUNTIME_PREFLIGHT_FAILED";
    process.stderr.write(message + "\n"); process.exitCode = 1;
  }
}
