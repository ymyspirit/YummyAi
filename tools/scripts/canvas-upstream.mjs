import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import { readFile, readdir, realpath, writeFile, rename } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const runtime = fileURLToPath(new URL("../../packages/canvas-runtime/", import.meta.url));
export async function inventory(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error("Upstream inventory cannot contain symbolic links");
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path), normalized = Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"));
        const blob = value => createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex");
        result[relative(root, path).split(sep).join("/")] = { sha256: createHash("sha256").update(bytes).digest("hex"), gitBlob: blob(bytes), gitBlobLf: blob(normalized), bytes: bytes.length };
      }
    }
  }
  await visit(root);
  return result;
}
export function compareInventory(expected, actual) {
  return {
    added: Object.keys(actual).filter(name => !(name in expected)),
    removed: Object.keys(expected).filter(name => !(name in actual)),
    changed: Object.keys(expected).filter(name => name in actual && expected[name].sha256 !== actual[name].sha256),
  };
}
export async function verifyCanvasUpstream() {
  const lock = JSON.parse(await readFile(resolve(runtime, "upstream.lock.json"), "utf8"));
  const actual = await inventory(resolve(runtime, "vendor"));
  const changes = compareInventory(lock.files, actual);
  if (Object.values(changes).some(files => files.length)) throw new Error(`Vendored upstream differs from its reviewed lock: ${JSON.stringify(changes)}`);
  return { tag: lock.tag, commit: lock.commit, adapterVersion: lock.adapterVersion, fileCount: Object.keys(actual).length, vendorUnchanged: true };
}
async function github(path) {
  const response = await globalThis.fetch(`https://api.github.com/repos/basketikun/infinite-canvas/${path}`, { headers: { accept: "application/vnd.github+json" }, redirect: "error", signal: globalThis.AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Upstream metadata unavailable (HTTP ${response.status})`);
  return response.json();
}
async function record(tag, commit, adapterVersion) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "") || !/^[a-f0-9]{40}$/.test(commit ?? "") || !/^\d+\.\d+\.\d+$/.test(adapterVersion ?? "")) throw new Error("record requires an exact release tag, full commit SHA and adapter version");
  let ref = (await github(`git/ref/tags/${tag}`)).object;
  for (let depth = 0; ref.type === "tag" && depth < 5; depth++) ref = (await github(`git/tags/${ref.sha}`)).object;
  if (ref.type !== "commit" || ref.sha !== commit) throw new Error("The requested release tag does not point to the reviewed commit");
  const tree = await github(`git/trees/${commit}?recursive=1`);
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error("Incomplete upstream tree");
  const files = await inventory(resolve(runtime, "vendor")), byPath = new Map(tree.tree.filter(entry => entry.type === "blob").map(entry => [entry.path, entry.sha]));
  const changed = Object.entries(files).filter(([name, value]) => ![value.gitBlob, value.gitBlobLf].includes(byPath.get(name === "LICENSE" ? name : `web/${name}`))).map(([name]) => name);
  if (changed.length) throw new Error(`Local vendor files differ from the requested release: ${JSON.stringify(changed)}`);
  const previous = JSON.parse(await readFile(resolve(runtime, "upstream.lock.json"), "utf8"));
  const lock = { ...previous, tag, commit, adapterVersion, sourcePrefix: "web", verifiedAgainstUpstreamTree: true, files };
  await writeFile(resolve(runtime, "upstream.lock.json.tmp"), JSON.stringify(lock, null, 2) + "\n");
  await rename(resolve(runtime, "upstream.lock.json.tmp"), resolve(runtime, "upstream.lock.json"));
  process.stdout.write(`Recorded ${Object.keys(files).length} verified files. Build, compatibility tests and review are still required; no runtime was deployed.\n`);
}
async function main() {
  const mode = process.argv[2] ?? "verify";
  if (mode === "record") { await record(...process.argv.slice(3)); return; }
  const current = await verifyCanvasUpstream();
  if (mode === "verify") { process.stdout.write(`${JSON.stringify(current, null, 2)}\n`); return; }
  if (mode === "check") {
    const release = await github("releases/latest");
    if (typeof release.tag_name !== "string" || !/^v\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?$/.test(release.tag_name)) throw new Error("Upstream release tag requires manual review");
    process.stdout.write(`${JSON.stringify({ current, latestTag: release.tag_name, differentVersion: release.tag_name !== current.tag, releaseUrl: `https://github.com/basketikun/infinite-canvas/releases/tag/${encodeURIComponent(release.tag_name)}`, action: "Review a candidate checkout, back up data, run compatibility tests, then switch versions. No files or runtime were updated." }, null, 2)}\n`);
    return;
  }
  if (mode === "compare" && process.argv[3]) {
    const candidate = await realpath(process.argv[3]), expected = await inventory(resolve(runtime, "vendor")), next = {};
    for (const folder of ["src", "public"]) for (const [name, entry] of Object.entries(await inventory(resolve(candidate, "web", folder)))) next[`${folder}/${name}`] = entry;
    const bytes = await readFile(resolve(candidate, "LICENSE"));
    next.LICENSE = { sha256: createHash("sha256").update(bytes).digest("hex") };
    process.stdout.write(`${JSON.stringify({ current, candidate, changes: compareInventory(expected, next), applied: false }, null, 2)}\n`);
    return;
  }
  throw new Error("Usage: canvas-upstream.mjs verify | check | compare <candidate checkout> | record <tag> <commit> <adapter-version>");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
