import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { sealStudioRuntime, verifyStudioRuntime } from "../scripts/studio-runtime-artifact.mjs";
import { startSealedStudioRuntime, studioRuntimePath } from "../scripts/serve-studio-runtime.mjs";

const lane = fileURLToPath(new URL("../../tmp/studio-personal-20261023-6e8c4a19/backend-artifact/", import.meta.url));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function removeOwned(directory) {
  directory = path.resolve(directory);
  assert.ok(directory.startsWith(path.join(lane, "mock-")));
  async function remove(target) {
    const info = await lstat(target);
    if (info.isSymbolicLink() || info.isFile()) { await unlink(target); return; }
    assert.ok(info.isDirectory());
    for (const name of await readdir(target)) await remove(path.join(target, name));
    await rmdir(target);
  }
  await remove(directory);
  await assert.rejects(lstat(directory), { code: "ENOENT" });
}
async function fixture(callback) {
  let parent = fileURLToPath(new URL("../../", import.meta.url));
  await studioRuntimePath(parent, "directory");
  for (const segment of ["tmp", "studio-personal-20261023-6e8c4a19", "backend-artifact"]) {
    parent = path.join(parent, segment);
    try { await mkdir(parent); } catch (error) { if (error.code !== "EEXIST") throw error; }
    await studioRuntimePath(parent, "directory");
  }
  const root = await mkdtemp(path.join(lane, "mock-"));
  const runtime = path.join(root, "packages", "canvas-runtime"), dist = path.join(runtime, "dist");
  try {
    await mkdir(path.join(dist, "assets"), { recursive: true });
    await mkdir(path.join(runtime, "vendor"), { recursive: true });
    const license = Buffer.from("Synthetic MIT fixture\n"), blob = createHash("sha1").update(`blob ${license.length}\0`).update(license).digest("hex");
    await writeFile(path.join(runtime, "vendor", "LICENSE"), license);
    await writeFile(path.join(runtime, "upstream.lock.json"), JSON.stringify({ repository: "https://github.com/basketikun/infinite-canvas", sourcePrefix: "web",
      tag: "v0.20.0", commit: "3a6b64b602ad062b29fac66902ed18a7ef5fd9dc", adapterVersion: "2.1.2", verifiedAgainstUpstreamTree: true,
      files: { LICENSE: { bytes: license.length, sha256: sha(license), gitBlob: blob, gitBlobLf: blob } } }));
    await writeFile(path.join(dist, ".build-stamp"), "1".repeat(64));
    await writeFile(path.join(dist, "index.html"), "<!doctype html><script src=\"/assets/app.js\"></script>");
    await writeFile(path.join(dist, "assets", "app.js"), "globalThis.syntheticStudio=true;\n");
    await callback({ root, runtime, dist });
  } finally { await removeOwned(root); }
}
function http(server, target, method = "GET") {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const call = request({ host: "127.0.0.1", port: address.port, path: target, method, agent: false, timeout: 5000 }, response => {
      const chunks = []; response.on("data", bytes => chunks.push(bytes));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    call.on("error", reject); call.on("timeout", () => call.destroy(new Error("STUDIO_RUNTIME_TEST_HTTP_TIMEOUT"))); call.end();
  });
}
async function withServer(descriptor, callback, standalone = false) {
  const start = standalone ? (await import(pathToFileURL(path.join(descriptor.directory, "server.mjs")).href)).startSealedStudioRuntime : startSealedStudioRuntime;
  const server = await start({ manifestPath: descriptor.manifestPath, port: 0, parentOrigins: ["http://127.0.0.1:3130"] });
  try { await callback(server); }
  finally { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test("seals a deterministic complete standalone artifact and verifies an existing ID without overwrite", () => fixture(async ({ root }) => {
  const first = await sealStudioRuntime(root), before = await readFile(first.manifestPath);
  assert.match(first.id, /^[a-f0-9]{64}$/); assert.equal(first.manifest.sourceStamp, "1".repeat(64));
  assert.deepEqual(first.manifest.files.map(row => row.path), ["public/assets/app.js", "public/index.html", "server.mjs"]);
  assert.equal(first.manifest.upstream.tag, "v0.20.0");
  assert.deepEqual(await verifyStudioRuntime(first.manifestPath), first);
  assert.deepEqual(await sealStudioRuntime(root), first); assert.deepEqual(await readFile(first.manifestPath), before);
  assert.equal(Object.isFrozen(first.manifest.files), true);
}));

test("refuses modified or extra vendor files instead of blessing a changed upstream lock", () => fixture(async ({ root, runtime }) => {
  const original = await readFile(path.join(runtime, "vendor", "LICENSE"));
  await writeFile(path.join(runtime, "vendor", "LICENSE"), "tampered");
  await assert.rejects(sealStudioRuntime(root), /STUDIO_RUNTIME_UPSTREAM_CHANGED/);
  await writeFile(path.join(runtime, "vendor", "LICENSE"), original);
  await writeFile(path.join(runtime, "vendor", "extra.txt"), "unexpected");
  await assert.rejects(sealStudioRuntime(root), /STUDIO_RUNTIME_UPSTREAM_CHANGED/);
}));

test("rejects missing build evidence and invalid stamps", () => fixture(async ({ root, dist }) => {
  await writeFile(path.join(dist, ".build-stamp"), "not-a-source-stamp");
  await assert.rejects(sealStudioRuntime(root), /STUDIO_RUNTIME_SOURCE_STAMP_INVALID/);
  await unlink(path.join(dist, ".build-stamp")); await assert.rejects(sealStudioRuntime(root));
}));

test("rejects dist junctions without traversing their targets", () => fixture(async ({ root, dist }) => {
  await mkdir(path.join(root, "unrelated")); await writeFile(path.join(root, "unrelated", "keep.txt"), "preserved");
  await symlink(path.join(root, "unrelated"), path.join(dist, "linked"), "junction");
  await assert.rejects(sealStudioRuntime(root), /STUDIO_RUNTIME_LINK_REJECTED/);
  assert.equal(await readFile(path.join(root, "unrelated", "keep.txt"), "utf8"), "preserved");
}));

test("rejects invalid manifest identity and traversal paths", () => fixture(async ({ root }) => {
  const artifact = await sealStudioRuntime(root), original = await readFile(artifact.manifestPath, "utf8");
  const reordered = JSON.parse(original);
  reordered.files = reordered.files.map(({ path: name, bytes, sha256 }) => ({ sha256, bytes, path: name }));
  await writeFile(artifact.manifestPath, JSON.stringify(reordered));
  assert.equal((await verifyStudioRuntime(artifact.manifestPath)).id, artifact.id);
  for (const change of [value => { value.id = "0".repeat(64); }, value => { value.files[0].path = "public/../private.txt"; },
    value => { value.files[0].path = "public/assets\\app.js"; }, value => { value.extra = true; }]) {
    const modified = JSON.parse(original); change(modified); await writeFile(artifact.manifestPath, JSON.stringify(modified));
    await assert.rejects(verifyStudioRuntime(artifact.manifestPath), /STUDIO_RUNTIME_/);
  }
}));

test("rejects extra files, altered bytes and invalid existing artifacts without overwriting", () => fixture(async ({ root }) => {
  const artifact = await sealStudioRuntime(root), extra = path.join(artifact.directory, "extra.txt");
  await writeFile(extra, "unexpected"); await assert.rejects(verifyStudioRuntime(artifact.manifestPath), /STUDIO_RUNTIME_ARTIFACT_CHANGED/);
  await unlink(extra); await writeFile(path.join(artifact.directory, "public", "assets", "app.js"), "changed");
  await assert.rejects(sealStudioRuntime(root), /STUDIO_RUNTIME_ARTIFACT_CHANGED/);
  assert.equal(await readFile(path.join(artifact.directory, "public", "assets", "app.js"), "utf8"), "changed");
}));

test("rejects a junction ancestor even when the manifest leaf is a regular file", () => fixture(async ({ root }) => {
  const artifact = await sealStudioRuntime(root), alias = path.join(root, "alias");
  await symlink(artifact.directory, alias, "junction");
  await assert.rejects(verifyStudioRuntime(path.join(alias, "manifest.json")), /STUDIO_RUNTIME_LINK_REJECTED/);
}));

test("requires exact parent origins and explicit supported listener addresses", () => fixture(async ({ root }) => {
  const artifact = await sealStudioRuntime(root), options = { manifestPath: artifact.manifestPath, port: 0 };
  for (const parentOrigins of [[], ["*"], ["https://*.example.test"], ["https://example.test/path"], ["https://user:pass@example.test"],
    ["https://example.test?token=synthetic"], ["https://example.test", "https://example.test"], ["https://example.test; frame-ancestors *"]])
    await assert.rejects(startSealedStudioRuntime({ ...options, parentOrigins }), /STUDIO_RUNTIME_PARENTS_INVALID/);
  for (const host of ["localhost", "192.0.2.1", "::", "0.0.0.0;bad"])
    await assert.rejects(startSealedStudioRuntime({ ...options, host, parentOrigins: ["http://127.0.0.1:3130"] }), /STUDIO_RUNTIME_LISTENER_INVALID/);
}));

test("standalone copy serves GET and HEAD with exact CSP and safe bundle health", () => fixture(async ({ root }) => {
  const artifact = await sealStudioRuntime(root);
  await withServer(artifact, async server => {
    const page = await http(server, "/?parentOrigin=http%3A%2F%2F127.0.0.1%3A3130&channel=synthetic");
    assert.equal(page.status, 200); assert.match(page.body.toString(), /doctype html/);
    assert.match(page.headers["cache-control"], /private.*no-cache/);
    assert.match(page.headers["content-security-policy"], /frame-ancestors http:\/\/127\.0\.0\.1:3130$/);
    assert.match(page.headers["content-security-policy"], /connect-src 'self' blob: data:/);
    assert.equal(page.headers["x-content-type-options"], "nosniff"); assert.equal(page.headers["referrer-policy"], "no-referrer");
    const head = await http(server, "/", "HEAD"); assert.equal(head.status, 200); assert.equal(head.body.length, 0);
    const health = await http(server, "/health"), value = JSON.parse(health.body);
    assert.deepEqual(value, { service: "yummyai-studio-runtime", bundleId: artifact.id, sourceStamp: artifact.manifest.sourceStamp, upstream: artifact.manifest.upstream });
    assert.equal((await http(server, "/health", "HEAD")).body.length, 0);
    assert.equal((await http(server, "/assets/app.js")).status, 200);
  }, true);
}));

test("static transport rejects mutation, unlisted metadata and encoded traversal", () => fixture(async ({ root }) => {
  const artifact = await sealStudioRuntime(root);
  await withServer(artifact, async server => {
    assert.equal((await http(server, "/", "POST")).status, 405);
    for (const target of ["/manifest.json", "/server.mjs", "/.build-stamp", "/../index.html", "/%2e%2e/index.html", "/assets/%2e%2e/index.html",
      "/%252e%252e/index.html", "/%2fassets/app.js", "/assets%5capp.js", "/assets/%00app.js", "/%invalid", "//assets/app.js"])
      assert.equal((await http(server, target)).status, 404, target);
  });
}));

test("each static read detects late changes and refuses a substituted junction", () => fixture(async ({ root }) => {
  const artifact = await sealStudioRuntime(root);
  await withServer(artifact, async server => {
    const file = path.join(artifact.directory, "public", "assets", "app.js");
    await writeFile(file, "late changed bytes"); const changed = await http(server, "/assets/app.js");
    assert.equal(changed.status, 503); assert.equal(changed.body.length, 0);
    await unlink(file); await rmdir(path.dirname(file));
    await symlink(path.join(root, "packages", "canvas-runtime", "dist", "assets"), path.dirname(file), "junction");
    const linked = await http(server, "/assets/app.js"); assert.equal(linked.status, 503); assert.equal(linked.body.length, 0);
    await assert.rejects(verifyStudioRuntime(artifact.manifestPath), /STUDIO_RUNTIME_LINK_REJECTED/);
  });
}));
