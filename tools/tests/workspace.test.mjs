import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

test("workspace exposes required scripts and package manager", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url)));
  assert.equal(pkg.packageManager, "pnpm@11.10.0");
  for (const name of [
    "dev",
    "build",
    "lint",
    "typecheck",
    "test",
    "test:integration",
    "test:e2e",
  ]) {
    assert.equal(typeof pkg.scripts[name], "string", `missing script ${name}`);
  }
});

test("Web development always loads and validates the root environment", async () => {
  const root = new URL("../../", import.meta.url);
  const rootPackage = JSON.parse(await readFile(new URL("package.json", root)));
  const webPackage = JSON.parse(await readFile(new URL("apps/web/package.json", root)));

  assert.match(webPackage.scripts.predev, /check-web-env\.mjs/);
  assert.match(webPackage.scripts.predev, /--env-file-if-exists=\.\.\/\.\.\/\.env/);
  assert.match(webPackage.scripts.dev, /--env-file-if-exists=\.\.\/\.\.\/\.env/);
  assert.match(webPackage.scripts.dev, /start-web\.mjs dev/);
  assert.match(rootPackage.scripts["check:local-runtime"], /check-local-runtime\.mjs/);
});

test("Web environment preflight fails closed without an API identity", () => {
  const script = fileURLToPath(new URL("../scripts/check-web-env.mjs", import.meta.url));
  const missing = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      API_ACCESS_TOKEN: "",
      API_BASE_URL: "",
      LOCAL_OIDC_CLIENT_ID: "",
      LOCAL_OIDC_CLIENT_SECRET: "",
      OIDC_ISSUER: "",
    },
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /API_BASE_URL/);

  const valid = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      API_ACCESS_TOKEN: "test-token",
      API_BASE_URL: "http://api.test",
    },
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /preflight passed/);
});

test("low-memory development is opt-in and full development stays compatible", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url)));

  assert.doesNotMatch(pkg.scripts.dev, /--filter=/);
  assert.match(pkg.scripts["dev:lite"], /--filter=@yummyai\/api/);
  assert.match(pkg.scripts["dev:lite"], /--filter=@yummyai\/web/);
  assert.doesNotMatch(pkg.scripts["dev:lite"], /@yummyai\/worker|@yummyai\/extension/);
  assert.doesNotMatch(pkg.scripts["infra:up"], /low-memory/);
  assert.match(pkg.scripts["infra:lite"], /docker-compose\.low-memory\.yml/);
  for (const name of ["dev:worker", "dev:extension", "dev:full", "infra:full"]) {
    assert.equal(typeof pkg.scripts[name], "string", `missing opt-in script ${name}`);
  }
});
