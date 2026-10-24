import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import process from "node:process";
const run = (overrides, args = []) =>
  spawnSync(process.execPath, ["tools/scripts/check-web-env.mjs", ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      FACTORY_PORTAL_ONLY: "0",
      WEB_AUTH_MODE: "personal",
      NODE_ENV: "production",
      API_BASE_URL: "http://127.0.0.1:8000",
      OIDC_ISSUER: "http://localhost:8081/realms/yummyai",
      OIDC_AUDIENCE: "yummyai-api",
      OIDC_WEB_CLIENT_ID: "yummyai-web",
      WEB_ORIGIN: "https://erp.example",
      REDIS_URL: "redis://127.0.0.1:6379",
      ERP_SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64url"),
      FACTORY_SESSION_ENCRYPTION_KEY: "",
      ...overrides,
    },
  });
test("production rejects development service identity even when a service credential exists", () => {
  const result = run({
    WEB_AUTH_MODE: "local-service",
    API_ACCESS_TOKEN: "synthetic-secret-must-not-be-printed",
  });
  assert.equal(result.status, 1);
  assert(!result.stderr.includes("synthetic-secret-must-not-be-printed"));
});
test("a service credential cannot satisfy required personal-session settings", () => {
  const result = run({ ERP_SESSION_ENCRYPTION_KEY: "", API_ACCESS_TOKEN: "synthetic-present" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERP_SESSION_ENCRYPTION_KEY/);
});
test("independent personal settings work without a local service client secret", () => {
  const result = run({ API_ACCESS_TOKEN: "", LOCAL_OIDC_CLIENT_SECRET: "" });
  assert.equal(result.status, 0, result.stderr);
});
test("personal and factory domains reject shared session keys", () => {
  const result = run({ FACTORY_SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64url") });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must differ/);
});
test("the production prestart refuses developer identity even before Next sets NODE_ENV", () => {
  const result = run({ NODE_ENV: "development", WEB_AUTH_MODE: "local-service" }, ["--production"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /production requires personal authentication/);
});
test("the local launcher rejects both external hostname spellings before starting services", () => {
  for (const args of [["--hostname", "0.0.0.0"], ["--hostname=0.0.0.0"]]) {
    const result = spawnSync(process.execPath, ["tools/scripts/start-web.mjs", "dev", ...args], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      env: { ...process.env, FACTORY_PORTAL_ONLY: "0", WEB_AUTH_MODE: "local-service" },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /must bind to loopback/);
  }
});
test("direct production launcher cannot bypass personal-session preflight", () => {
  const result = spawnSync(process.execPath, ["tools/scripts/start-web.mjs", "start", "--candidate", "a".repeat(32)], {
    encoding: "utf8", timeout: 5000, windowsHide: true,
    env: { ...process.env, FACTORY_PORTAL_ONLY: "0", WEB_AUTH_MODE: "personal", ERP_SESSION_ENCRYPTION_KEY: "", API_BASE_URL: "http://127.0.0.1:8000" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Web production preflight failed/);
  assert.match(result.stderr, /ERP_SESSION_ENCRYPTION_KEY/);
});
test("a candidate cannot be selected by the development launcher", () => {
  const result = spawnSync(process.execPath, ["tools/scripts/start-web.mjs", "dev", "--candidate", "a".repeat(32)], {
    encoding: "utf8", timeout: 5000, windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires production start mode/);
});
