import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { requireListingSyncIntentEnvironment, listingSyncIntentIsolationFlags } from "./require-listing-sync-intent-environment.mjs";

const nonce = "0123456789abcdef0123456789abcdef";
const env = () => ({ E2E_ISOLATED_DAILY: "1", E2E_LISTING_SYNC_INTENT_ISOLATED: "1", E2E_LEGACY_SCHEMA_TARGET: "current",
  DATABASE_URL: `postgres://synthetic:synthetic@127.0.0.1:42830/order_daily_e2e_${nonce}`, S3_PRIVATE_BUCKET: `order-daily-e2e-${nonce}`,
  REDIS_URL: "redis://127.0.0.1:42831", E2E_DISPOSABLE_REDIS_URL: "redis://127.0.0.1:42831", E2E_DISPOSABLE_REDIS_CONTAINER: `yummyai-daily-${nonce}` });

test("accepts the exact current nonce and rejects each missing family opt-in without connecting", () => {
  assert.equal(requireListingSyncIntentEnvironment(env()).nonce, nonce);
  for (const flag of listingSyncIntentIsolationFlags) { const value = env(); delete value[flag]; assert.throws(() => requireListingSyncIntentEnvironment(value)); }
});

test("rejects foreign or crossed database bucket Redis and target before connection", () => {
  for (const [key, value] of [["DATABASE_URL", "postgres://synthetic@127.0.0.1/ordinary148"],
    ["DATABASE_URL", `postgres://synthetic@remote.invalid/order_daily_e2e_${nonce}`], ["S3_PRIVATE_BUCKET", "order-daily-e2e-ffffffffffffffffffffffffffffffff"],
    ["REDIS_URL", "redis://127.0.0.1:6379"], ["E2E_DISPOSABLE_REDIS_URL", "redis://remote.invalid:42831"],
    ["E2E_DISPOSABLE_REDIS_CONTAINER", "yummyai-daily-ffffffffffffffffffffffffffffffff"], ["E2E_LEGACY_SCHEMA_TARGET", "pre-0178"]])
    assert.throws(() => requireListingSyncIntentEnvironment({ ...env(), [key]: value }));
});

test("requires the exact immutable original180 root for a real pre181 upgrade", () => {
  const root = resolve(fileURLToPath(new URL("../../", import.meta.url)), "tmp/listing-sync-intent-20261022-b7d3e8f2/old180-source");
  const value = { ...env(), E2E_LEGACY_SCHEMA_TARGET: "pre-0181", E2E_LISTING_SYNC_INTENT_LEGACY_SOURCE: root };
  assert.equal(requireListingSyncIntentEnvironment(value, "pre-0181").nonce, nonce);
  for (const wrong of [undefined, resolve(root, ".."), "old180-source"])
    assert.throws(() => requireListingSyncIntentEnvironment({ ...value, E2E_LISTING_SYNC_INTENT_LEGACY_SOURCE: wrong }, "pre-0181"));
});

test("requires actual compiled personal browser members and exact loopback API", () => {
  const value = { ...env(), E2E_COMPILED_WEB: "1", WEB_AUTH_MODE: "personal", API_BASE_URL: "http://localhost:8130", ERP_FIXTURE_ACTORS: "{}" };
  assert.equal(requireListingSyncIntentEnvironment(value, "current", true).nonce, nonce);
  for (const key of ["E2E_COMPILED_WEB", "WEB_AUTH_MODE", "API_BASE_URL", "ERP_FIXTURE_ACTORS"]) {
    const copy = { ...value }; delete copy[key]; assert.throws(() => requireListingSyncIntentEnvironment(copy, "current", true));
  }
  for (const api of ["https://localhost:8130", "http://remote.invalid:8130", "http://localhost:8130/foreign", "http://localhost:8130?foreign=1"])
    assert.throws(() => requireListingSyncIntentEnvironment({ ...value, API_BASE_URL: api }, "current", true));
});
