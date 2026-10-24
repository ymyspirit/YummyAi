import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { readStudioRuntimeFile, studioRuntimeInventory, studioRuntimeManifestId, studioRuntimePath, verifyStudioRuntime } from "./serve-studio-runtime.mjs";

export { verifyStudioRuntime } from "./serve-studio-runtime.mjs";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = code => { throw new Error(`STUDIO_RUNTIME_${code}`); };
const serverSource = fileURLToPath(new URL("./serve-studio-runtime.mjs", import.meta.url));

async function directory(parent, name) {
  await studioRuntimePath(parent, "directory");
  const target = path.join(parent, name);
  try { await mkdir(target); } catch (error) { if (error.code !== "EEXIST") throw error; }
  return studioRuntimePath(target, "directory");
}

async function verifyUpstream(runtime) {
  const bytes = await readStudioRuntimeFile(path.join(runtime, "upstream.lock.json"), 2 * 1024 * 1024);
  let lock; try { lock = JSON.parse(bytes.toString("utf8")); } catch { fail("UPSTREAM_INVALID"); }
  if (!lock || lock.repository !== "https://github.com/basketikun/infinite-canvas" || lock.sourcePrefix !== "web"
    || lock.verifiedAgainstUpstreamTree !== true || !/^v\d+\.\d+\.\d+$/.test(lock.tag ?? "")
    || !/^[a-f0-9]{40}$/.test(lock.commit ?? "") || !/^\d+\.\d+\.\d+$/.test(lock.adapterVersion ?? "")
    || !lock.files || typeof lock.files !== "object" || Array.isArray(lock.files)) fail("UPSTREAM_INVALID");
  const files = await studioRuntimeInventory(path.join(runtime, "vendor"));
  if (!files.length || Object.keys(lock.files).length !== files.length || !Object.hasOwn(lock.files, "LICENSE")) fail("UPSTREAM_CHANGED");
  for (const entry of files) {
    const pinned = Object.hasOwn(lock.files, entry.path) ? lock.files[entry.path] : null;
    if (!pinned || pinned.bytes !== entry.bytes || pinned.sha256 !== entry.sha256
      || !/^[a-f0-9]{40}$/.test(pinned.gitBlob ?? "") || !/^[a-f0-9]{40}$/.test(pinned.gitBlobLf ?? "")) fail("UPSTREAM_CHANGED");
  }
  return { tag: lock.tag, commit: lock.commit, adapterVersion: lock.adapterVersion, lockSha256: sha(bytes) };
}

/** Seal only an already-built, stable dist. Never invokes a builder or a server. */
export async function sealStudioRuntime(root) {
  root = await studioRuntimePath(root, "directory");
  const runtime = path.join(root, "packages", "canvas-runtime"), dist = path.join(runtime, "dist");
  const upstream = await verifyUpstream(runtime);
  const stampFile = path.join(dist, ".build-stamp"), stampBytes = await readStudioRuntimeFile(stampFile, 80);
  const sourceStamp = stampBytes.toString("utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(sourceStamp)) fail("SOURCE_STAMP_INVALID");
  const inventory = await studioRuntimeInventory(dist), publicFiles = inventory.filter(entry => entry.path !== ".build-stamp");
  if (!publicFiles.some(entry => entry.path === "index.html") || publicFiles.length < 1
    || publicFiles.some(entry => ["manifest.json", "server.mjs"].includes(entry.path))) fail("DIST_INVALID");
  const bodies = new Map();
  for (const entry of publicFiles) {
    const bytes = await readStudioRuntimeFile(path.join(dist, ...entry.path.split("/")));
    if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) fail("DIST_CHANGED");
    bodies.set(`public/${entry.path}`, bytes);
  }
  bodies.set("server.mjs", await readStudioRuntimeFile(serverSource));
  if (!stampBytes.equals(await readStudioRuntimeFile(stampFile, 80)) || JSON.stringify(inventory) !== JSON.stringify(await studioRuntimeInventory(dist))) fail("DIST_CHANGED");
  const files = [...bodies].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha(bytes) }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const core = { schemaVersion: 1, kind: "yummyai-studio-runtime", sourceStamp, upstream, files };
  const id = studioRuntimeManifestId(core), manifest = { ...core, id };
  const artifacts = await directory(root, ".artifacts"), releases = await directory(artifacts, "studio-runtime-releases");
  const destination = path.join(releases, id), manifestPath = path.join(destination, "manifest.json");
  // Exclusive directory creation prevents another seal from replacing an
  // existing ID. Interrupted new artifacts fail closed on subsequent attempts.
  try { await mkdir(destination); }
  catch (error) { if (error.code === "EEXIST") return verifyStudioRuntime(manifestPath); throw error; }
  await studioRuntimePath(destination, "directory");
  for (const [name, bytes] of bodies) {
    let parent = destination;
    const parts = name.split("/");
    for (const segment of parts.slice(0, -1)) parent = await directory(parent, segment);
    await writeFile(path.join(parent, parts.at(-1)), bytes, { flag: "wx", mode: 0o644 });
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o644 });
  return verifyStudioRuntime(manifestPath);
}
