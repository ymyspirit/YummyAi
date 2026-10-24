import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile), workspace = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const lock = JSON.parse(await readFile(new URL("../../packages/mockup-renderer/runtime-lock.json", import.meta.url), "utf8"));
const root = join(workspace, ".artifacts", "runtime-tools"), destination = join(root, lock.directory);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function owned(path) {
  const normalized = resolve(path), within = relative(root, normalized);
  if (!within || within.startsWith(".." + sep) || within === ".." || isAbsolute(within)) throw new Error("Runtime path escaped its declared directory");
  return normalized;
}
async function verify(directory) {
  owned(directory);
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Runtime directory must not be a link");
  for (const [name, expected] of Object.entries(lock.files)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || (await lstat(join(directory, name))).isSymbolicLink()
      || hash(await readFile(join(directory, name))) !== expected) throw new Error("Runtime files do not match the pinned release");
  }
}
async function cleanupStaging(staging) {
  const target = owned(staging);
  if (dirname(target) !== root || (await lstat(target)).isSymbolicLink()) throw new Error("Unsafe runtime staging cleanup");
  await rm(target, { recursive: true, force: true });
}
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Use a trusted server-installed ImageMagick on this platform");
if (!/^[a-z0-9.-]+$/.test(lock.directory)) throw new Error("Invalid pinned runtime directory");
for (const directory of [join(workspace, ".artifacts"), root]) {
  if (existsSync(directory) && (await lstat(directory)).isSymbolicLink()) throw new Error("Runtime ancestors must not be links");
  await mkdir(directory, { recursive: true });
}
if (!existsSync(destination)) {
  const staging = owned(await mkdtemp(join(root, "install-imagemagick-")));
  try {
    const response = await globalThis.fetch(lock.source, { signal: globalThis.AbortSignal.timeout(45000), redirect: "error" });
    if (!response.ok || Number(response.headers.get("content-length")) > 32 * 1024 * 1024) throw new Error("Pinned runtime download unavailable");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Pinned runtime download body missing");
    const chunks = []; let received = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        received += part.value.length;
        if (received > 32 * 1024 * 1024) throw new Error("Pinned runtime download exceeded its byte limit");
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    if (hash(bytes) !== lock.archiveSha256) throw new Error("Pinned runtime archive checksum mismatch");
    const archive = join(staging, "runtime.7z"), extracted = join(staging, "extracted");
    await writeFile(archive, bytes); await mkdir(extracted);
    const options = { windowsHide: true, maxBuffer: 2 * 1024 * 1024, timeout: 30000 };
    const listing = await execute("tar", ["-tf", archive], options), details = await execute("tar", ["-tvf", archive], options);
    if (listing.stdout.split(/\r?\n/).filter(Boolean).some(name => !/^[a-zA-Z0-9_.-]+$/.test(name) || name === "." || name === "..")
      || details.stdout.split(/\r?\n/).some(line => /^[lh]/.test(line))) throw new Error("Unsafe runtime archive entry");
    await execute("tar", ["-xf", archive, "-C", extracted], options); await verify(extracted);
    // Both resolved targets are checked before moving this newly owned directory.
    owned(extracted); owned(destination);
    if (existsSync(destination)) throw new Error("Runtime target appeared during installation; verify it before retrying");
    await rename(extracted, destination);
  } finally {
    await cleanupStaging(staging);
  }
}
await verify(destination);
const version = await execute(join(destination, "magick.exe"), ["-version"], { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
process.stdout.write(JSON.stringify({ verified: true, version: version.stdout.split(/\r?\n/)[0], files: Object.keys(lock.files).length, path: destination }) + "\n");
