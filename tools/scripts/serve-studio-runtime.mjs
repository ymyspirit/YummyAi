import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { pathToFileURL, URL } from "node:url";

const fail = code => { throw new Error(`STUDIO_RUNTIME_${code}`); };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

function keys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function studioRuntimeManifestId(core) { return sha(JSON.stringify(canonical(core))); }

function relativeFile(value) {
  if (typeof value !== "string" || !value || value.length > 1000 || /[\\:%?#]/.test(value)
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || path.posix.isAbsolute(value) || value.split("/").some(part => !part || part === "." || part === ".."
      || /[. ]$/.test(part) || /^\.env(?:\.|$)/i.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
    fail("PATH_INVALID");
  return value;
}

/** Inspect every ancestor, including Windows junctions; never rely on a leaf alone. */
export async function studioRuntimePath(target, kind) {
  if (typeof target !== "string" || !path.isAbsolute(target) || !["directory", "file"].includes(kind)) fail("PATH_INVALID");
  target = path.resolve(target);
  const root = path.parse(target).root, parts = target.slice(root.length).split(path.sep).filter(Boolean);
  let cursor = root;
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail("LINK_REJECTED");
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) fail("LINK_REJECTED");
    if (index < parts.length - 1 || kind === "directory") {
      if (!info.isDirectory()) fail("PATH_INVALID");
    } else if (!info.isFile()) fail("PATH_INVALID");
  }
  return target;
}

export async function readStudioRuntimeFile(target, maxBytes = MAX_FILE_BYTES) {
  await studioRuntimePath(target, "file");
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 0 || info.size > maxBytes) fail("FILE_INVALID");
    const bytes = await handle.readFile();
    const after = await lstat(await studioRuntimePath(target, "file"));
    if (after.dev !== info.dev || after.ino !== info.ino || after.size !== bytes.length || bytes.length > maxBytes)
      fail("FILE_CHANGED");
    return bytes;
  } finally { await handle.close(); }
}

export async function studioRuntimeInventory(directory, prefix = "") {
  await studioRuntimePath(directory, "directory");
  const result = [];
  let totalBytes = 0;
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
    const name = relativeFile(prefix ? `${prefix}/${entry.name}` : entry.name), target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail("LINK_REJECTED");
    if (entry.isDirectory()) {
      const nested = await studioRuntimeInventory(target, name);
      result.push(...nested); totalBytes += nested.reduce((sum, file) => sum + file.bytes, 0);
    }
    else if (entry.isFile()) {
      const bytes = await readStudioRuntimeFile(target);
      result.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
      totalBytes += bytes.length;
    } else fail("FILE_INVALID");
    if (result.length > 20_000 || totalBytes > MAX_TOTAL_BYTES) fail("FILES_LIMIT");
  }
  return result.sort((a, b) => compare(a.path, b.path));
}

function validateManifest(value) {
  if (!keys(value, ["schemaVersion", "kind", "id", "sourceStamp", "upstream", "files"])
    || value.schemaVersion !== 1 || value.kind !== "yummyai-studio-runtime" || !hex(value.id) || !hex(value.sourceStamp)
    || !keys(value.upstream, ["tag", "commit", "adapterVersion", "lockSha256"])
    || !/^v\d+\.\d+\.\d+$/.test(value.upstream.tag ?? "") || !/^[a-f0-9]{40}$/.test(value.upstream.commit ?? "")
    || !/^\d+\.\d+\.\d+$/.test(value.upstream.adapterVersion ?? "") || !hex(value.upstream.lockSha256)
    || !Array.isArray(value.files) || value.files.length < 2 || value.files.length > 20_000) fail("MANIFEST_INVALID");
  const names = new Set();
  let previous = "", totalBytes = 0;
  for (const entry of value.files) {
    if (!keys(entry, ["path", "bytes", "sha256"])) fail("MANIFEST_INVALID");
    relativeFile(entry.path);
    if (!(entry.path === "server.mjs" || entry.path.startsWith("public/")) || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES || !hex(entry.sha256) || names.has(entry.path.toLowerCase())
      || compare(previous, entry.path) >= 0 || ["public/.build-stamp", "public/manifest.json", "public/server.mjs"].includes(entry.path)) fail("MANIFEST_INVALID");
    previous = entry.path; names.add(entry.path.toLowerCase());
    totalBytes += entry.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) fail("FILES_LIMIT");
  }
  if (!names.has("public/index.html") || !names.has("server.mjs")) fail("MANIFEST_INVALID");
  const { id, ...core } = value;
  if (studioRuntimeManifestId(core) !== id) fail("MANIFEST_CHECKSUM");
  return value;
}

export async function verifyStudioRuntime(manifestPath) {
  if (typeof manifestPath !== "string" || !path.isAbsolute(manifestPath) || path.basename(manifestPath) !== "manifest.json") fail("PATH_INVALID");
  manifestPath = path.resolve(manifestPath);
  let manifest;
  try { manifest = validateManifest(JSON.parse((await readStudioRuntimeFile(manifestPath, MAX_MANIFEST_BYTES)).toString("utf8"))); }
  catch (error) {
    if (error instanceof Error && /^STUDIO_RUNTIME_[A-Z_]+$/.test(error.message)) throw error;
    fail("MANIFEST_INVALID");
  }
  const directory = path.dirname(manifestPath);
  if (/^[a-f0-9]{64}$/.test(path.basename(directory)) && path.basename(directory) !== manifest.id) fail("MANIFEST_CHECKSUM");
  const files = (await studioRuntimeInventory(directory)).filter(entry => entry.path !== "manifest.json");
  if (JSON.stringify(canonical(files)) !== JSON.stringify(canonical(manifest.files))) fail("ARTIFACT_CHANGED");
  // Return a detached, deeply frozen manifest: callers cannot alter the running
  // allowlist or the identity reported by an already-started static server.
  for (const entry of manifest.files) Object.freeze(entry);
  Object.freeze(manifest.files); Object.freeze(manifest.upstream); Object.freeze(manifest);
  return { id: manifest.id, directory, manifestPath, manifest };
}

function origins(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 32 || new Set(values).size !== values.length) fail("PARENTS_INVALID");
  for (const value of values) {
    if (typeof value !== "string" || value.length > 2048 || /[\s*;'"\\]/.test(value)) fail("PARENTS_INVALID");
    let url; try { url = new URL(value); } catch { fail("PARENTS_INVALID"); }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== value || url.username || url.password || url.search || url.hash) fail("PARENTS_INVALID");
  }
  return [...values];
}
function requestedFile(raw) {
  if (typeof raw !== "string" || raw.length > 8192 || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("#")) fail("PATH_INVALID");
  let decoded; try { decoded = decodeURIComponent(raw.split("?")[0]); } catch { fail("PATH_INVALID"); }
  if (decoded === "/") return "public/index.html";
  return relativeFile(`public/${decoded.slice(1)}`);
}
const mediaTypes = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".json": "application/json; charset=utf-8" };

export async function startSealedStudioRuntime({ manifestPath, host = "127.0.0.1", port, parentOrigins } = {}) {
  if (!["127.0.0.1", "0.0.0.0"].includes(host) || !Number.isSafeInteger(port) || port < 0 || port > 65535) fail("LISTENER_INVALID");
  const parents = origins(parentOrigins), descriptor = await verifyStudioRuntime(manifestPath);
  const allowed = new Map(descriptor.manifest.files.filter(entry => entry.path.startsWith("public/")).map(entry => [entry.path, entry]));
  const csp = "default-src 'self'; script-src 'self' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https:; media-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' blob: data:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors " + parents.join(" ");
  const headers = { "cache-control": "private, no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": csp };
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 }, (request, response) => {
    const end = (status, body = Buffer.alloc(0), type = "text/plain; charset=utf-8") => {
      response.writeHead(status, { ...headers, "content-type": type, "content-length": body.length,
        ...(status === 405 ? { allow: "GET, HEAD", connection: "close" } : {}) });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    void (async () => {
      if (!["GET", "HEAD"].includes(request.method ?? "")) { request.resume(); end(405); return; }
      let name; try { name = requestedFile(request.url); } catch { end(404); return; }
      if (name === "public/health") {
        const body = Buffer.from(JSON.stringify({ service: "yummyai-studio-runtime", bundleId: descriptor.id,
          sourceStamp: descriptor.manifest.sourceStamp, upstream: descriptor.manifest.upstream }));
        end(200, body, "application/json; charset=utf-8"); return;
      }
      const entry = allowed.get(name);
      if (!entry) { end(404); return; }
      const bytes = await readStudioRuntimeFile(path.join(descriptor.directory, ...name.split("/")));
      if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) fail("ASSET_CHANGED");
      end(200, bytes, mediaTypes[path.posix.extname(name)] ?? "application/octet-stream");
    })().catch(() => { if (!response.headersSent) end(503); else response.destroy(); });
  });
  await new Promise((resolve, reject) => {
    const failed = error => reject(error);
    server.once("error", failed);
    server.listen(port, host, () => { server.removeListener("error", failed); resolve(); });
  });
  return server;
}

async function main() {
  const rawPort = process.env.PORT ?? "8080";
  if (!/^[1-9]\d{0,4}$/.test(rawPort)) fail("LISTENER_INVALID");
  let parentOrigins; try { parentOrigins = JSON.parse(process.env.STUDIO_PARENT_ORIGINS ?? "null"); } catch { fail("PARENTS_INVALID"); }
  const server = await startSealedStudioRuntime({ manifestPath: process.env.STUDIO_RUNTIME_MANIFEST,
    host: process.env.STUDIO_BIND_HOST ?? "127.0.0.1", port: Number(rawPort), parentOrigins });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { server.close(); });
  process.stdout.write("YummyAI sealed studio runtime ready\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { process.stderr.write("STUDIO_RUNTIME_START_FAILED\n"); process.exitCode = 1; });
