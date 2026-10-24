import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const disposable = "postgres://synthetic:synthetic@127.0.0.1:1/order_daily_e2e_" + "a".repeat(32);
function loadConfig(overrides = {}) {
  return spawnSync(process.execPath, ["--import", "./apps/api/node_modules/tsx/dist/loader.mjs", "--input-type=module", "-e",
    "await import('./apps/api/vitest.creative-recovery.config.ts');process.stdout.write('CONFIG_READY')"], {
    cwd: root, windowsHide: true, timeout: 10_000, encoding: "utf8",
    env: { ...process.env, TSX_DISABLE_CACHE: "1", DATABASE_URL: disposable,
      E2E_ISOLATED_DAILY: "1", E2E_CREATIVE_RECOVERY_ISOLATED: "1", E2E_LEGACY_SCHEMA_TARGET: "current", DATABASE_POOL_SIZE: "1", ...overrides },
  });
}
for (const [name, overrides] of [
  ["missing disposable isolation", { E2E_ISOLATED_DAILY: "" }],
  ["ordinary database", { DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:1/yummyai" }],
  ["missing dedicated family", { E2E_CREATIVE_RECOVERY_ISOLATED: "" }],
  ["historical schema", { E2E_LEGACY_SCHEMA_TARGET: "pre-0187" }],
  ["unbounded pool", { DATABASE_POOL_SIZE: "8" }],
]) test("creative recovery config rejects " + name + " before loading the test or connecting", () => {
  const result = loadConfig(overrides);
  assert.equal(result.error, undefined); assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /CONFIG_READY/);
  assert.match(result.stderr, /disposable|non-disposable|dedicated disposable current-schema/);
});
test("the dedicated current-schema config itself loads without connecting to its unreachable synthetic database", () => {
  const result = loadConfig(); assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "CONFIG_READY");
});
