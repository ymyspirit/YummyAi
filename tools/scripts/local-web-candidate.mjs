import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const portable = (name) => name.split(path.sep).join("/");
const fail = (code) => { throw new Error("Web candidate: " + code); };

function relativeFile(name) {
  if (typeof name !== "string" || !name || name.includes("\\") || name.includes("\0") ||
      path.posix.isAbsolute(name) || /^[a-z]:/i.test(name) ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      name.split("/").some((part) => part.startsWith(".env") && part !== ".env.example"))
    fail("invalid_relative_file");
  return name;
}

async function regularFile(root, name) {
  const parts = relativeFile(name).split("/");
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()))
      fail("source_not_regular");
  }
  return current;
}

async function directoryWithoutLinks(root, name) {
  let current = root;
  for (const part of relativeFile(name).split("/")) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("candidate_parent_not_regular");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
  return current;
}

function candidatePath(root, id) {
  if (!/^[a-f0-9]{32}$/.test(id)) fail("invalid_identity");
  return path.join(root, ".artifacts", "local-web-releases", id);
}

export function parseWebCandidateArgs(args) {
  let id;
  const nextArgs = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--candidate" || arg.startsWith("--candidate=")) {
      if (id !== undefined) fail("duplicate_identity");
      id = arg === "--candidate" ? args[++index] : arg.slice("--candidate=".length);
      if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) fail("invalid_identity");
    } else nextArgs.push(arg);
  }
  return { id, nextArgs };
}

export async function verifyWebSource(root, source) {
  if (!source || !Array.isArray(source.files) || !/^[a-f0-9]{64}$/.test(source.sha256 ?? "") ||
      sha(JSON.stringify(source.files)) !== source.sha256) fail("invalid_source_manifest");
  const names = new Set();
  for (const entry of source.files) {
    const name = relativeFile(entry.path);
    if (names.has(name) || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) fail("invalid_source_manifest");
    names.add(name);
    const bytes = await readFile(await regularFile(root, name));
    if (sha(bytes) !== entry.sha256 || (entry.bytes !== undefined && bytes.length !== entry.bytes))
      fail("source_changed");
  }
  for (const name of ["pnpm-lock.yaml", "apps/web/next.config.ts", "apps/web/src/app/layout.tsx", "packages/contracts/src/index.ts"])
    if (!names.has(name)) fail("source_incomplete");
}

async function inventory(root, prefix = "", skip = () => false) {
  const files = [];
  for (const item of (await readdir(path.join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? prefix + "/" + item.name : item.name;
    if (skip(name)) continue;
    if (item.isSymbolicLink()) fail("artifact_link");
    if (item.isDirectory()) files.push(...await inventory(root, name, skip));
    else if (item.isFile()) {
      const bytes = await readFile(path.join(root, name));
      files.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
    } else fail("artifact_not_regular");
  }
  return files;
}

async function copy(root, target, name) {
  const from = await regularFile(root, name), to = path.join(target, name);
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
}

export async function prepareLocalWebCandidate(root, id, source) {
  root = await realpath(root);
  const target = candidatePath(root, id);
  await verifyWebSource(root, source);
  const publicFiles = await inventory(path.join(root, "apps/web/public"));
  await directoryWithoutLinks(root, ".artifacts/local-web-releases");
  await mkdir(target); // An existing candidate, including a failed candidate, is never overwritten.
  const web = path.join(target, "apps/web");
  await mkdir(web, { recursive: true });
  await writeFile(path.join(target, "operation.json"), JSON.stringify({ schemaVersion: 1, id, status: "preparing", sourceSha256: source.sha256, recordedAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx" });
  for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "apps/web/package.json", "apps/web/tsconfig.json", "apps/web/next-env.d.ts", "apps/web/next.config.ts"])
    await copy(root, target, file);
  for (const file of source.files.filter((file) => file.path.startsWith("apps/web/src/"))) await copy(root, target, file.path);
  for (const file of source.files.filter((file) => file.path.startsWith("patches/"))) await copy(root, target, file.path);
  for (const file of publicFiles) await copy(root, target, "apps/web/public/" + file.path);
  for (const [from, to] of [["node_modules", "node_modules"], ["packages", "packages"], ["apps/web/node_modules", "apps/web/node_modules"]])
    await symlink(path.join(root, from), path.join(target, to), "junction");
  await verifyWebSource(root, source);
  return { root, id, target, web, source, publicFiles };
}

const artifactSkip = (name) => name === "node_modules" || name === ".next/cache" || name === ".next/trace" || name === ".next/trace-build" || name === ".next/diagnostics" || name.endsWith(".tsbuildinfo");

export async function completeLocalWebCandidate(candidate) {
  const { root, id, target, web, source, publicFiles } = candidate;
  await verifyWebSource(root, source);
  assert.deepEqual(await inventory(path.join(root, "apps/web/public")), publicFiles, "Public build inputs changed");
  for (const name of [".next/BUILD_ID", ".next/required-server-files.json", ".next/server/app-paths-manifest.json"])
    await regularFile(web, name);
  const buildId = (await readFile(path.join(web, ".next/BUILD_ID"), "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(buildId)) fail("invalid_build_identity");
  const artifacts = await inventory(web, "", artifactSkip);
  const manifest = {
    schemaVersion: 1, scope: "local-web-runtime", id, status: "built", recordedAt: new Date().toISOString(),
    buildId, sourceSha256: source.sha256, sourceFiles: source.files.length,
    dependencyLockSha256: sha(await readFile(path.join(root, "pnpm-lock.yaml"))),
    dependencyPatches: source.files.filter(file => file.path.startsWith("patches/")).map(file => ({ path: file.path, sha256: file.sha256 })),
    nextVersion: JSON.parse(await readFile(path.join(web, "node_modules/next/package.json"), "utf8")).version,
    artifactsSha256: sha(JSON.stringify(artifacts)), artifacts,
    sharedReadOnlyPaths: ["node_modules", "packages", "apps/web/node_modules"],
    noEnvironmentFilesCopied: true, previousBuildPreserved: true,
    productionIdentityAccepted: false, fullPlatformAccepted: false,
  };
  await writeFile(path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  await writeFile(path.join(target, "operation.json"), JSON.stringify({ schemaVersion: 1, id, status: "built", sourceSha256: source.sha256, buildId, recordedAt: manifest.recordedAt }, null, 2) + "\n");
  return verifyLocalWebCandidate(root, id);
}

export async function verifyLocalWebCandidate(root, id) {
  root = await realpath(root);
  const target = candidatePath(root, id);
  await regularFile(root, portable(path.relative(root, path.join(target, "manifest.json"))));
  const manifest = JSON.parse(await readFile(path.join(target, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.scope !== "local-web-runtime" || manifest.status !== "built" || manifest.id !== id ||
      !/^[a-f0-9]{64}$/.test(manifest.sourceSha256 ?? "") || !Array.isArray(manifest.artifacts) ||
      sha(JSON.stringify(manifest.artifacts)) !== manifest.artifactsSha256) fail("invalid_artifact_manifest");
  if (sha(await readFile(path.join(root, "pnpm-lock.yaml"))) !== manifest.dependencyLockSha256) fail("dependencies_changed");
  for (const patch of manifest.dependencyPatches ?? []) {
    if (!patch.path?.startsWith("patches/") || !/^[a-f0-9]{64}$/.test(patch.sha256 ?? "")) fail("invalid_patch_manifest");
    if (sha(await readFile(await regularFile(root, patch.path))) !== patch.sha256 ||
        sha(await readFile(await regularFile(target, patch.path))) !== patch.sha256) fail("dependency_patch_changed");
  }
  for (const name of ["node_modules", "packages", "apps/web/node_modules"])
    if (await realpath(path.join(target, name)) !== await realpath(path.join(root, name))) fail("shared_dependency_target_changed");
  const web = path.join(target, "apps/web");
  if (JSON.parse(await readFile(path.join(web, "node_modules/next/package.json"), "utf8")).version !== manifest.nextVersion)
    fail("next_version_changed");
  const artifacts = await inventory(web, "", artifactSkip);
  if (sha(JSON.stringify(artifacts)) !== manifest.artifactsSha256) fail("artifact_changed");
  if ((await readFile(path.join(web, ".next/BUILD_ID"), "utf8")).trim() !== manifest.buildId) fail("build_identity_changed");
  return { target, web, manifest };
}

export async function buildLocalWebCandidate(root, id, source) {
  const candidate = await prepareLocalWebCandidate(root, id, source);
  const next = path.join(root, "apps/web/node_modules/next/dist/bin/next");
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [next, "build", "--webpack"], {
      cwd: candidate.web, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, stdio: "inherit", windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode));
  });
  if (code !== 0) {
    await writeFile(path.join(candidate.target, "operation.json"), JSON.stringify({ schemaVersion: 1, id, status: "build_failed", exitCode: code, recordedAt: new Date().toISOString() }, null, 2) + "\n");
    fail("build_failed");
  }
  return completeLocalWebCandidate(candidate);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, id, sourcePath, ...extra] = process.argv.slice(2);
  if (!["build", "verify"].includes(command) || extra.length || (command === "verify" && sourcePath) || (command === "build" && !sourcePath))
    fail("usage_build_identity_source_manifest_or_verify_identity");
  const result = command === "build"
    ? await buildLocalWebCandidate(workspace, id, JSON.parse(await readFile(await regularFile(workspace, sourcePath), "utf8")))
    : await verifyLocalWebCandidate(workspace, id);
  process.stdout.write(JSON.stringify({ id, status: "verified", buildId: result.manifest.buildId, sourceSha256: result.manifest.sourceSha256, files: result.manifest.artifacts.length }) + "\n");
}
