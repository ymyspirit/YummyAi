import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, URL } from "node:url";
import { resolve } from "node:path";
import { marketplaceAuthorityIsolationFlags, requireMarketplaceAuthorityEnvironment } from "./require-marketplace-authority-environment.mjs";
const nonce = "0123456789abcdef0123456789abcdef";
const env = () => ({ E2E_ISOLATED_DAILY: "1", E2E_MARKETPLACE_AUTHORITY_ISOLATED: "1", E2E_LEGACY_SCHEMA_TARGET: "current",
  DATABASE_URL: `postgres://synthetic:synthetic@127.0.0.1:42830/order_daily_e2e_${nonce}`, S3_PRIVATE_BUCKET: `order-daily-e2e-${nonce}`,
  REDIS_URL: "redis://127.0.0.1:42831", E2E_DISPOSABLE_REDIS_URL: "redis://127.0.0.1:42831", E2E_DISPOSABLE_REDIS_CONTAINER: `yummyai-daily-${nonce}` });
test("accepts only the exact disposable current authority resources without connecting", () => {
  assert.equal(requireMarketplaceAuthorityEnvironment(env()).nonce, nonce);
  for (const flag of marketplaceAuthorityIsolationFlags) { const value = env(); delete value[flag]; assert.throws(() => requireMarketplaceAuthorityEnvironment(value)); }
});
test("rejects foreign database bucket Redis and schema before connection", () => {
  for (const [key, value] of [["DATABASE_URL", "postgres://synthetic@127.0.0.1/production"], ["DATABASE_URL", `postgres://synthetic@remote.invalid/order_daily_e2e_${nonce}`],
    ["S3_PRIVATE_BUCKET", "shared"], ["REDIS_URL", "redis://127.0.0.1:6379"], ["E2E_DISPOSABLE_REDIS_CONTAINER", "shared"], ["E2E_LEGACY_SCHEMA_TARGET", "pre-0177"]])
    assert.throws(() => requireMarketplaceAuthorityEnvironment({ ...env(), [key]: value }));
});
test("requires the exact immutable original177 path for pre178", () => {
  const root = resolve(fileURLToPath(new URL("../../", import.meta.url)), "tmp/marketplace-authority-20261022-d8b7a3c6/old177-source");
  const value = { ...env(), E2E_LEGACY_SCHEMA_TARGET: "pre-0178", E2E_MARKETPLACE_AUTHORITY_LEGACY_SOURCE: root };
  assert.equal(requireMarketplaceAuthorityEnvironment(value, "pre-0178").nonce, nonce);
  assert.throws(() => requireMarketplaceAuthorityEnvironment({ ...value, E2E_MARKETPLACE_AUTHORITY_LEGACY_SOURCE: resolve(root, "..") }, "pre-0178"));
});
test("requires actual compiled personal browser identity", () => {
  const value = { ...env(), E2E_COMPILED_WEB: "1", WEB_AUTH_MODE: "personal", API_BASE_URL: "http://localhost:8130", ERP_FIXTURE_ACTORS: "{}" };
  assert.equal(requireMarketplaceAuthorityEnvironment(value, "current", true).nonce, nonce);
  for (const key of ["E2E_COMPILED_WEB", "WEB_AUTH_MODE", "API_BASE_URL", "ERP_FIXTURE_ACTORS"]) { const copy = { ...value }; delete copy[key];
    assert.throws(() => requireMarketplaceAuthorityEnvironment(copy, "current", true)); }
});
