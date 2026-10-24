import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { createAppImageLifecycle, withAppImageMaintenance } from "../scripts/unified-compose-image-lifecycle.mjs";
import { compareCoreContainerSnapshots, expectedCoreInspection } from "../scripts/unified-compose.mjs";

// The real lifecycle, comparator, review and recovery operations run against
// memory-only files and synthetic Docker responses. No .env, disk files,
// Docker process, database or provider is opened. Only test 5 reserves a
// dynamically assigned loopback port, through the real maintenance boundary.
const clone = value => globalThis.structuredClone(value);
const encode = value => JSON.stringify(value, null, 2) + "\n";
const sha = value => createHash("sha256").update(value).digest("hex");
const imageId = value => "sha256:" + sha(value);
const repositories = { sub2api: "weishaw/sub2api", "canvas-legacy": "ghcr.io/basketikun/infinite-canvas", postgres: "postgres" };
const code = value => error => error.message === "UNIFIED_COMPOSE_" + value;
const pause = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function ioError(value) { return Object.assign(new Error("SYNTHETIC_" + value), { code: value }); }

function inspection(service, index) {
  const id = sha("synthetic-container-" + service), port = String(18080 + index);
  const bindings = { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: port }] };
  return {
    Id: id, Name: "/" + service, Image: imageId("synthetic-old-image-" + service),
    Config: { Image: repositories[service] + ":v1", Env: ["PATH=/synthetic/bin", "SYNTHETIC_LITERAL=$VALUE-${UNEXPANDED}-$$"],
      Cmd: ["serve"], Entrypoint: ["/synthetic/start"], User: "1001", WorkingDir: "/app", Hostname: id.slice(0, 12),
      Healthcheck: { Test: ["CMD", "/synthetic/health"], Interval: 30_000_000_000, Timeout: 5_000_000_000, Retries: 3 },
      ExposedPorts: { "8080/tcp": {} }, Labels: { "com.docker.compose.project": "yummyai", "com.docker.compose.service": service, "synthetic.business-label": "$UNCHANGED" } },
    HostConfig: { NetworkMode: "synthetic_private", PortBindings: clone(bindings), RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      Privileged: false, ReadonlyRootfs: true, Memory: 536870912, SecurityOpt: ["no-new-privileges:true"], CapDrop: ["ALL"] },
    Mounts: [{ Type: "volume", Name: "synthetic-" + service, Source: "/synthetic/volumes/" + service,
      Destination: "/app/data", Mode: "rw", RW: true, Driver: "local", Propagation: "" }],
    NetworkSettings: { Ports: clone(bindings), Networks: { synthetic_private: { Aliases: [service, id.slice(0, 12), "business-alias-" + service], IPAMConfig: {} } } },
    State: { Running: true, Status: "running", Health: { Status: "healthy" } },
  };
}

function fixture({ maintenance } = {}) {
  const runtimeDirectory = path.resolve(path.parse(path.resolve(".")).root, "synthetic-memory-only-compose");
  const files = new Map(), mutations = [], calls = { docker: [], checks: [], owner: [], maintenance: 0 };
  const services = ["sub2api", "canvas-legacy", "postgres"], baselineInspections = services.map(inspection), live = clone(baselineInspections);
  const images = new Map(), platform = { daemonSecurityOptions: ["name=seccomp,profile=builtin"] };
  let lifecycle, hook, ownerRunning = false, busy = false;
  const owned = absolute => {
    const resolved = path.resolve(absolute), relative = path.relative(runtimeDirectory, resolved);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) throw new Error("SYNTHETIC_PATH_OUTSIDE_MEMORY_ROOT");
    return { absolute: resolved, relative: relative.split(path.sep).join("/") };
  };
  const key = relative => owned(path.join(runtimeDirectory, relative)).absolute;
  const bytes = relative => {
    if (!files.has(key(relative))) throw ioError("ENOENT");
    return Buffer.from(files.get(key(relative)));
  };
  const json = relative => JSON.parse(bytes(relative).toString());
  const seed = (relative, value) => files.set(key(relative), Buffer.from(typeof value === "string" ? value : encode(value)));
  for (const row of baselineInspections) {
    const repository = repositories[row.Config.Labels["com.docker.compose.service"]];
    const image = { Id: row.Image, RepoDigests: [repository + "@sha256:" + sha("old-digest-" + repository)] };
    images.set(row.Config.Image, image); images.set(row.Image, image); images.set(image.RepoDigests[0], image);
  }
  const model = { services: Object.fromEntries(baselineInspections.map(row => {
    const service = row.Config.Labels["com.docker.compose.service"];
    return [service, { container_name: service, image: images.get(row.Image).RepoDigests[0],
      environment: { SYNTHETIC_LITERAL: "$$VALUE-$${UNEXPANDED}-$$$$" },
      volumes: [{ type: "volume", source: "synthetic-" + service, target: "/app/data" }],
      ports: [{ target: 8080, published: row.HostConfig.PortBindings["8080/tcp"][0].HostPort, host_ip: "127.0.0.1" }] }];
  })) };
  const baseline = { inspections: clone(baselineInspections), images: [...new Set(images.values())].map(clone) };
  seed("baseline.private.json", baseline); seed("runtime.json", model);
  seed("manifest.json", { version: 1, project: "yummyai", recordedAt: "2026-10-24T00:00:00.000Z",
    runtimeSha256: sha(bytes("runtime.json")), baselineSha256: sha(bytes("baseline.private.json")),
    original: baselineInspections.map(row => ({ id: row.Id, name: row.Name.slice(1), running: true, imageId: row.Image })),
    imageChanges: [], activeServices: ["sub2api", "postgres"], backgroundConsumersStarted: false });
  const filesystem = {
    async lstat(absolute) { if (!files.has(owned(absolute).absolute)) throw ioError("ENOENT"); return { isFile: () => true, isSymbolicLink: () => false }; },
    async readFile(absolute) { const at = owned(absolute).absolute; if (!files.has(at)) throw ioError("ENOENT"); return Buffer.from(files.get(at)); },
    async unlink(absolute) { const at = owned(absolute); if (!files.delete(at.absolute)) throw ioError("ENOENT"); mutations.push({ operation: "unlink", relative: at.relative }); },
  };
  const host = {
    runtimeDirectory,
    async assertOwnedPath(absolute) { return owned(absolute).absolute; },
    async protectDirectory(absolute) { mutations.push({ operation: "protect", relative: owned(absolute).relative }); },
    async writePrivate(absolute, value, { fresh = true } = {}) {
      const at = owned(absolute), content = Buffer.from(encode(value));
      if (fresh && files.has(at.absolute)) throw ioError("EEXIST");
      if (hook) await hook({ phase: "before", relative: at.relative, fresh });
      files.set(at.absolute, content); mutations.push({ operation: "write", relative: at.relative, fresh, sha256: sha(content) });
      if (hook) await hook({ phase: "after", relative: at.relative, fresh });
      return sha(content);
    },
    async readRuntime() {
      await lifecycle.requireNoAppImageTransition();
      const manifest = json("manifest.json"), currentModel = json("runtime.json");
      if (manifest.runtimeSha256 !== sha(bytes("runtime.json")) || manifest.baselineSha256 !== sha(bytes("baseline.private.json")))
        throw new Error("UNIFIED_COMPOSE_CONFIGURATION_CHANGED");
      return { manifest, model: currentModel, baseline: json("baseline.private.json"),
        adoptedInspections: await lifecycle.readAppImageAdoptions(manifest, currentModel) };
    },
    async check({ live: checkLive = false } = {}) {
      calls.checks.push({ live: checkLive }); const runtime = await host.readRuntime();
      if (checkLive) {
        if (runtime.manifest.imageChanges.length) throw new Error("UNIFIED_COMPOSE_BASELINE_CHECK_REQUIRES_REVIEWED_IMAGE_CHANGE");
        return compareCoreContainerSnapshots(runtime, clone(live), platform);
      }
      return { configurationValid: true };
    },
    async compareLiveCore(runtime, options) { return compareCoreContainerSnapshots(runtime, clone(live), platform, options); },
    expectedCoreInspection,
    async docker(arguments_) {
      calls.docker.push(clone(arguments_));
      assert.equal(arguments_.length, 3); assert.deepEqual(arguments_.slice(0, 2), ["image", "inspect"]);
      const image = images.get(arguments_[2]); assert.ok(image, "only a known synthetic image can be inspected");
      return { stdout: JSON.stringify([image]) };
    },
  };
  const reserve = maintenance ?? (async action => {
    if (busy) throw new Error("UNIFIED_COMPOSE_IMAGE_MAINTENANCE_LOCK_UNAVAILABLE");
    busy = true; try { return await action(); } finally { busy = false; }
  });
  lifecycle = createAppImageLifecycle({ filesystem, loadHost: async () => host,
    maintenance: action => { calls.maintenance++; return reserve(action); },
    ownerIsRunning: pid => { calls.owner.push(pid); return ownerRunning; } });
  function deployCandidate(service = "sub2api") {
    const current = live.find(row => row.Name === "/" + service);
    current.Id = sha("synthetic-new-container-" + service); current.Config.Hostname = current.Id.slice(0, 12);
    current.Image = imageId("synthetic-new-image-" + service); current.Config.Image = json("runtime.json").services[service].image;
    current.Config.Env.push("SYNTHETIC_UPSTREAM_VERSION=v2"); current.Config.Cmd = ["serve", "--v2"];
    current.Config.Entrypoint = ["/synthetic/v2-start"]; current.Config.WorkingDir = "/app-v2";
    current.Config.Healthcheck.Test = ["CMD", "/synthetic/v2-health"];
    current.NetworkSettings.Networks.synthetic_private.Aliases = [service, current.Id.slice(0, 12), "business-alias-" + service];
    const image = { Id: current.Image, RepoDigests: [repositories[service] + "@sha256:" + sha("new-digest-" + service)] };
    images.set(current.Config.Image, image); images.set(image.Id, image); images.set(image.RepoDigests[0], image);
    return image;
  }
  function restoreLive(service = "sub2api") {
    const at = live.findIndex(row => row.Name === "/" + service); live[at] = clone(baselineInspections[at]);
    live[at].Id = sha("synthetic-restored-container-" + service); live[at].Config.Hostname = live[at].Id.slice(0, 12);
    live[at].NetworkSettings.Networks.synthetic_private.Aliases = [service, live[at].Id.slice(0, 12), "business-alias-" + service];
  }
  return { lifecycle, host, files, mutations, calls, live, bytes, json, seed, key, deployCandidate, restoreLive,
    onWrite(value) { hook = value; }, setOwnerRunning(value) { ownerRunning = value; },
    snapshot() { return [...files].map(([at, content]) => [at, content.toString()]).sort(([left], [right]) => left.localeCompare(right)); } };
}

async function reviewed(f, service = "sub2api") {
  const change = await f.lifecycle.setAppImage(service, repositories[service] + ":v2.4.1");
  const image = f.deployCandidate(service), review = await f.lifecycle.reviewAppImage(change.change);
  return { change, image, review };
}
function interruptWrite(f, relative, phase) {
  f.onWrite(event => {
    if (!event.fresh && event.relative === relative && event.phase === phase) {
      f.onWrite(undefined); throw new Error("SYNTHETIC_WRITE_INTERRUPTED");
    }
  });
}

test("real set review and adopt commands pin only the selected app and retain immutable original and exact reviewed history", async () => {
  const f = fixture(), baseline = f.bytes("baseline.private.json"), original = f.json("manifest.json").original;
  for (const service of ["sub2api", "canvas-legacy"]) {
    const modelBefore = f.json("runtime.json"), peerBefore = clone(f.live.filter(row => row.Name !== "/" + service));
    const { change, image, review } = await reviewed(f, service);
    assert.equal(change.deployed, false); assert.equal(change.previous, modelBefore.services[service].image);
    assert.deepEqual(f.json("runtime.json"), { ...modelBefore, services: { ...modelBefore.services,
      [service]: { ...modelBefore.services[service], image: repositories[service] + ":v2.4.1" } } });
    assert.equal(review.sha256, sha(f.bytes(review.record))); assert.equal(review.imageId, image.Id);
    assert.equal(review.adopted, false); assert.equal(review.loginAndDataReviewRequired, true);
    const reviewBytes = f.bytes(review.record), adopted = await f.lifecycle.adoptAppImage(review.review, review.sha256);
    assert.equal(adopted.pinnedImage, image.RepoDigests[0]); assert.equal(adopted.originalCapturePreserved, true);
    assert.equal(adopted.backgroundConsumersStarted, false); assert.equal(adopted.databaseRestored, false);
    assert.deepEqual(f.json("runtime.json"), { ...modelBefore, services: { ...modelBefore.services,
      [service]: { ...modelBefore.services[service], image: image.RepoDigests[0] } } });
    assert.deepEqual(f.live.filter(row => row.Name !== "/" + service), peerBefore);
    assert.deepEqual(f.json("manifest.json").original, original); assert.deepEqual(f.bytes("baseline.private.json"), baseline);
    assert.equal(f.json("manifest.json").imageChanges.length, 0); assert.deepEqual(f.bytes(review.record), reviewBytes);
    const runtime = await f.host.readRuntime(), pointer = runtime.manifest.imageAdoptions.at(-1);
    assert.equal(pointer.service, service); assert.equal(pointer.name, service); assert.equal(pointer.sha256, sha(f.bytes(pointer.record)));
    for (const before of original) assert.deepEqual(expectedCoreInspection(runtime, before),
      f.live.find(row => row.Name === "/" + before.name));
    assert.equal((await f.host.check({ live: true })).liveCount, 3);
    const writes = f.mutations.length, snapshot = f.snapshot(), repeated = await f.lifecycle.adoptAppImage(review.review, review.sha256);
    assert.equal(repeated.alreadyAdopted, true); assert.equal(repeated.current, true); assert.equal(repeated.deploymentChanged, false);
    assert.equal(f.mutations.length, writes); assert.deepEqual(f.snapshot(), snapshot);
  }
  assert.equal(f.json("manifest.json").imageAdoptions.length, 2);
  assert.equal(f.mutations.filter(row => row.relative === "baseline.private.json").length, 0);
  assert.ok(f.calls.docker.every(row => row.length === 3 && row[0] === "image" && row[1] === "inspect"));
});

test("wrong missing tampered or stale explicit reviews reject without writing or adopting another candidate", async () => {
  for (const variant of ["missing-sha", "wrong-sha", "tampered-review", "changed-manifest", "changed-candidate"]) {
    const f = fixture(), { review } = await reviewed(f); let supplied = review.sha256, expected = "IMAGE_REVIEW_STALE";
    if (variant === "missing-sha") { supplied = undefined; expected = "IMAGE_REVIEW_SHA_REQUIRED"; }
    if (variant === "wrong-sha") { supplied = "f".repeat(64); expected = "IMAGE_REVIEW_CHANGED"; }
    if (variant === "tampered-review") { f.seed(review.record, { ...f.json(review.record), direction: "rollback" }); expected = "IMAGE_REVIEW_CHANGED"; }
    if (variant === "changed-manifest") f.seed("manifest.json", { ...f.json("manifest.json"), recordedAt: "2026-10-24T01:00:00.000Z" });
    if (variant === "changed-candidate") f.live[0].Config.Env.push("SYNTHETIC_UNREVIEWED_DEFAULT=changed");
    const before = f.snapshot(), mutations = f.mutations.length;
    await assert.rejects(f.lifecycle.adoptAppImage(review.review, supplied), code(expected), variant);
    assert.equal(f.mutations.length, mutations, variant); assert.deepEqual(f.snapshot(), before, variant);
    assert.equal(f.json("manifest.json").imageAdoptions?.length ?? 0, 0);
  }
});

test("real peer and image-review comparators reject unrelated service protected mount port and privilege drift before a review is recorded", async () => {
  const variants = [
    ["peer", f => { f.live[2].Config.Env.push("SYNTHETIC_PEER_CHANGED=yes"); }, "LIVE_BASELINE_CHANGED"],
    ["mount", f => { f.live[0].Mounts[0].Name = "synthetic-other-volume"; }, "APP_IMAGE_REVIEW_PROTECTED_FIELD_CHANGED"],
    ["published-port", f => { f.live[0].HostConfig.PortBindings["8080/tcp"][0].HostPort = "19999"; f.live[0].NetworkSettings.Ports["8080/tcp"][0].HostPort = "19999"; }, "APP_IMAGE_REVIEW_PROTECTED_FIELD_CHANGED"],
    ["privileged", f => { f.live[0].HostConfig.Privileged = true; }, "APP_IMAGE_REVIEW_PROTECTED_FIELD_CHANGED"],
    ["unhealthy", f => { f.live[0].State.Health.Status = "unhealthy"; }, "IMAGE_CANDIDATE_NOT_HEALTHY"],
  ];
  for (const [name, mutate, expected] of variants) {
    const f = fixture(), changed = await f.lifecycle.setAppImage("sub2api", "weishaw/sub2api:v2.4.1");
    f.deployCandidate(); mutate(f); const before = f.snapshot(), writes = f.mutations.length;
    await assert.rejects(f.lifecycle.reviewAppImage(changed.change), code(expected), name);
    assert.equal(f.mutations.length, writes, name); assert.deepEqual(f.snapshot(), before, name);
    assert.equal(f.snapshot().filter(([at]) => at.endsWith("-review.private.json")).length, 0);
  }
});

test("commands recover before or after every runtime-manifest interruption and reject changed baseline journal or external files without writes", async () => {
  for (const [relative, phase] of [["runtime.json", "before"], ["runtime.json", "after"], ["manifest.json", "after"]]) {
    for (const use of ["before", "after"]) {
      const f = fixture(), baseline = f.bytes("baseline.private.json"); interruptWrite(f, relative, phase);
      await assert.rejects(f.lifecycle.setAppImage("sub2api", "weishaw/sub2api:v2.4.1"), /^Error: SYNTHETIC_WRITE_INTERRUPTED$/);
      const pending = f.json("image-transition.pending.json"), journalBytes = f.bytes(pending.record), journal = f.json(pending.record);
      assert.equal(pending.sha256, sha(journalBytes)); assert.equal(Number.isSafeInteger(pending.ownerPid), true);
      assert.deepEqual(f.json("runtime.json"), relative === "runtime.json" && phase === "before" ? journal.before.model : journal.after.model);
      assert.deepEqual(f.json("manifest.json"), relative === "manifest.json" ? journal.after.manifest : journal.before.manifest);
      await assert.rejects(f.lifecycle.requireNoAppImageTransition(), code("IMAGE_RECOVERY_REQUIRED"));
      const result = await f.lifecycle.recoverAppImageTransition(pending.id, use);
      assert.equal(result.selected, use); assert.equal(result.deploymentChanged, false); assert.equal(result.databaseRestored, false);
      assert.deepEqual(f.bytes("runtime.json"), Buffer.from(encode(journal[use].model)));
      assert.deepEqual(f.bytes("manifest.json"), Buffer.from(encode(journal[use].manifest)));
      assert.deepEqual(f.bytes("baseline.private.json"), baseline); assert.deepEqual(f.bytes(pending.record), journalBytes);
      assert.equal(f.files.has(f.key("image-transition.pending.json")), false);
      assert.deepEqual(f.calls.owner, [pending.ownerPid]); assert.equal(f.calls.docker.length, 0);
    }
  }
  for (const variant of ["baseline", "journal", "external-runtime"]) {
    const f = fixture(); interruptWrite(f, "runtime.json", "after");
    await assert.rejects(f.lifecycle.setAppImage("sub2api", "weishaw/sub2api:v2.4.1"), /^Error: SYNTHETIC_WRITE_INTERRUPTED$/);
    const pending = f.json("image-transition.pending.json");
    if (variant === "baseline") f.seed("baseline.private.json", { changed: "SYNTHETIC_BASELINE_EDIT" });
    if (variant === "journal") f.seed(pending.record, { ...f.json(pending.record), recordedAt: "changed" });
    if (variant === "external-runtime") f.seed("runtime.json", { services: { external: {} } });
    const before = f.snapshot(), writes = f.mutations.length;
    await assert.rejects(f.lifecycle.recoverAppImageTransition(pending.id, "after"), code(variant === "baseline"
      ? "IMAGE_ORIGINAL_BASELINE_CHANGED" : variant === "journal" ? "IMAGE_TRANSITION_CHANGED" : "IMAGE_RECOVERY_EXTERNAL_CHANGE"));
    assert.equal(f.mutations.length, writes); assert.deepEqual(f.snapshot(), before);
  }
});

test("active owners cause zero writes and the real ephemeral reservation excludes every competing command during recovery", { timeout: 15_000 }, async () => {
  let sharedPort;
  const f = fixture({ maintenance: action => withAppImageMaintenance(async acquiredPort => {
    sharedPort ??= acquiredPort; assert.notEqual(sharedPort, 43981); return action();
  }, { port: sharedPort ?? 0 }) });
  interruptWrite(f, "runtime.json", "after");
  await assert.rejects(f.lifecycle.setAppImage("sub2api", "weishaw/sub2api:v2.4.1"), /^Error: SYNTHETIC_WRITE_INTERRUPTED$/);
  const pending = f.json("image-transition.pending.json"), journal = f.json(pending.record);
  f.setOwnerRunning(true); const before = f.snapshot(), writes = f.mutations.length;
  await assert.rejects(f.lifecycle.recoverAppImageTransition(pending.id, "before"), code("IMAGE_TRANSITION_OWNER_RUNNING"));
  assert.equal(f.mutations.length, writes); assert.deepEqual(f.snapshot(), before); f.setOwnerRunning(false);
  const reached = pause(), release = pause(); let first;
  f.onWrite(async event => {
    if (!event.fresh && event.relative === "runtime.json" && event.phase === "before") {
      f.onWrite(undefined); reached.resolve(); await release.promise;
    }
  });
  try {
    first = f.lifecycle.recoverAppImageTransition(pending.id, "before");
    await Promise.race([reached.promise, first.then(() => assert.fail("recovery completed without reaching the real write barrier"))]);
    const paused = f.snapshot(), attempts = f.mutations.length;
    const competitors = [
      () => f.lifecycle.recoverAppImageTransition(pending.id, "after"),
      () => f.lifecycle.setAppImage("sub2api", "weishaw/sub2api:v3"),
      () => f.lifecycle.reviewAppImage(pending.id),
      () => f.lifecycle.adoptAppImage(pending.id, "a".repeat(64)),
      () => f.lifecycle.stageAppImageRollback(pending.id),
    ];
    for (const operation of competitors) await assert.rejects(operation(), code("IMAGE_MAINTENANCE_LOCK_UNAVAILABLE"));
    assert.equal(f.mutations.length, attempts); assert.deepEqual(f.snapshot(), paused);
  } finally { release.resolve(); if (first) await first; }
  assert.deepEqual(f.json("runtime.json"), journal.before.model); assert.deepEqual(f.json("manifest.json"), journal.before.manifest);
  assert.equal(f.files.has(f.key("image-transition.pending.json")), false);
  assert.equal(await withAppImageMaintenance(() => "reservation-released", { port: sharedPort }), "reservation-released");
});

test("rollback changes only the recorded app pin leaves the deployed candidate intact and requires a fresh review without claiming database restoration", async () => {
  const f = fixture(), before = f.json("runtime.json"), baseline = f.bytes("baseline.private.json"), original = f.json("manifest.json").original;
  const { change, review } = await reviewed(f), liveBeforeRollback = clone(f.live), inspected = f.calls.docker.length;
  const rollback = await f.lifecycle.stageAppImageRollback(change.change);
  assert.equal(rollback.changed, true); assert.equal(rollback.deployed, false); assert.equal(rollback.databaseRestored, false);
  assert.equal(f.calls.docker.length, inspected); assert.deepEqual(f.live, liveBeforeRollback); assert.deepEqual(f.json("runtime.json"), before);
  assert.equal(f.json("manifest.json").imageChanges[0].direction, "rollback"); assert.deepEqual(f.json("manifest.json").original, original);
  assert.deepEqual(f.bytes("baseline.private.json"), baseline);
  const snapshot = f.snapshot(), writes = f.mutations.length;
  await assert.rejects(f.lifecycle.adoptAppImage(review.review, review.sha256), code("IMAGE_REVIEW_STALE"));
  assert.equal(f.mutations.length, writes); assert.deepEqual(f.snapshot(), snapshot);
  const repeated = await f.lifecycle.stageAppImageRollback(change.change);
  assert.equal(repeated.changed, false); assert.equal(repeated.deployed, false); assert.notEqual(repeated.databaseRestored, true);
  assert.equal(f.mutations.length, writes); f.restoreLive();
  const rollbackReview = await f.lifecycle.reviewAppImage(change.change), adopted = await f.lifecycle.adoptAppImage(rollbackReview.review, rollbackReview.sha256);
  assert.equal(adopted.outcome, "rolled_back"); assert.equal(adopted.databaseRestored, false); assert.deepEqual(f.json("runtime.json"), before);
  assert.deepEqual(f.bytes("baseline.private.json"), baseline); assert.deepEqual(f.json("manifest.json").original, original);
  assert.ok(f.calls.docker.every(row => row[0] === "image" && row[1] === "inspect"));
});
