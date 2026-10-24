// Application-image maintenance only. Private inspections and transition records
// stay in the existing protected deployment directory; CLI results contain no
// environment, command, health-output, or volume contents.
import { randomUUID, createHash } from "node:crypto";
import nodeFs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createServer } from "node:net";
import { fileURLToPath, URL } from "node:url";
import { inspectComparable } from "./lib/unified-compose-model.mjs";
import { validateOfficialAppImage, appImageReviewSha, reviewAppImageChange } from "./lib/unified-compose-image-review.mjs";
import { withStartupGate } from "./runtime-startup-gate.mjs";

const workspace = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/;
const digest = /^[a-f0-9]{64}(?![\s\S])/;
const imageId = /^sha256:[a-f0-9]{64}(?![\s\S])/;
const repositories = { sub2api: "weishaw/sub2api", "canvas-legacy": "ghcr.io/basketikun/infinite-canvas" };
const fail = code => { throw new Error("UNIFIED_COMPOSE_" + code); };
const encode = value => JSON.stringify(value, null, 2) + "\n";
const sha = value => createHash("sha256").update(value).digest("hex");
const identifier = value => { if (!uuid.test(value ?? "")) fail("IMAGE_CHANGE_ID_INVALID"); return value; };
/** OS-owned loopback reservation, automatically released on process death.
 * It also serializes competing recoveries without stealing a stale file lock.
 * The maintenance-only port carries no data and is never a product endpoint. */
export async function withAppImageMaintenance(action, { port = 43981 } = {}) {
  const server = createServer(socket => socket.destroy());
  let listening = false;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", () => reject(new Error("UNIFIED_COMPOSE_IMAGE_MAINTENANCE_LOCK_UNAVAILABLE")));
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => { listening = true; resolve(); });
    });
    return await action(server.address().port);
  } finally {
    if (listening) await new Promise((resolve, reject) => server.close(error => error ? reject(new Error("UNIFIED_COMPOSE_IMAGE_MAINTENANCE_LOCK_CLOSE_FAILED")) : resolve()));
  }
}
function snapshot(value) {
  if (!value || value.manifest?.version !== 1 || value.manifest.project !== "yummyai"
      || !digest.test(value.manifest.baselineSha256 ?? "")
      || sha(encode(value.model)) !== value.manifest.runtimeSha256) fail("IMAGE_TRANSITION_INVALID");
  return { runtimeSha256: sha(encode(value.model)), manifestSha256: sha(encode(value.manifest)) };
}
/** Recovery only chooses a recorded side of a known two-file update. It refuses
 * external edits instead of overwriting them with a stale maintenance snapshot. */
export function resolveAppImageRecovery(journal, current, use) {
  if (journal?.version !== 1 || !uuid.test(journal.id ?? "") || !["before", "after"].includes(use)
      || !["set-image", "rollback-image", "adopt-image"].includes(journal.operation)) fail("IMAGE_TRANSITION_INVALID");
  const before = snapshot(journal.before), after = snapshot(journal.after);
  if (journal.before.manifest.baselineSha256 !== journal.after.manifest.baselineSha256) fail("IMAGE_ORIGINAL_BASELINE_CHANGED");
  if (![before.runtimeSha256, after.runtimeSha256].includes(current?.runtimeSha256)
      || ![before.manifestSha256, after.manifestSha256].includes(current?.manifestSha256)) fail("IMAGE_RECOVERY_EXTERNAL_CHANGE");
  return globalThis.structuredClone(journal[use]);
}
function processIsRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code !== "ESRCH") throw error; return false; }
}

// Dependency injection is for resource-free command acceptance. Production
// always uses the protected filesystem, Docker boundary and OS reservation.
export function createAppImageLifecycle({ filesystem = nodeFs, loadHost = () => import("./unified-compose.mjs"),
  maintenance = withAppImageMaintenance, ownerIsRunning = processIsRunning } = {}) {
const fs = filesystem, host = loadHost;
async function file(relative) {
  const api = await host(), absolute = await api.assertOwnedPath(path.join(api.runtimeDirectory, relative));
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("IMAGE_RECORD_NOT_REGULAR");
  return fs.readFile(absolute);
}
async function privateRecord(relative, value) {
  const api = await host();
  await api.protectDirectory(path.join(api.runtimeDirectory, path.dirname(relative)));
  return api.writePrivate(path.join(api.runtimeDirectory, relative), value);
}
async function pendingTransition() {
  try { return JSON.parse((await file("image-transition.pending.json")).toString()); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function requireNoAppImageTransition() {
  if (await pendingTransition()) fail("IMAGE_RECOVERY_REQUIRED");
}

async function readAppImageAdoptions(manifest, model) {
  const result = new Map(), pins = new Map();
  if (!Array.isArray(manifest.imageAdoptions ?? []) || !Array.isArray(manifest.imageChanges)) fail("IMAGE_ADOPTION_RECORD_INVALID");
  for (const pointer of manifest.imageAdoptions ?? []) {
    identifier(pointer.id);
    if (!Object.hasOwn(repositories, pointer.service) || model.services?.[pointer.service]?.container_name !== pointer.name
        || !digest.test(pointer.sha256 ?? "")
        || pointer.record !== `image-history/${pointer.id}-adoption.private.json`) fail("IMAGE_ADOPTION_RECORD_INVALID");
    const bytes = await file(pointer.record);
    if (sha(bytes) !== pointer.sha256) fail("IMAGE_ADOPTION_RECORD_CHANGED");
    const record = JSON.parse(bytes.toString());
    if (record.version !== 1 || record.id !== pointer.id || record.service !== pointer.service
        || record.name !== pointer.name || record.inspection?.Name !== "/" + pointer.name
        || !imageId.test(record.imageId ?? "") || record.inspection.Image !== record.imageId
        || record.inspection.Config?.Labels?.["com.docker.compose.project"] !== "yummyai"
        || record.inspection.Config?.Labels?.["com.docker.compose.service"] !== pointer.service
        || record.pin !== pointer.pin || record.imageId !== pointer.imageId) fail("IMAGE_ADOPTION_RECORD_INVALID");
    result.set(record.name, record.inspection);
    pins.set(pointer.service, pointer.pin);
  }
  for (const [service, pin] of pins) if (!manifest.imageChanges.some(row => row.service === service)
      && model.services[service].image !== pin) fail("IMAGE_ADOPTION_PIN_CHANGED");
  return result;
}

async function diskHashes() {
  const [runtime, manifest] = await Promise.all([file("runtime.json"), file("manifest.json")]);
  return { runtimeSha256: sha(runtime), manifestSha256: sha(manifest) };
}
async function clearPending(expected) {
  const api = await host(), current = await pendingTransition();
  if (!current || current.id !== expected.id || current.sha256 !== expected.sha256) fail("IMAGE_TRANSITION_CHANGED");
  await fs.unlink(await api.assertOwnedPath(path.join(api.runtimeDirectory, "image-transition.pending.json")));
}
async function commitSnapshot(value) {
  const api = await host();
  await api.writePrivate(path.join(api.runtimeDirectory, "runtime.json"), value.model, { fresh: false });
  await api.writePrivate(path.join(api.runtimeDirectory, "manifest.json"), value.manifest, { fresh: false });
  const actual = await diskHashes(), expected = snapshot(value);
  if (actual.runtimeSha256 !== expected.runtimeSha256 || actual.manifestSha256 !== expected.manifestSha256) fail("IMAGE_TRANSITION_CHANGED");
}
async function transition(runtime, next, operation) {
  const api = await host(), id = randomUUID();
  next.manifest.runtimeSha256 = sha(encode(next.model));
  const journal = { version: 1, id, operation, recordedAt: new Date().toISOString(),
    before: { manifest: runtime.manifest, model: runtime.model }, after: next };
  const previous = snapshot(journal.before);
  resolveAppImageRecovery(journal, previous, "after");
  const record = `image-history/${id}-transition.private.json`, recordSha256 = await privateRecord(record, journal);
  const pending = { version: 1, id, record, sha256: recordSha256, ownerPid: process.pid };
  // wx is the cross-process reservation. Every runtime mutation uses it, so a
  // concurrent command either waits for an explicit retry or fails before writes.
  await api.writePrivate(path.join(api.runtimeDirectory, "image-transition.pending.json"), pending);
  const current = await diskHashes();
  if (current.runtimeSha256 !== previous.runtimeSha256 || current.manifestSha256 !== previous.manifestSha256) {
    await clearPending(pending); fail("IMAGE_CHANGE_STALE");
  }
  await commitSnapshot(next);
  await clearPending(pending);
  return id;
}
async function recoverAppImageTransitionUnlocked(id, use) {
  identifier(id);
  const pending = await pendingTransition();
  if (!pending || pending.version !== 1 || pending.id !== id
      || pending.record !== `image-history/${id}-transition.private.json` || !digest.test(pending.sha256 ?? "")) fail("IMAGE_TRANSITION_INVALID");
  if (!Number.isSafeInteger(pending.ownerPid) || pending.ownerPid < 1) fail("IMAGE_TRANSITION_INVALID");
  if (ownerIsRunning(pending.ownerPid)) fail("IMAGE_TRANSITION_OWNER_RUNNING");
  const bytes = await file(pending.record);
  if (sha(bytes) !== pending.sha256) fail("IMAGE_TRANSITION_CHANGED");
  const selected = resolveAppImageRecovery(JSON.parse(bytes.toString()), await diskHashes(), use);
  if (sha(await file("baseline.private.json")) !== selected.manifest.baselineSha256) fail("IMAGE_ORIGINAL_BASELINE_CHANGED");
  await commitSnapshot(selected); await clearPending(pending);
  return { operation: "recover-image", transition: id, selected: use, deploymentChanged: false, databaseRestored: false };
}
async function appImageMaintenanceStatus() {
  const pending = await pendingTransition();
  if (pending) {
    identifier(pending.id);
    if (pending.version !== 1 || pending.record !== `image-history/${pending.id}-transition.private.json`
        || !digest.test(pending.sha256 ?? "") || !Number.isSafeInteger(pending.ownerPid) || pending.ownerPid < 1) fail("IMAGE_TRANSITION_INVALID");
    const bytes = await file(pending.record);
    if (sha(bytes) !== pending.sha256) fail("IMAGE_TRANSITION_CHANGED");
    const journal = JSON.parse(bytes.toString()), current = await diskHashes();
    const before = snapshot(journal.before), after = snapshot(journal.after);
    const matches = value => current.runtimeSha256 === value.runtimeSha256 && current.manifestSha256 === value.manifestSha256;
    const known = [before.runtimeSha256, after.runtimeSha256].includes(current.runtimeSha256)
      && [before.manifestSha256, after.manifestSha256].includes(current.manifestSha256);
    return { operation: "image-status", recoveryRequired: true, transition: pending.id,
      ownerRunning: ownerIsRunning(pending.ownerPid), metadataState: matches(before) ? "before" : matches(after) ? "after" : known ? "mixed" : "external_change",
      deploymentChanged: false, databaseRestored: false };
  }
  const api = await host(), runtime = await api.readRuntime();
  return { operation: "image-status", recoveryRequired: false,
    pending: runtime.manifest.imageChanges.map(row => ({ change: row.id, service: row.service, direction: row.direction ?? "candidate" })),
    reviewedAdoptions: runtime.manifest.imageAdoptions?.length ?? 0, deploymentChanged: false };
}
function change(runtime, id) {
  identifier(id);
  const rows = runtime.manifest.imageChanges;
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].id !== id || !Object.hasOwn(repositories, rows[0].service)) fail("IMAGE_CHANGE_NOT_CURRENT");
  const row = rows[0], direction = row.direction ?? "candidate";
  if (!["candidate", "rollback"].includes(direction) || typeof row.previous !== "string"
      || runtime.model.services?.[row.service]?.image !== (direction === "rollback" ? row.previous : row.image)) fail("IMAGE_CHANGE_NOT_CURRENT");
  return rows[0];
}
async function setAppImageUnlocked(service, image) {
  validateOfficialAppImage(service, image);
  const api = await host(), runtime = await api.readRuntime();
  if (runtime.manifest.imageChanges.length) fail("IMAGE_CHANGE_ALREADY_PENDING");
  await api.check({ live: true });
  if (runtime.model.services[service]?.image === image) return { operation: "set-image", service, changed: false };
  const next = globalThis.structuredClone({ manifest: runtime.manifest, model: runtime.model });
  const id = randomUUID(), previous = next.model.services[service].image;
  next.model.services[service].image = image;
  next.manifest.imageChanges = [{ id, recordedAt: new Date().toISOString(), service, previous, image, direction: "candidate" }];
  const transitionId = await transition(runtime, next, "set-image");
  return { operation: "set-image", change: id, transition: transitionId, service, previous, image, changed: true, deployed: false };
}
async function stageAppImageRollbackUnlocked(id) {
  const api = await host(), runtime = await api.readRuntime(), pending = change(runtime, id);
  if (pending.direction === "rollback") return { operation: "rollback-image", change: id, service: pending.service, changed: false, deployed: false };
  const next = globalThis.structuredClone({ manifest: runtime.manifest, model: runtime.model });
  next.model.services[pending.service].image = pending.previous;
  next.manifest.imageChanges[0].direction = "rollback";
  const transitionId = await transition(runtime, next, "rollback-image");
  return { operation: "rollback-image", change: id, transition: transitionId, service: pending.service,
    image: pending.previous, changed: true, deployed: false, databaseRestored: false };
}
async function observedChange(runtime, pending) {
  const api = await host(), { actual, platform } = await api.compareLiveCore(runtime, { exceptService: pending.service });
  const name = runtime.model.services[pending.service].container_name;
  const now = actual.find(row => row.Name === "/" + name);
  if (!now?.State?.Running || now.State.Health?.Status !== "healthy") fail("IMAGE_CANDIDATE_NOT_HEALTHY");
  const before = runtime.manifest.original.find(row => row.name === name);
  const original = before && api.expectedCoreInspection(runtime, before);
  if (!original) fail("IMAGE_ORIGINAL_BASELINE_MISSING");
  const requestedImage = runtime.model.services[pending.service].image;
  const images = JSON.parse((await api.docker(["image", "inspect", requestedImage])).stdout), image = images[0];
  if (images.length !== 1 || !imageId.test(image?.Id ?? "") || image.Id !== now.Image) fail("IMAGE_CANDIDATE_CHANGED");
  const pin = image.RepoDigests?.find(value => value.startsWith(repositories[pending.service] + "@sha256:")
    && /^sha256:[a-f0-9]{64}$/.test(value.split("@")[1])) ?? image.Id;
  const beforeComparable = inspectComparable(original, platform), afterComparable = inspectComparable(now, platform);
  const summary = reviewAppImageChange({ before: beforeComparable, after: afterComparable,
    expectedImageId: image.Id, reviewedSha256: appImageReviewSha(afterComparable) });
  return { name, now, imageId: image.Id, pin, requestedImage, beforeComparable, afterComparable, summary };
}
async function reviewAppImageUnlocked(id) {
  const api = await host(), runtime = await api.readRuntime(), pending = change(runtime, id);
  await api.check();
  const observed = await observedChange(runtime, pending), reviewId = randomUUID();
  const manifestSha256 = sha(await file("manifest.json"));
  if (manifestSha256 !== sha(encode(runtime.manifest))) fail("IMAGE_CHANGE_STALE");
  const review = { version: 1, id: reviewId, changeId: id, service: pending.service, direction: pending.direction ?? "candidate",
    recordedAt: new Date().toISOString(), manifestSha256, runtimeSha256: runtime.manifest.runtimeSha256,
    baselineSha256: runtime.manifest.baselineSha256, name: observed.name, requestedImage: observed.requestedImage,
    imageId: observed.imageId, pin: observed.pin, comparable: observed.afterComparable, inspection: observed.now, summary: observed.summary };
  const record = `image-history/${reviewId}-review.private.json`, reviewSha256 = await privateRecord(record, review);
  return { operation: "review-image", change: id, review: reviewId, service: pending.service, record,
    sha256: reviewSha256, imageId: observed.imageId, pinnedImage: observed.pin, changedFields: observed.summary.changedFields,
    adopted: false, loginAndDataReviewRequired: true };
}
async function adoptAppImageUnlocked(id, reviewedSha256) {
  identifier(id);
  if (!digest.test(reviewedSha256 ?? "")) fail("IMAGE_REVIEW_SHA_REQUIRED");
  const reviewBytes = await file(`image-history/${id}-review.private.json`);
  if (sha(reviewBytes) !== reviewedSha256) fail("IMAGE_REVIEW_CHANGED");
  const review = JSON.parse(reviewBytes.toString());
  if (review.version !== 1 || review.id !== id) fail("IMAGE_REVIEW_INVALID");
  const api = await host(), runtime = await api.readRuntime();
  // A lost CLI reply must not turn a completed adoption into a second change.
  for (const pointer of runtime.manifest.imageAdoptions ?? []) {
    const adoptionBytes = await file(pointer.record);
    if (sha(adoptionBytes) !== pointer.sha256) fail("IMAGE_ADOPTION_RECORD_CHANGED");
    const adopted = JSON.parse(adoptionBytes.toString());
    if (adopted.reviewId === id && adopted.reviewedSha256 === reviewedSha256) return {
      operation: "adopt-image", change: adopted.changeId, review: id, adoption: adopted.id, service: adopted.service,
      outcome: adopted.outcome, imageId: adopted.imageId, pinnedImage: adopted.pin, alreadyAdopted: true,
      current: runtime.manifest.imageAdoptions.filter(row => row.service === adopted.service).at(-1)?.id === adopted.id,
      deploymentChanged: false, databaseRestored: false,
    };
  }
  const pending = change(runtime, review.changeId);
  if (sha(await file("manifest.json")) !== review.manifestSha256 || runtime.manifest.runtimeSha256 !== review.runtimeSha256
      || runtime.manifest.baselineSha256 !== review.baselineSha256 || pending.service !== review.service
      || (pending.direction ?? "candidate") !== review.direction) fail("IMAGE_REVIEW_STALE");
  await api.check();
  const observed = await observedChange(runtime, pending);
  if (observed.name !== review.name || observed.requestedImage !== review.requestedImage || observed.imageId !== review.imageId
      || observed.pin !== review.pin || appImageReviewSha(observed.afterComparable) !== appImageReviewSha(review.comparable)
      || appImageReviewSha(inspectComparable(review.inspection)) !== appImageReviewSha(inspectComparable(observed.now))) fail("IMAGE_REVIEW_STALE");
  reviewAppImageChange({ before: observed.beforeComparable, after: observed.afterComparable, expectedImageId: review.imageId,
    reviewedSha256: appImageReviewSha(review.comparable) });
  const adoptionId = randomUUID(), record = `image-history/${adoptionId}-adoption.private.json`;
  const adoption = { version: 1, id: adoptionId, service: review.service, name: observed.name, recordedAt: new Date().toISOString(),
    changeId: pending.id, reviewId: id, reviewedSha256, imageId: observed.imageId, pin: observed.pin,
    outcome: review.direction === "rollback" ? "rolled_back" : "adopted", inspection: observed.now };
  const adoptionSha256 = await privateRecord(record, adoption);
  const next = globalThis.structuredClone({ manifest: runtime.manifest, model: runtime.model });
  next.model.services[review.service].image = observed.pin;
  next.manifest.imageChanges = [];
  next.manifest.imageAdoptions = [...(next.manifest.imageAdoptions ?? []), { id: adoptionId, service: review.service,
    name: observed.name, record, sha256: adoptionSha256, pin: observed.pin, imageId: observed.imageId }];
  const transitionId = await transition(runtime, next, "adopt-image");
  await api.check({ live: true });
  return { operation: "adopt-image", change: pending.id, review: id, adoption: adoptionId, transition: transitionId,
    service: review.service, outcome: adoption.outcome, imageId: observed.imageId, pinnedImage: observed.pin,
    originalCapturePreserved: true, backgroundConsumersStarted: false, databaseRestored: false };
}
return {
  requireNoAppImageTransition, readAppImageAdoptions, appImageMaintenanceStatus,
  setAppImage: (service, image) => maintenance(() => setAppImageUnlocked(service, image)),
  stageAppImageRollback: id => maintenance(() => stageAppImageRollbackUnlocked(id)),
  reviewAppImage: id => maintenance(() => reviewAppImageUnlocked(id)),
  adoptAppImage: (id, sha256) => maintenance(() => adoptAppImageUnlocked(id, sha256)),
  recoverAppImageTransition: (id, use) => maintenance(() => recoverAppImageTransitionUnlocked(id, use)),
};
}
const production = createAppImageLifecycle();
export const { requireNoAppImageTransition, readAppImageAdoptions, appImageMaintenanceStatus } = production;
export function setAppImage(service, image, options = {}) {
  return withStartupGate(workspace, () => production.setAppImage(service, image), options.startupGate);
}
export function stageAppImageRollback(id, options = {}) {
  return withStartupGate(workspace, () => production.stageAppImageRollback(id), options.startupGate);
}
export function reviewAppImage(id, options = {}) {
  return withStartupGate(workspace, () => production.reviewAppImage(id), options.startupGate);
}
export function adoptAppImage(id, sha256, options = {}) {
  return withStartupGate(workspace, () => production.adoptAppImage(id, sha256), options.startupGate);
}
export function recoverAppImageTransition(id, use, options = {}) {
  return withStartupGate(workspace, () => production.recoverAppImageTransition(id, use), options.startupGate);
}
