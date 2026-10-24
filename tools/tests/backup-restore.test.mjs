import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { assertVerificationNames, resolveWorkspacePath } from "../scripts/backup-restore.mjs";

async function sandbox(run) {
  const base = path.resolve(os.tmpdir()), root = await fs.mkdtemp(path.join(base, "yummyai-backup-unit-"));
  try { await run(root); }
  finally {
    const actual = await fs.realpath(root);
    assert.equal(path.dirname(actual).toLowerCase(), (await fs.realpath(base)).toLowerCase());
    assert.match(path.basename(actual), /^yummyai-backup-unit-/);
    await fs.rm(actual, { recursive: true, force: true });
  }
}

test("backup rejects an existing directory without changing its business sentinel", () => sandbox(async root => {
  const output = path.join(root, "preserved");
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, "sentinel.txt"), "original");
  await assert.rejects(resolveWorkspacePath(root, output, { fresh: true }), { code: "backup_output_exists" });
  assert.equal(await fs.readFile(path.join(output, "sentinel.txt"), "utf8"), "original");
}));

test("backup rejects parent traversal and the workspace root", () => sandbox(async root => {
  assert.equal(await resolveWorkspacePath(root + path.sep, "fresh", { fresh: true }), path.join(root, "fresh"));
  await assert.rejects(resolveWorkspacePath(root, "../outside"), { code: "backup_path_outside_workspace" });
  await assert.rejects(resolveWorkspacePath(root, root), { code: "backup_path_outside_workspace" });
}));

test("backup rejects a linked ancestor before creating any output", () => sandbox(async root => {
  const target = path.join(root, "actual"), link = path.join(root, "linked");
  await fs.mkdir(target);
  await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(resolveWorkspacePath(root, path.join(link, "backup"), { fresh: true }), { code: "backup_linked_path" });
  await assert.rejects(fs.stat(path.join(target, "backup")), { code: "ENOENT" });
}));

test("restore resource names cannot target normal data or inject database commands", () => {
  for (const [database, bucket] of [
    ["yummyai", "yummyai-restore-verify-test"],
    ["yummyai_restore_verify_test", "normal-assets"],
    ["yummyai_restore_verify_test';drop database yummyai;--", "yummyai-restore-verify-test"],
    ["yummyai_restore_verify_test", "yummyai-restore-verify-test/../normal"],
  ]) assert.throws(() => assertVerificationNames(database, bucket, "yummyai", "normal-assets"), { code: "unsafe_verification_resources" });
  assert.doesNotThrow(() => assertVerificationNames("yummyai_restore_verify_test", "yummyai-restore-verify-test", "yummyai", "normal-assets"));
});
