import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { promisify } from "node:util";
import { workspaceIntegrationArgs } from "../testing/require-disposable-integration.mjs";

test("a failed workspace cannot end the fixture lifetime before its sibling finishes", { timeout: 20000 }, async () => {
  const cli = process.env.npm_execpath;
  assert.ok(cli && /pnpm/i.test(cli), "Run this probe through pnpm test:tools");
  const base = await realpath(tmpdir()), directory = await mkdtemp(join(base, "yummyai-integration-lifecycle-"));
  try {
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "yummyai-erp", private: true, packageManager: "pnpm@11.10.0",
      scripts: { "test:integration": "node root.mjs" } }));
    await writeFile(join(directory, "root.mjs"), 'import {writeFileSync} from "node:fs";writeFileSync("root-executed.txt","unsafe recursion");');
    await writeFile(join(directory, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    for (const name of ["first", "second"]) {
      const target = join(directory, "packages", name); await mkdir(target, { recursive: true });
      await writeFile(join(target, "package.json"), JSON.stringify({ name: `synthetic-integration-${name}`, private: true,
        scripts: { "test:integration": "node probe.mjs" } }));
      await writeFile(join(target, "probe.mjs"), name === "first" ? "process.exitCode=1;" :
        'import {writeFileSync} from "node:fs";setTimeout(()=>writeFileSync("finished.txt","completed before fixture teardown"),400);');
    }
    let result;
    try {
      await promisify(execFile)(process.execPath, [cli, "--include-workspace-root", ...workspaceIntegrationArgs()], {
        cwd: directory, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
      });
    } catch (error) { result = error; }
    assert.equal(result?.code, 1, "The original failing workspace must still fail the overall run");
    assert.equal(await readFile(join(directory, "packages", "second", "finished.txt"), "utf8"), "completed before fixture teardown");
    await assert.rejects(access(join(directory, "root-executed.txt")), { code: "ENOENT" });
  } finally {
    const target = resolve(directory);
    assert.equal(dirname(target), base); assert.ok(basename(target).startsWith("yummyai-integration-lifecycle-"));
    assert.equal((await lstat(target)).isSymbolicLink(), false);
    await rm(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});
