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

test("explicit local-service development requires an API identity", () => {
  const script = fileURLToPath(new URL("../scripts/check-web-env.mjs", import.meta.url));
  const missing = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      WEB_AUTH_MODE: "local-service",
      FACTORY_PORTAL_ONLY: "0",
      NODE_ENV: "development",
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
      WEB_AUTH_MODE: "local-service",
      FACTORY_PORTAL_ONLY: "0",
      NODE_ENV: "development",
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
  for (const mode of ["up", "lite", "full"]) {
    assert.equal(pkg.scripts[`infra:${mode}`], `node tools/scripts/unified-compose.mjs infrastructure ${mode}`);
  }
  const manager = await readFile(new URL("../scripts/unified-compose.mjs", import.meta.url), "utf8");
  assert.ok(manager.includes('if (operation === "infrastructure" && args.length === 1) return infrastructure(args[0]);'));
  const infrastructure = /async function infrastructure\(mode\) \{([\s\S]*?)\n\}/.exec(manager)?.[1];
  assert.ok(infrastructure, "unified infrastructure owner is required");
  const liteServices = /\blite:\s*(\[[^\]]+\])/.exec(infrastructure)?.[1];
  assert.ok(liteServices, "lite service selection is required");
  assert.deepEqual(JSON.parse(liteServices), ["postgres", "redis", "minio", "keycloak"]);
  assert.ok(infrastructure.includes('if (await managedDeploymentExists()) return startServices(selections[mode], { startupGate: gate });'));
  assert.ok(infrastructure.includes('...(mode === "lite" ? ["-f", path.join(workspace, "infra/docker-compose.low-memory.yml")] : [])'));
  const overlay = await readFile(new URL("../../infra/docker-compose.low-memory.yml", import.meta.url), "utf8");
  assert.match(overlay, /clamav:\s+profiles:\s*\["file-scanning"\]/);
  assert.match(overlay, /otel-collector:\s+profiles:\s*\["observability"\]/);
  for (const name of ["dev:worker", "dev:extension", "dev:full", "infra:full"]) {
    assert.equal(typeof pkg.scripts[name], "string", `missing opt-in script ${name}`);
  }
});

test("personal runtime entry points start only the existing API or Web launcher", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url)));
  assert.equal(pkg.scripts["start:personal:api"], "pnpm --filter @yummyai/api start");
  assert.equal(pkg.scripts["start:personal:web"], "pnpm --filter @yummyai/web start --hostname 127.0.0.1 --port 3000");
  for (const name of ["start:personal:api", "start:personal:web", "identity:setup:local", "worker:inspect"]) {
    assert.doesNotMatch(pkg.scripts[name], /local-service|start-local|@yummyai\/worker|@yummyai\/extension/);
  }
});
