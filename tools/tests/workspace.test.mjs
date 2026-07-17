import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workspace exposes required scripts and package manager", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url)));
  assert.equal(pkg.packageManager, "pnpm@11.10.0");
  for (const name of ["dev", "build", "lint", "typecheck", "test", "test:integration", "test:e2e"]) {
    assert.equal(typeof pkg.scripts[name], "string", `missing script ${name}`);
  }
});
