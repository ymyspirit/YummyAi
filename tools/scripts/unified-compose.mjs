import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { withStartupGate } from "./runtime-startup-gate.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildUnifiedCompose, escapeComposeDollars, inspectComparable } from "./lib/unified-compose-model.mjs";

const exec = promisify(execFile);
export const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const runtimeDirectory = path.join(workspace, ".artifacts/yummyai-compose");
export const composeEntry = path.join(workspace, "infra/compose.yummyai.yml");
export const containerNames = Object.freeze([
  "infra-postgres-1", "infra-redis-1", "infra-minio-1", "infra-keycloak-1",
  "infra-clamav-1", "infra-otel-collector-1", "sub2api", "sub2api-postgres",
  "sub2api-redis", "yummyai-canvas-canvas-1",
]);
export const activeServices = Object.freeze([
  "postgres", "redis", "minio", "keycloak", "clamav", "otel-collector",
  "sub2api-postgres", "sub2api-redis", "sub2api",
]);
export const sha256 = value => createHash("sha256").update(value).digest("hex");
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
export const comparableHash = (value, options) => sha256(stable(inspectComparable(value, options)));
const fail = code => { throw new Error(`UNIFIED_COMPOSE_${code}`); };
const literalComposeValue = value => typeof value === "string" ? value.replaceAll("$$", "$") :
  Array.isArray(value) ? value.map(literalComposeValue) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, literalComposeValue(item)])) : value;
function durationNanoseconds(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string") fail("HEALTH_CONFIGURATION_CHANGED");
  const units = { ns: 1, us: 1000, "µs": 1000, ms: 1e6, s: 1e9, m: 60e9, h: 3600e9 };
  let total = 0, position = 0;
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) {
    if (match.index !== position) fail("HEALTH_CONFIGURATION_CHANGED");
    total += Number(match[1]) * units[match[2]]; position += match[0].length;
  }
  if (position !== value.length || !Number.isSafeInteger(total)) fail("HEALTH_CONFIGURATION_CHANGED");
  return total;
}

// Never forward command stderr: Docker's configuration/health errors may contain
// expanded environment variables. Full configuration is private, not a log.
export async function docker(args, options = {}) {
  try {
    return await exec("docker", args, { cwd: workspace, windowsHide: true,
      maxBuffer: 32 * 1024 * 1024, timeout: 120_000, ...options });
  } catch { fail("DOCKER_COMMAND_FAILED"); }
}

export async function assertOwnedPath(absolute) {
  absolute = path.resolve(absolute);
  const relative = path.relative(workspace, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("PATH_OUTSIDE_WORKSPACE");
  let cursor = absolute;
  while (cursor !== workspace) {
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) fail("LINKED_PATH"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    cursor = path.dirname(cursor);
  }
  return absolute;
}

export async function protectDirectory(directory, { fresh = false } = {}) {
  await assertOwnedPath(directory);
  if (fresh) {
    try { await fs.lstat(directory); fail("OUTPUT_EXISTS"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    let identity;
    try {
      const { stdout } = await exec("whoami", ["/user", "/fo", "csv", "/nh"], { windowsHide: true });
      identity = stdout.match(/S-1-5-[\d-]+/)?.[0];
      if (!identity) fail("ACL_IDENTITY_UNAVAILABLE");
      await exec("icacls", [directory, "/inheritance:r", "/grant:r", `*${identity}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { windowsHide: true });
    } catch { fail("PRIVATE_ACL_FAILED"); }
  } else await fs.chmod(directory, 0o700);
}

export async function writePrivate(file, value, { fresh = true } = {}) {
  await assertOwnedPath(file);
  const text = JSON.stringify(value, null, 2) + "\n";
  if (fresh) await fs.writeFile(file, text, { flag: "wx", mode: 0o600 });
  else {
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(temporary, text, { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, file);
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  return sha256(text);
}

export async function currentContainers() {
  return JSON.parse((await docker(["inspect", ...containerNames])).stdout);
}

export async function readRuntime() {
  const { requireNoAppImageTransition, readAppImageAdoptions } = await import("./unified-compose-image-lifecycle.mjs");
  await requireNoAppImageTransition();
  const files = ["manifest.json", "runtime.json", "baseline.private.json"];
  for (const file of files) {
    const absolute = await assertOwnedPath(path.join(runtimeDirectory, file));
    if (!(await fs.lstat(absolute)).isFile()) fail("CONFIGURATION_NOT_REGULAR");
  }
  const manifest = JSON.parse(await fs.readFile(path.join(runtimeDirectory, "manifest.json"), "utf8"));
  const runtimeBytes = await fs.readFile(path.join(runtimeDirectory, "runtime.json"));
  const baselineBytes = await fs.readFile(path.join(runtimeDirectory, "baseline.private.json"));
  if (manifest.version !== 1 || manifest.project !== "yummyai" ||
      sha256(runtimeBytes) !== manifest.runtimeSha256 || sha256(baselineBytes) !== manifest.baselineSha256) fail("CONFIGURATION_CHANGED");
  const model = JSON.parse(runtimeBytes);
  return { manifest, model, baseline: JSON.parse(baselineBytes),
    adoptedInspections: await readAppImageAdoptions(manifest, model) };
}

/** A reviewed app replacement changes only its own expected inspection. The
 * original capture remains immutable and every other service stays exact. */
export function expectedCoreInspection(runtime, before) {
  return runtime.adoptedInspections?.get(before.name)
    ?? runtime.baseline.inspections.find(row => row.Id === before.id);
}

export async function compareLiveCore(runtime, { exceptService } = {}) {
  const daemonSecurityOptions = JSON.parse((await docker(["info", "--format", "{{json .SecurityOptions}}"])).stdout);
  const platform = { daemonSecurityOptions }, actual = await currentContainers();
  return compareCoreContainerSnapshots(runtime, actual, platform, { exceptService });
}

export function compareCoreContainerSnapshots(runtime, actual, platform, { exceptService } = {}) {
  const { manifest, model } = runtime, { daemonSecurityOptions } = platform;
  let liveCount = 0, inactiveSelinuxMarkers = 0, currentRunning = 0, legacyRunning = false;
  for (const before of manifest.original) {
    const original = expectedCoreInspection(runtime, before);
    const now = actual.find(row => row.Name.replace(/^\//, "") === before.name);
    const service = Object.entries(model.services).find(([, definition]) => definition.container_name === before.name)?.[0];
    const optionalLegacy = service === "canvas-legacy";
    if (!original || !now || now.Config.Labels["com.docker.compose.project"] !== "yummyai"
        || now.Config.Labels["com.docker.compose.service"] !== service) fail("LIVE_BASELINE_CHANGED");
    if (service !== exceptService && (comparableHash(now, platform) !== comparableHash(original, platform)
        || (!optionalLegacy && now.State.Running !== before.running)
        || (now.State.Running && now.State.Health?.Status !== "healthy"))) fail("LIVE_BASELINE_CHANGED");
    if (now.State.Running) currentRunning++;
    if (optionalLegacy) legacyRunning = now.State.Running;
    if (!daemonSecurityOptions.some(value => /(?:^|,)\s*name=selinux(?:,|$)/i.test(value))) {
      inactiveSelinuxMarkers += original.Mounts.filter(mount => mount.Type === "bind" &&
        /(?:^|,)[zZ](?:,|$)/.test(mount.Mode || "") &&
        !(now.Mounts.find(value => value.Destination === mount.Destination)?.Mode || "").match(/(?:^|,)[zZ](?:,|$)/)).length;
    }
    liveCount++;
  }
  return { actual, platform, liveCount, inactiveSelinuxMarkers, currentRunning, legacyRunning };
}

async function captureUnlocked() {
  const inspections = await currentContainers();
  const imageIds = [...new Set(inspections.map(row => row.Image))];
  const images = JSON.parse((await docker(["image", "inspect", ...imageIds])).stdout);
  const { model, summary } = buildUnifiedCompose({ inspections, images, project: "yummyai" });
  await protectDirectory(runtimeDirectory, { fresh: true });
  const baselineSha256 = await writePrivate(path.join(runtimeDirectory, "baseline.private.json"), { inspections, images });
  const included = { ...model };
  delete included.name;
  const runtimeSha256 = await writePrivate(path.join(runtimeDirectory, "runtime.json"), escapeComposeDollars(included));
  const manifest = { version: 1, project: "yummyai", recordedAt: new Date().toISOString(),
    baselineSha256, runtimeSha256, summary,
    original: inspections.map(row => ({ name: row.Name.replace(/^\//, ""), id: row.Id,
      project: row.Config.Labels["com.docker.compose.project"], service: row.Config.Labels["com.docker.compose.service"],
      running: row.State.Running, imageId: row.Image, comparableSha256: comparableHash(row) })),
    imageChanges: [], activeServices, backgroundConsumersStarted: false };
  await writePrivate(path.join(runtimeDirectory, "manifest.json"), manifest);
  return { operation: "capture", project: "yummyai", containers: inspections.length,
    runtimeSha256, baselineSha256, running: inspections.filter(row => row.State.Running).length, sourceUntouched: true };
}

export async function capture(options = {}) {
  return withStartupGate(workspace, captureUnlocked, options.startupGate);
}

export async function check({ live = false } = {}) {
  const runtime = await readRuntime(), { manifest, model } = runtime;
  const resolved = JSON.parse((await docker(["compose", "-p", "yummyai", "-f", composeEntry,
    "--profile", "legacy-canvas", "config", "--format", "json"])).stdout);
  if (resolved.name !== "yummyai" || Object.keys(resolved.services).length !== 10 ||
      Object.keys(model.services).sort().join() !== Object.keys(resolved.services).sort().join()) fail("SERVICE_SET_CHANGED");
  for (const [service, definition] of Object.entries(model.services)) {
    const expected = definition.environment || {};
    for (const [key, value] of Object.entries(expected)) {
      // Only the serializer introduces doubled dollars, never the original value.
      if (resolved.services[service].environment?.[key] !== value.replaceAll("$$", "$")) fail("ENVIRONMENT_INTERPOLATION_CHANGED");
    }
    if (resolved.services[service].container_name !== definition.container_name || resolved.services[service].image !== definition.image) fail("SERVICE_IDENTITY_CHANGED");
    // `compose config` re-escapes process/health arguments for a reusable
    // Compose document. Environment values are already literal. The separate
    // create-only wire check verifies the final Engine arguments as well.
    for (const field of ["command", "entrypoint"]) {
      if (Object.hasOwn(definition, field) && stable(resolved.services[service][field] ?? []) !== stable(definition[field])) fail("PROCESS_ARGUMENT_INTERPOLATION_CHANGED");
    }
    if (definition.healthcheck) {
      const expectedHealth = literalComposeValue(definition.healthcheck), actualHealth = resolved.services[service].healthcheck || {};
      for (const field of ["test", "disable", "retries"]) {
        if (Object.hasOwn(expectedHealth, field) && stable(definition.healthcheck[field]) !== stable(actualHealth[field])) fail("HEALTH_CONFIGURATION_CHANGED");
      }
      for (const field of ["interval", "timeout", "start_period", "start_interval"]) {
        if (Object.hasOwn(expectedHealth, field) && durationNanoseconds(expectedHealth[field]) !== durationNanoseconds(actualHealth[field])) fail("HEALTH_CONFIGURATION_CHANGED");
      }
    }
  }
  let liveCount = 0, inactiveSelinuxMarkers = 0, currentRunning = 0, legacyRunning = false;
  if (live) {
    if (manifest.imageChanges.length) fail("BASELINE_CHECK_REQUIRES_REVIEWED_IMAGE_CHANGE");
    // Apply the same daemon-aware mount normalization to original and reviewed
    // snapshots, without replacing either immutable private record.
    ({ liveCount, inactiveSelinuxMarkers, currentRunning, legacyRunning } = await compareLiveCore(runtime));
  }
  const { checkStudioRuntimeDeployment } = await import("./studio-runtime-deployment.mjs");
  const studioRuntime = await checkStudioRuntimeDeployment({ live });
  return { operation: "check", project: resolved.name, services: 10 + (studioRuntime?.containerCount ?? 0), coreBaselineServices: 10, configurationValid: true,
    secretInterpolationPreserved: true, liveBaselineVerified: liveCount,
    inactiveSelinuxMarkerBindingsNormalized: inactiveSelinuxMarkers, currentRunning, optionalLegacyRunning: legacyRunning,
    ...(studioRuntime ? { studioRuntime } : {}), backgroundConsumersStarted: false };
}

export async function status() {
  const { manifest } = await readRuntime();
  const containers = await currentContainers();
  const { checkStudioRuntimeDeployment } = await import("./studio-runtime-deployment.mjs");
  const studioRuntime = await checkStudioRuntimeDeployment({ live: true });
  return { operation: "status", project: "yummyai", adopted: containers.every(row => row.Config.Labels["com.docker.compose.project"] === "yummyai"),
    containers: containers.map(row => ({ name: row.Name.replace(/^\//, ""),
      service: row.Config.Labels["com.docker.compose.service"], project: row.Config.Labels["com.docker.compose.project"],
      state: row.State.Status, health: row.State.Health?.Status || null, imageId: row.Image })).concat(studioRuntime ? [{
        name: studioRuntime.name, service: studioRuntime.service, project: "yummyai", state: studioRuntime.state,
        health: studioRuntime.health, imageId: studioRuntime.imageId }, {
        name: "yummyai-studio-runtime-entry", service: "studio-runtime-entry", project: "yummyai", state: studioRuntime.state,
        health: studioRuntime.health, imageId: studioRuntime.entryImageId }] : []),
    baselineRecordedAt: manifest.recordedAt, imageChanges: manifest.imageChanges.length,
    reviewedImageAdoptions: manifest.imageAdoptions?.length ?? 0, backgroundConsumersStarted: false };
}

export async function managedDeploymentExists() {
  try {
    const marker = path.join(runtimeDirectory, "adopted.json");
    await assertOwnedPath(marker);
    const value = JSON.parse(await fs.readFile(marker, "utf8"));
    if (value.version !== 1 || value.project !== "yummyai" || value.status !== "adopted") fail("INVALID_ADOPTION_RECORD");
    return true;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function startServices(services, { legacy = false, startupGate } = {}) {
 return withStartupGate(workspace, async gate => {
  if ((await readRuntime()).manifest.imageChanges.length) fail("IMAGE_CHANGE_PENDING_USE_TARGETED_DEPLOY");
  await check();
  await docker(["compose", "-p", "yummyai", "-f", composeEntry,
    ...(legacy ? ["--profile", "legacy-canvas"] : []),
    "up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "240", ...services], { timeout: 300_000 });
  if (services.length === activeServices.length && activeServices.every(service => services.includes(service))) {
    const { startStudioRuntimeDeployment } = await import("./studio-runtime-deployment.mjs");
    await startStudioRuntimeDeployment({ startupGate: gate });
  }
  return { operation: "start", project: "yummyai", services, backgroundConsumersStarted: false };
 }, startupGate);
}

// Keep existing package commands usable on fresh checkouts and after adoption.
// Neither path starts the application Worker.
async function infrastructure(mode) {
 return withStartupGate(workspace, async gate => {
  const selections = { up: ["postgres", "redis", "minio", "keycloak", "clamav", "otel-collector"],
    lite: ["postgres", "redis", "minio", "keycloak"], full: ["postgres", "redis", "minio", "keycloak", "clamav", "otel-collector"],
    "file-scanning": ["clamav"], observability: ["otel-collector"] };
  if (!selections[mode]) fail("INVALID_INFRASTRUCTURE_MODE");
  if (await managedDeploymentExists()) return startServices(selections[mode], { startupGate: gate });
  await docker(["compose", "--env-file", path.join(workspace, ".env"), "-f", path.join(workspace, "infra/docker-compose.yml"),
    ...(mode === "lite" ? ["-f", path.join(workspace, "infra/docker-compose.low-memory.yml")] : []),
    "up", "-d", ...selections[mode]], { timeout: 300_000 });
  return { operation: "infrastructure", mode, managed: false, backgroundConsumersStarted: false };
 });
}

async function startLegacy() {
 return withStartupGate(workspace, async gate => {
  if (await managedDeploymentExists()) return startServices(["canvas-legacy"], { legacy: true, startupGate: gate });
  await docker(["compose", "-f", path.join(workspace, "infra/infinite-canvas.compose.yml"), "up", "-d"], { timeout: 300_000 });
  return { operation: "start-legacy", managed: false, backgroundConsumersStarted: false };
 });
}

export async function setImage(service, image, options = {}) {
  const { setAppImage } = await import("./unified-compose-image-lifecycle.mjs");
  return setAppImage(service, image, options);
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === "capture" && !args.length) return capture();
  if (operation === "check" && (!args.length || args.join() === "--live")) return check({ live: !!args.length });
  if (operation === "status" && !args.length) return status();
  if (operation === "image-status" && !args.length) {
    const { appImageMaintenanceStatus } = await import("./unified-compose-image-lifecycle.mjs");
    return appImageMaintenanceStatus();
  }
  if (operation === "start" && !args.length) return startServices(activeServices);
  if (operation === "start-legacy" && !args.length) return startLegacy();
  if (operation === "infrastructure" && args.length === 1) return infrastructure(args[0]);
  if (operation === "set-image" && args.length === 4 && args[0] === "--service" && args[2] === "--image") return setImage(args[1], args[3]);
  if (["review-image", "rollback-image"].includes(operation) && args.length === 2 && args[0] === "--change") {
    const lifecycle = await import("./unified-compose-image-lifecycle.mjs");
    return operation === "review-image" ? lifecycle.reviewAppImage(args[1]) : lifecycle.stageAppImageRollback(args[1]);
  }
  if (operation === "adopt-image" && args.length === 4 && args[0] === "--review" && args[2] === "--sha256") {
    const { adoptAppImage } = await import("./unified-compose-image-lifecycle.mjs");
    return adoptAppImage(args[1], args[3]);
  }
  if (operation === "recover-image" && args.length === 4 && args[0] === "--transition" && args[2] === "--use") {
    const { recoverAppImageTransition } = await import("./unified-compose-image-lifecycle.mjs");
    return recoverAppImageTransition(args[1], args[3]);
  }
  fail("INVALID_ARGUMENTS");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Finish module evaluation before the optional deployment imports this module's
  // Docker helpers. A top-level await here deadlocks that legitimate import cycle.
  void main().then(result => process.stdout.write(JSON.stringify(result) + "\n")).catch(error => {
    process.stderr.write(error instanceof Error && /^(?:UNIFIED_COMPOSE|ORDINARY_RUNTIME)_[A-Z_]+$/.test(error.message) ? error.message + "\n" : "UNIFIED_COMPOSE_OPERATION_FAILED\n");
    process.exitCode = 1;
  });
}
