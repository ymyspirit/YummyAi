import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import test from "node:test";
import { prepareAcceptanceOutput } from "../testing/acceptance-output.mjs";

const require = createRequire(import.meta.url);
const token = () => randomUUID().replaceAll("-", "");
async function fixture(run) {
  const base = await realpath(tmpdir());
  const workspace = await mkdtemp(path.join(base, "yummyai-output-policy-"));
  try { await mkdir(path.join(workspace, "tmp")); return await run(workspace); }
  finally {
    assert.equal(path.dirname(workspace), base);
    assert(path.basename(workspace).startsWith("yummyai-output-policy-"));
    assert.equal((await lstat(workspace)).isSymbolicLink(), false);
    await rm(workspace, { recursive: true, force: true });
    await assert.rejects(access(workspace), { code: "ENOENT" });
  }
}

test("every invocation owns a fresh cache leaf even when the caller reuses a parent", async () => fixture(async workspace => {
  const parent = path.join(workspace, "tmp", "caller");
  await mkdir(parent); await writeFile(path.join(parent, "keep.txt"), "caller data");
  const one = await prepareAcceptanceOutput({ workspace, token: token(), requestedRoot: parent });
  const two = await prepareAcceptanceOutput({ workspace, token: token(), requestedRoot: parent });
  assert.notEqual(one.artifactDirectory, two.artifactDirectory);
  assert.equal(await readFile(path.join(parent, "keep.txt"), "utf8"), "caller data");
  assert.deepEqual(one.browserArgs, ["--output", one.browserOutputDirectory]);
  assert.equal(JSON.parse(await readFile(one.receiptPath, "utf8")).browserOutputDirectory, one.browserOutputDirectory);
}));

test("existing or protected outputs fail before creating run directories or changing sentinels", async () => fixture(async workspace => {
  const old = path.join(workspace, "tmp", "old"); await mkdir(old);
  await writeFile(path.join(old, "sentinel.txt"), "preserve original bytes");
  const id = token();
  await assert.rejects(prepareAcceptanceOutput({ workspace, token: id, args: ["--output", old] }), /output_already_exists/);
  await assert.rejects(access(path.join(workspace, "tmp", "order-daily-artifacts-" + id)), { code: "ENOENT" });
  assert.equal(await readFile(path.join(old, "sentinel.txt"), "utf8"), "preserve original bytes");
  const blocked = path.join(workspace, "tmp", "frozen");
  for (const output of [blocked, path.join(blocked, "child")])
    await assert.rejects(prepareAcceptanceOutput({ workspace, token: token(), args: ["--output=" + output], protectedPaths: [blocked] }), /protected_path/);
  await assert.rejects(prepareAcceptanceOutput({ workspace, token: token(), requestedRoot: blocked, protectedPaths: [blocked] }), /protected_path/);
}));

for (const shape of ["string", "object"]) test(`the current protection record blocks a historical path without touching it (${shape})`, async () => fixture(async workspace => {
  const checkpoint = path.join(workspace, "docs/project-control/checkpoints"); await mkdir(checkpoint, { recursive: true });
  const protectedPath = path.join(workspace, "tmp", "historical");
  await writeFile(path.join(checkpoint, "frozen.json"), JSON.stringify({ cumulativeRejectedPaths: [protectedPath] }));
  const record = "docs/project-control/checkpoints/frozen.json";
  await writeFile(path.join(workspace, "docs/project-control/state.json"), JSON.stringify({ cleanupPolicy: { latestPolicyRejection: shape === "string" ? record : { record } } }));
  await assert.rejects(prepareAcceptanceOutput({ workspace, token: token(), args: ["--output", protectedPath] }), /protected_path/);
  await assert.rejects(access(protectedPath), { code: "ENOENT" });
}));

test("unsafe arguments and source directories are rejected before mutation", async () => fixture(async workspace => {
  for (const args of [["--output"], ["--output="], ["--output", "--workers=1"], ["--output=a", "--output=b"], ["--last-failed"], ["--last-failed-file=old.json"]])
    await assert.rejects(prepareAcceptanceOutput({ workspace, token: token(), args }), /Acceptance output/);
  for (const requestedRoot of [workspace, path.join(workspace, "apps"), path.join(workspace, "tmp", "..", "packages"), path.dirname(workspace)])
    await assert.rejects(prepareAcceptanceOutput({ workspace, token: token(), requestedRoot }), /outside_temporary_workspace/);
  const selected = path.join(workspace, "tmp", "separate-output");
  const owned = await prepareAcceptanceOutput({ workspace, token: token(), args: ["--output=" + selected, "--output-root=other", "--workers=1"] });
  assert.equal(owned.browserOutputDirectory, selected);
  assert.deepEqual(owned.forwardedArgs, ["--output-root=other", "--workers=1"]);
}));

test("junction output parents cannot redirect artifacts into another directory", async () => fixture(async workspace => {
  const target = path.join(workspace, "keep"), linked = path.join(workspace, "tmp", "linked");
  await mkdir(target); await writeFile(path.join(target, "keep.txt"), "untouched");
  await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
  try {
    await assert.rejects(prepareAcceptanceOutput({ workspace, token: token(), requestedRoot: linked }), /linked_path/);
    await assert.rejects(prepareAcceptanceOutput({ workspace, token: token(), args: ["--output", path.join(linked, "output")] }), /linked_path/);
    assert.equal(await readFile(path.join(target, "keep.txt"), "utf8"), "untouched");
  } finally { await unlink(linked); }
}));

test("an output cannot contain the cache lease and an existing lease cannot be reused", async () => fixture(async workspace => {
  const selected = path.join(workspace, "tmp", "selected"), id = token();
  await assert.rejects(prepareAcceptanceOutput({ workspace, token: id, requestedRoot: selected, args: ["--output", selected] }), /output_contains_cache_root/);
  await assert.rejects(access(selected), { code: "ENOENT" });
  const first = await prepareAcceptanceOutput({ workspace, token: id });
  await writeFile(path.join(first.artifactDirectory, "sentinel.txt"), "original run");
  await assert.rejects(prepareAcceptanceOutput({ workspace, token: id }), /output_already_exists/);
  assert.equal(await readFile(path.join(first.artifactDirectory, "sentinel.txt"), "utf8"), "original run");
}));

test("real Playwright owns static outputDir, conversion cache, last-run and all standard file reporters", { timeout: 30000 }, async () => fixture(async workspace => {
  const old = path.join(workspace, "tmp", "old-output"); await mkdir(old);
  await writeFile(path.join(old, "keep.txt"), "original retained");
  const oldBlob = path.join(old, "keep.zip");
  await writeFile(oldBlob, "original archive retained");
  const tests = path.join(workspace, "tests"); await mkdir(tests);
  const packagePath = require.resolve("@playwright/test/package.json");
  const testSource = 'import {createRequire} from "node:module";import {writeFile} from "node:fs/promises";const require=createRequire(' + JSON.stringify(packagePath) + ');const {test}=require("@playwright/test");test("owned artifact",async({},info)=>{const content:string="synthetic artifact";await writeFile(info.outputPath("owned.txt"),content);});';
  await writeFile(path.join(tests, "output.spec.ts"), testSource);
  const config = path.join(workspace, "playwright.config.mjs");
  await writeFile(config, "export default " + JSON.stringify({ testDir: tests, outputDir: old, reporter: "list", workers: 1 }) + ";\n");
  const output = await prepareAcceptanceOutput({ workspace, token: token() });
  const cli = require.resolve("@playwright/test/cli");
  const { stdout } = await promisify(execFile)(process.execPath, [cli, "test", "--config", config, "--reporter=list,blob,html,json,junit", ...output.browserArgs], {
    cwd: workspace, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PLAYWRIGHT_LAST_RUN_OUTPUT_FILE: path.join(old, "forbidden-last-run.json"), PLAYWRIGHT_BLOB_OUTPUT_FILE: oldBlob, ...output.environment,
      PWTEST_CACHE_DIR: path.join(output.artifactDirectory, "transform-cache"), TSX_DISABLE_CACHE: "1" },
  });
  assert.match(stdout, /1 passed/);
  assert.equal(await readFile(path.join(old, "keep.txt"), "utf8"), "original retained");
  assert.equal(await readFile(oldBlob, "utf8"), "original archive retained");
  await assert.rejects(access(path.join(old, "forbidden-last-run.json")), { code: "ENOENT" });
  const run = JSON.parse(await readFile(path.join(output.browserOutputDirectory, ".last-run.json"), "utf8"));
  assert.equal(run.status, "passed");
  await access(path.join(output.artifactDirectory, "transform-cache"));
  for (const report of ["html/index.html", "results.json", "results.xml", "blob/report.zip"])
    await access(path.join(output.artifactDirectory, "reports", report));
}));
