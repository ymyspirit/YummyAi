import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { resolveUpgradeSourceRoot } from "../scripts/upgrade-source-root.mjs";

async function sandbox(run) {
  const base = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(base, "yummyai-upgrade-source-"));
  try { await run(root); }
  finally { const actual = await fs.realpath(root); assert.equal(path.dirname(actual).toLowerCase(), base.toLowerCase()); assert.match(path.basename(actual), /^yummyai-upgrade-source-/); await fs.rm(actual, { recursive: true, force: true }); }
}
test("legacy upgrade source remains its original operational root", () => sandbox(async root => {
  assert.equal(await resolveUpgradeSourceRoot({ root, executingSourceRoot: root }), root);
}));
test("split source is a regular contained executing snapshot while backups stay outside it", () => sandbox(async root => {
  const source = path.join(root, ".artifacts", "ordinary-api-source-fixture"), backups = path.join(root, ".artifacts", "backups");
  await fs.mkdir(source, { recursive: true }); await fs.mkdir(backups);
  await fs.writeFile(path.join(backups, "business-sentinel"), "preserve");
  assert.equal(await resolveUpgradeSourceRoot({ root, sourceRoot: path.relative(root, source), executingSourceRoot: source }), source);
  assert.equal(await fs.readFile(path.join(backups, "business-sentinel"), "utf8"), "preserve");
}));
test("explicit source cannot escape the operational workspace or claim another executing tree", () => sandbox(async root => {
  const source = path.join(root, "source"); await fs.mkdir(source);
  await assert.rejects(resolveUpgradeSourceRoot({ root, sourceRoot: "../other-source", executingSourceRoot: source }), { code: "backup_path_outside_workspace" });
  await assert.rejects(resolveUpgradeSourceRoot({ root, sourceRoot: source, executingSourceRoot: root }), { code: "upgrade_executing_source_mismatch" });
}));
test("a file or source junction never counts as the executing snapshot", () => sandbox(async root => {
  const source = path.join(root, "source"), link = path.join(root, "linked-source"), file = path.join(root, "source-file");
  await fs.mkdir(source); await fs.writeFile(file, "fixture");
  await fs.symlink(source, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(resolveUpgradeSourceRoot({ root, sourceRoot: link, executingSourceRoot: link }));
  await assert.rejects(resolveUpgradeSourceRoot({ root, sourceRoot: file, executingSourceRoot: file }), { code: "upgrade_source_not_regular_directory" });
}));
