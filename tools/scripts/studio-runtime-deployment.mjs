import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { docker, assertOwnedPath, protectDirectory, writePrivate } from "./unified-compose.mjs";
import { verifyStudioRuntime } from "./studio-runtime-artifact.mjs";
import { studioGatewayProgram } from "./studio-runtime-gateway.mjs";
import { withStartupGate } from "./runtime-startup-gate.mjs";

const workspace = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const currentFile = ".artifacts/studio-runtime-deployments/current.json";
const transitionFile = ".artifacts/studio-runtime-deployments/transition.json";
const containerName = "yummyai-studio-runtime", networkName = "yummyai_studio-runtime";
const entryName = "yummyai-studio-runtime-entry", entryNetwork = "yummyai_studio-runtime-entry";
const nodeImage = "node:24.17.0-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6";
const sha = value => createHash("sha256").update(value).digest("hex");
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const fail = code => { throw new Error("STUDIO_DEPLOYMENT_" + code); };
const deploymentRoot = id => ".artifacts/studio-runtime-deployments/" + id;
const artifactManifest = id => ".artifacts/studio-runtime-releases/" + id + "/manifest.json";
const composeArgs = file => ["compose", "-p", "yummyai", "-f", path.join(workspace, "infra/compose.yummyai.yml"), "-f", file, "--profile", "legacy-canvas"];
async function regular(relative) {
  const file = await assertOwnedPath(path.join(workspace, relative));
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("RECORD_NOT_REGULAR");
  return fs.readFile(file);
}
function validate(record) {
  if (!record || record.version !== 2 || record.project !== "yummyai" || record.service !== "studio-runtime"
      || !/^[a-f0-9]{64}$/.test(record.bundleId) || !/^sha256:[a-f0-9]{64}$/.test(record.imageId)
      || !/^[a-f0-9]{64}$/.test(record.deploymentId) || !/^sha256:[a-f0-9]{64}$/.test(record.entryImageId)
      || !/^[a-f0-9]{64}$/.test(record.entryProgramSha256)
      || record.origin !== "http://127.0.0.1:4176" || record.artifactManifest !== artifactManifest(record.bundleId)
      || record.composeFile !== deploymentRoot(record.deploymentId) + "/compose.json"
      || !/^[a-f0-9]{64}$/.test(record.artifactManifestSha256) || !/^[a-f0-9]{64}$/.test(record.composeSha256)) fail("RECORD_INVALID");
  return record;
}
async function verifyRecord(record) {
  validate(record);
  if (sha(await regular(record.artifactManifest)) !== record.artifactManifestSha256
      || sha(await regular(record.composeFile)) !== record.composeSha256) fail("PIN_CHANGED");
  const artifact = await verifyStudioRuntime(path.join(workspace, record.artifactManifest));
  if (artifact.id !== record.bundleId) fail("PIN_CHANGED");
  const image = JSON.parse((await docker(["image", "inspect", record.imageId])).stdout)[0];
  if (image?.Id !== record.imageId || image.Config?.Labels?.["io.yummyai.studio.bundle"] !== record.bundleId) fail("IMAGE_CHANGED");
  const entryImage = JSON.parse((await docker(["image", "inspect", record.entryImageId])).stdout)[0];
  const command = JSON.parse((await regular(record.composeFile)).toString()).services?.["studio-runtime-entry"]?.command;
  if (entryImage?.Id !== record.entryImageId || !entryImage.RepoDigests?.some(value => value === "node@" + nodeImage.split("@")[1])
      || !Array.isArray(command) || command.length !== 3 || command[0] !== "node" || command[1] !== "-e"
      || sha(command[2].replaceAll("$$", "$")) !== record.entryProgramSha256) fail("ENTRY_CHANGED");
  return artifact;
}
async function readCurrent() {
  try { return validate(JSON.parse(await regular(currentFile))); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function pendingTransition() {
  try { return JSON.parse(await regular(transitionFile)); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function requireNoTransition() {
  if (await pendingTransition()) fail("RECOVERY_REQUIRED");
}
async function baselineFor(record) {
  if (record.baselineFile !== deploymentRoot(record.deploymentId) + "/baseline.json" || !/^[a-f0-9]{64}$/.test(record.baselineSha256)) fail("BASELINE_INVALID");
  const bytes = await regular(record.baselineFile);
  if (sha(bytes) !== record.baselineSha256) fail("BASELINE_CHANGED");
  const baseline = JSON.parse(bytes);
  if (sha(stable(baseline.comparable)) !== baseline.sha256) fail("BASELINE_CHANGED");
  return baseline;
}
export function normalizeStudioComparable(value) {
  const host = { ...value.HostConfig };
  // Engine restart may serialize unset Go DNS slices as [] rather than null.
  // Keep all explicit DNS settings and every other configuration field exact.
  for (const key of ["Dns", "DnsOptions", "DnsSearch"]) if (host[key] === null) host[key] = [];
  return { ...value, HostConfig: host };
}
function comparable(container) {
  return normalizeStudioComparable({ Config: container.Config, HostConfig: container.HostConfig, Mounts: container.Mounts,
    networks: Object.keys(container.NetworkSettings.Networks).sort() });
}
async function namedContainer(name = containerName) {
  const rows = (await docker(["ps", "-a", "--filter", "name=^/" + name + "$", "--format", "{{.Names}}"])).stdout.trim().split(/\r?\n/).filter(Boolean);
  if (!rows.length) return null;
  if (rows.length !== 1 || rows[0] !== name) fail("CONTAINER_AMBIGUOUS");
  return JSON.parse((await docker(["inspect", name])).stdout)[0];
}
async function namedNetwork(name = networkName) {
  const rows = (await docker(["network", "ls", "--filter", "name=^" + name + "$", "--format", "{{.Name}}"])).stdout.trim().split(/\r?\n/).filter(Boolean);
  if (!rows.length) return null;
  if (rows.length !== 1 || rows[0] !== name) fail("NETWORK_AMBIGUOUS");
  return JSON.parse((await docker(["network", "inspect", name])).stdout)[0];
}
function assertContainerOwner(container, record, entry = false) {
  if (container.Image !== (entry ? record.entryImageId : record.imageId) || container.Config.Labels?.["com.docker.compose.project"] !== "yummyai"
      || container.Config.Labels?.["com.docker.compose.service"] !== (entry ? "studio-runtime-entry" : "studio-runtime")
      || container.Config.Labels?.["io.yummyai.studio.bundle"] !== record.bundleId
      || container.Config.Labels?.["io.yummyai.studio.deployment"] !== record.deploymentId
      || container.Config.User !== "1000:1000" || !container.HostConfig.ReadonlyRootfs || container.HostConfig.Privileged
      || container.Mounts.length || stable(container.HostConfig.CapDrop) !== stable(["ALL"])
      || !container.HostConfig.SecurityOpt?.includes("no-new-privileges:true")
      || (entry ? stable(container.HostConfig.PortBindings) !== stable({ "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "4176" }] })
        : Object.keys(container.HostConfig.PortBindings ?? {}).length !== 0)
      || stable(Object.keys(container.NetworkSettings.Networks).sort()) !== stable((entry ? [networkName, entryNetwork] : [networkName]).sort())) fail("CONTAINER_CHANGED");
  if (entry && (container.Config.Cmd?.length !== 3 || container.Config.Cmd[0] !== "node" || container.Config.Cmd[1] !== "-e"
      || sha(container.Config.Cmd[2]) !== record.entryProgramSha256)) fail("ENTRY_COMMAND_CHANGED");
}
function assertActualPorts(container, entry) {
  if (container.State.Running && (entry
    ? stable(container.NetworkSettings.Ports) !== stable({ "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "4176" }] })
    : Object.values(container.NetworkSettings.Ports ?? {}).some(bindings => bindings?.length))) fail("LIVE_PORT_CHANGED");
}
function assertNetworkOwner(network, containers, entry = false, ownershipOnly = false) {
  if ((!ownershipOnly && network.Internal !== !entry) || network.Driver !== "bridge" || network.Labels?.["com.docker.compose.project"] !== "yummyai"
    || network.Labels?.["com.docker.compose.network"] !== (entry ? "studio-runtime-entry" : "studio-runtime")
    || (!ownershipOnly && !entry && network.Options?.["com.docker.network.bridge.gateway_mode_ipv4"] !== "isolated")
    || (!ownershipOnly && entry && network.Options?.["com.docker.network.bridge.host_binding_ipv4"] !== "127.0.0.1")
    || Object.keys(network.Containers ?? {}).some(id => !containers.some(container => container?.Id === id))) fail("NETWORK_CHANGED");
}
const comparablePair = pair => ({ runtime: comparable(pair.runtime), entry: comparable(pair.entry) });
async function inspectContainer(record, { allowPartial = false } = {}) {
  const runtime = await namedContainer(), entry = await namedContainer(entryName);
  if (!runtime && !entry) return null;
  if ((!runtime || !entry) && !allowPartial) fail("CONTAINER_PAIR_MISSING");
  if (runtime) { assertContainerOwner(runtime, record); assertActualPorts(runtime, false); }
  if (entry) { assertContainerOwner(entry, record, true); assertActualPorts(entry, true); }
  for (const isEntry of [false, true]) {
    const network = await namedNetwork(isEntry ? entryNetwork : networkName);
    if (!network) { if (allowPartial) continue; fail("NETWORK_MISSING"); }
    assertNetworkOwner(network, isEntry ? [entry] : [runtime, entry], isEntry);
  }
  return { runtime, entry };
}
async function confirmHealthy(record) {
  const container = await inspectContainer(record);
  if (!container || Object.values(container).some(item => !item.State.Running || item.State.Health?.Status !== "healthy")) fail("NOT_HEALTHY");
  const response = await globalThis.fetch(record.origin + "/health", { signal: globalThis.AbortSignal.timeout(5000), redirect: "error" });
  const health = await response.json();
  if (!response.ok || health.bundleId !== record.bundleId) fail("HEALTH_MISMATCH");
  return container;
}
async function up(record) {
  await docker([...composeArgs(path.join(workspace, record.composeFile)), "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180", "studio-runtime", "studio-runtime-entry"], { timeout: 240_000 });
}
async function verifyPrevious(record, { running = false, allowPartial = false } = {}) {
  await verifyRecord(record);
  const baseline = await baselineFor(record), container = await inspectContainer(record, { allowPartial });
  if (container) for (const role of ["runtime", "entry"]) {
    if (container[role] && stable(comparable(container[role])) !== stable(normalizeStudioComparable(baseline.comparable[role]))) fail("LIVE_CHANGED");
  }
  if (running) await confirmHealthy(record);
  return container;
}
async function clearTransition() {
  const file = await assertOwnedPath(path.join(workspace, transitionFile));
  await regular(transitionFile);
  await fs.unlink(file);
}
async function removeFirstAttempt(record) {
  const runtime = await namedContainer(), entry = await namedContainer(entryName);
  if (runtime) assertContainerOwner(runtime, record);
  if (entry) assertContainerOwner(entry, record, true);
  for (const isEntry of [false, true]) {
    const network = await namedNetwork(isEntry ? entryNetwork : networkName);
    if (network) assertNetworkOwner(network, isEntry ? [entry] : [runtime, entry], isEntry, true);
  }
  // Both services are stateless. Remove only their exact inspected IDs.
  for (const container of [entry, runtime]) if (container) await docker(["rm", "--force", container.Id]);
  for (const name of [entryNetwork, networkName]) {
    const network = await namedNetwork(name);
    if (network) { assertNetworkOwner(network, [], name === entryNetwork, true); await docker(["network", "rm", network.Id]); }
  }
  if (await namedContainer() || await namedContainer(entryName) || await namedNetwork() || await namedNetwork(entryNetwork)) fail("FIRST_ATTEMPT_CLEANUP_FAILED");
}
async function restoreTransition(journal) {
  if (!journal || journal.version !== 1 || journal.operation !== "studio-runtime-adoption"
    || typeof journal.startedAt !== "string") fail("TRANSITION_INVALID");
  const record = validate(journal.next);
  // The candidate may be precisely what failed verification. Its artifact or
  // image must never be a prerequisite for restoring a verified old version.
  let currentBytes;
  try { currentBytes = await regular(currentFile); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (currentBytes && ![journal.previous?.sha256, journal.nextCurrentSha256].filter(Boolean).includes(sha(currentBytes)))
    fail("CURRENT_CHANGED_DURING_TRANSITION");
  if (!currentBytes && journal.previous !== null) fail("CURRENT_CHANGED_DURING_TRANSITION");
  if (journal.previous !== null) {
    const previous = validate(journal.previous.record);
    if (!/^[a-f0-9]{64}$/.test(journal.previous.sha256)
      || sha(JSON.stringify(previous, null, 2) + "\n") !== journal.previous.sha256) fail("TRANSITION_INVALID");
    await verifyRecord(previous);
    await baselineFor(previous);
    const runtime = await namedContainer(), entry = await namedContainer(entryName);
    if (runtime) assertContainerOwner(runtime, runtime.Config.Labels?.["io.yummyai.studio.deployment"] === previous.deploymentId ? previous : record);
    if (entry) assertContainerOwner(entry, entry.Config.Labels?.["io.yummyai.studio.deployment"] === previous.deploymentId ? previous : record, true);
    for (const isEntry of [false, true]) {
      const network = await namedNetwork(isEntry ? entryNetwork : networkName);
      if (network) assertNetworkOwner(network, isEntry ? [entry] : [runtime, entry], isEntry);
    }
    await up(previous);
    await verifyPrevious(previous, { running: true });
    const restored = await writePrivate(path.join(workspace, currentFile), previous, { fresh: false });
    if (restored !== journal.previous.sha256) fail("RESTORE_POINTER_CHANGED");
  } else {
    const current = await readCurrent();
    if (current && current.deploymentId !== record.deploymentId) fail("CURRENT_CHANGED_DURING_TRANSITION");
    await removeFirstAttempt(record);
    if (current) {
      await regular(currentFile);
      await fs.unlink(await assertOwnedPath(path.join(workspace, currentFile)));
    }
  }
  await clearTransition();
}
export async function prepareStudioRuntimeDeployment(manifestPath) {
  const artifact = await verifyStudioRuntime(manifestPath);
  if (path.resolve(artifact.directory) !== path.join(workspace, ".artifacts/studio-runtime-releases", artifact.id)) fail("ARTIFACT_OUTSIDE_RELEASES");
  const tag = "yummyai/studio-runtime:" + artifact.id;
  await docker(["build", "--network=none", "--pull=false", "--label", "io.yummyai.studio.bundle=" + artifact.id,
    "--file", path.join(workspace, "infra/studio-runtime.Dockerfile"), "--tag", tag, artifact.directory], { timeout: 300_000 });
  const imageId = JSON.parse((await docker(["image", "inspect", tag])).stdout)[0].Id;
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) fail("IMAGE_INVALID");
  const entryImageId = JSON.parse((await docker(["image", "inspect", nodeImage])).stdout)[0].Id;
  if (!/^sha256:[a-f0-9]{64}$/.test(entryImageId)) fail("ENTRY_IMAGE_INVALID");
  const parentOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"];
  const program = studioGatewayProgram(artifact.id);
  const common = { pull_policy: "never", init: true, user: "1000:1000", read_only: true, cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"],
    pids_limit: 64, mem_limit: "256m", restart: "unless-stopped", labels: { "io.yummyai.studio.bundle": artifact.id },
    healthcheck: { test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/health').then(async r=>{const d=await r.json();if(!r.ok||d.bundleId!=='" + artifact.id + "')process.exit(1)}).catch(()=>process.exit(1))"], interval: "10s", timeout: "5s", retries: 12, start_period: "10s" },
    logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "2" } } };
  const config = { name: "yummyai", services: { "studio-runtime": {
    ...common, container_name: containerName, hostname: containerName, image: imageId, networks: ["studio-runtime"],
    environment: { STUDIO_PARENT_ORIGINS: JSON.stringify(parentOrigins) },
  }, "studio-runtime-entry": {
    ...common, container_name: entryName, hostname: entryName, image: entryImageId, command: ["node", "-e", program.replaceAll("$", "$$")],
    networks: ["studio-runtime", "studio-runtime-entry"], ports: [{ target: 8080, published: "4176", host_ip: "127.0.0.1", protocol: "tcp" }],
    depends_on: { "studio-runtime": { condition: "service_healthy" } },
  } }, networks: {
    "studio-runtime": { name: networkName, driver: "bridge", internal: true, driver_opts: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" } },
    "studio-runtime-entry": { name: entryNetwork, driver: "bridge", driver_opts: { "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1" } },
  } };
  // Deployment configuration is versioned independently from the static bundle.
  // Updating a base image or gateway never overwrites a previous prepared pin.
  const deploymentId = sha(stable({ version: 2, bundleId: artifact.id, config }));
  for (const service of Object.values(config.services)) service.labels = { ...service.labels, "io.yummyai.studio.deployment": deploymentId };
  const directory = path.join(workspace, deploymentRoot(deploymentId));
  await protectDirectory(directory);
  const composeFile = deploymentRoot(deploymentId) + "/compose.json";
  const configBytes = JSON.stringify(config, null, 2) + "\n";
  try { await fs.writeFile(path.join(workspace, composeFile), configBytes, { flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST" || sha(await regular(composeFile)) !== sha(configBytes)) throw error; }
  const record = { version: 2, project: "yummyai", service: "studio-runtime", deploymentId, bundleId: artifact.id, imageId, entryImageId, entryProgramSha256: sha(program),
    artifactManifest: artifactManifest(artifact.id), artifactManifestSha256: sha(await fs.readFile(artifact.manifestPath)),
    composeFile, composeSha256: sha(configBytes), origin: "http://127.0.0.1:4176", parentOrigins };
  await verifyRecord(record);
  await writePrivate(path.join(directory, "prepared.json"), record, { fresh: false });
  return { deployment: deploymentRoot(deploymentId) + "/prepared.json", record };
}
async function adoptStudioRuntimeDeploymentUnlocked(deployment) {
  if (!/^\.artifacts\/studio-runtime-deployments\/[a-f0-9]{64}\/prepared\.json$/.test(deployment)) fail("PATH_INVALID");
  const record = validate(JSON.parse(await regular(deployment)));
  await verifyRecord(record);
  await requireNoTransition();
  const previous = await readCurrent();
  let previousSnapshot = null;
  if (previous) {
    await verifyPrevious(previous, { running: true });
    const bytes = await regular(currentFile);
    if (bytes.toString("utf8") !== JSON.stringify(previous, null, 2) + "\n") fail("CURRENT_NOT_CANONICAL");
    previousSnapshot = { record: previous, sha256: sha(bytes) };
    if (previous.deploymentId === record.deploymentId) return checkStudioRuntimeDeployment({ live: true });
  } else if (await namedContainer() || await namedContainer(entryName) || await namedNetwork() || await namedNetwork(entryNetwork)) fail("UNRECORDED_RESOURCE");
  let journal = { version: 1, operation: "studio-runtime-adoption", startedAt: new Date().toISOString(), next: record, previous: previousSnapshot };
  await protectDirectory(path.join(workspace, ".artifacts/studio-runtime-deployments"));
  // Exclusive durable intent exists before Docker mutation. A killed process is
  // recovered explicitly; status/start never silently overwrite this evidence.
  await writePrivate(path.join(workspace, transitionFile), journal);
  try {
    await up(record);
    const container = await confirmHealthy(record);
    const baselineFile = deploymentRoot(record.deploymentId) + "/baseline.json";
    const baseline = { comparable: comparablePair(container), sha256: sha(stable(comparablePair(container))) };
    const baselineSha256 = await writePrivate(path.join(workspace, baselineFile), baseline, { fresh: false });
    const adopted = { ...record, baselineFile, baselineSha256, adoptedAt: new Date().toISOString(), previousBundleId: previous?.bundleId ?? null, previousDeploymentId: previous?.deploymentId ?? null };
    journal = { ...journal, nextCurrentSha256: sha(JSON.stringify(adopted, null, 2) + "\n") };
    await writePrivate(path.join(workspace, transitionFile), journal, { fresh: false });
    await writePrivate(path.join(workspace, currentFile), adopted, { fresh: false });
    await verifyPrevious(adopted, { running: true });
    await clearTransition();
  } catch (error) {
    try { await restoreTransition(journal); }
    catch { fail("ROLLBACK_FAILED_RECOVERY_REQUIRED"); }
    throw error;
  }
  return { project: "yummyai", service: "studio-runtime", deploymentId: record.deploymentId, bundleId: record.bundleId, imageId: record.imageId, containerCount: 2, healthy: true, origin: record.origin, backgroundConsumersStarted: false };
}
async function recoverStudioRuntimeDeploymentUnlocked() {
  const journal = await pendingTransition();
  if (!journal) fail("NO_PENDING_TRANSITION");
  await restoreTransition(journal);
  return { recovered: true, restoredBundleId: journal.previous?.record.bundleId ?? null, backgroundConsumersStarted: false };
}
export async function checkStudioRuntimeDeployment({ live = false } = {}) {
  await requireNoTransition();
  const record = await readCurrent();
  if (!record) return null;
  await verifyRecord(record);
  const baseline = await baselineFor(record);
  const container = live ? await inspectContainer(record) : null;
  if (live && (!container || Object.values(container).some(item => !item.State.Running || item.State.Health?.Status !== "healthy")
      || stable(comparablePair(container)) !== stable(Object.fromEntries(Object.entries(baseline.comparable)
        .map(([role, value]) => [role, normalizeStudioComparable(value)]))))) fail("LIVE_CHANGED");
  return { configured: true, service: "studio-runtime", deploymentId: record.deploymentId, bundleId: record.bundleId, imageId: record.imageId, entryImageId: record.entryImageId, containerCount: 2,
    origin: record.origin, verified: true, ...(live ? { state: "running", health: "healthy", name: containerName, project: "yummyai" } : {}) };
}
async function startStudioRuntimeDeploymentUnlocked() {
  await requireNoTransition();
  const record = await readCurrent();
  if (!record) return null;
  const existing = await verifyPrevious(record, { allowPartial: true });
  if (existing?.runtime?.State.Running && existing?.entry?.State.Running
      && existing.runtime.State.Health?.Status === "healthy" && existing.entry.State.Health?.Status === "healthy")
    return checkStudioRuntimeDeployment({ live: true });
  for (const isEntry of [false, true]) {
    const network = await namedNetwork(isEntry ? entryNetwork : networkName);
    if (network) assertNetworkOwner(network, isEntry ? [existing?.entry] : [existing?.runtime, existing?.entry], isEntry);
  }
  await up(record);
  return checkStudioRuntimeDeployment({ live: true });
}
export function adoptStudioRuntimeDeployment(deployment, options = {}) {
  return withStartupGate(workspace, () => adoptStudioRuntimeDeploymentUnlocked(deployment), options.startupGate);
}
export function recoverStudioRuntimeDeployment(options = {}) {
  return withStartupGate(workspace, () => recoverStudioRuntimeDeploymentUnlocked(), options.startupGate);
}
export function startStudioRuntimeDeployment(options = {}) {
  return withStartupGate(workspace, () => startStudioRuntimeDeploymentUnlocked(), options.startupGate);
}
async function main() {
  const [operation, argument, ...extra] = process.argv.slice(2);
  if (extra.length) fail("COMMAND_INVALID");
  const result = operation === "prepare-current" && !argument ? await (async () => {
    const { buildCanvasRuntime } = await import("./build-canvas-runtime.mjs");
    const { sealStudioRuntime } = await import("./studio-runtime-artifact.mjs");
    await buildCanvasRuntime();
    return prepareStudioRuntimeDeployment((await sealStudioRuntime(workspace)).manifestPath);
  })() : operation === "prepare" && argument ? await prepareStudioRuntimeDeployment(argument)
    : operation === "adopt" && argument ? await adoptStudioRuntimeDeployment(argument)
      : operation === "status" && !argument ? await checkStudioRuntimeDeployment({ live: true })
        : operation === "start" && !argument ? await startStudioRuntimeDeployment()
          : operation === "recover" && !argument ? await recoverStudioRuntimeDeployment() : fail("COMMAND_INVALID");
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(await main()) + "\n"); }
  catch (error) {
    const message = error instanceof Error && /^(?:STUDIO_DEPLOYMENT|UNIFIED_COMPOSE|ORDINARY_RUNTIME)_[A-Z_]+$/.test(error.message)
      ? error.message : "STUDIO_DEPLOYMENT_OPERATION_FAILED";
    process.stderr.write(message + "\n"); process.exitCode = 1;
  }
}
