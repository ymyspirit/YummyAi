import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { requireStoreNodeExecutionEnvironment, storeNodeExecutionIsolationFlags } from "./require-store-node-execution-environment.mjs";

const nonce = "0123456789abcdef0123456789abcdef";
const env = () => ({ E2E_ISOLATED_DAILY: "1", E2E_STORE_NODE_EXECUTION_ISOLATED: "1", E2E_LEGACY_SCHEMA_TARGET: "current",
  DATABASE_URL: `postgres://synthetic:synthetic@127.0.0.1:42830/order_daily_e2e_${nonce}`, S3_PRIVATE_BUCKET: `order-daily-e2e-${nonce}`,
  REDIS_URL: "redis://127.0.0.1:42831", E2E_DISPOSABLE_REDIS_URL: "redis://127.0.0.1:42831", E2E_DISPOSABLE_REDIS_CONTAINER: `yummyai-daily-${nonce}` });

test("accepts the exact current nonce and rejects each missing family opt-in without connecting", () => {
  assert.equal(requireStoreNodeExecutionEnvironment(env()).nonce, nonce);
  for (const flag of storeNodeExecutionIsolationFlags) { const value = env(); delete value[flag]; assert.throws(() => requireStoreNodeExecutionEnvironment(value)); }
});

test("rejects foreign or crossed database bucket Redis and target before connection", () => {
  for (const [key, value] of [["DATABASE_URL", "postgres://synthetic@127.0.0.1/ordinary148"],
    ["DATABASE_URL", `postgres://synthetic@remote.invalid/order_daily_e2e_${nonce}`], ["S3_PRIVATE_BUCKET", "order-daily-e2e-ffffffffffffffffffffffffffffffff"],
    ["REDIS_URL", "redis://127.0.0.1:6379"], ["E2E_DISPOSABLE_REDIS_URL", "redis://remote.invalid:42831"],
    ["E2E_DISPOSABLE_REDIS_CONTAINER", "yummyai-daily-ffffffffffffffffffffffffffffffff"], ["E2E_LEGACY_SCHEMA_TARGET", "pre-0178"]])
    assert.throws(() => requireStoreNodeExecutionEnvironment({ ...env(), [key]: value }));
});

test("requires the exact immutable original179 root for a real pre180 upgrade", () => {
  const root = resolve(fileURLToPath(new URL("../../", import.meta.url)), "tmp/store-node-execution-20261022-e6f2c8a1/old179-source");
  const value = { ...env(), E2E_LEGACY_SCHEMA_TARGET: "pre-0180", E2E_STORE_NODE_EXECUTION_LEGACY_SOURCE: root };
  assert.equal(requireStoreNodeExecutionEnvironment(value, "pre-0180").nonce, nonce);
  for (const wrong of [undefined, resolve(root, ".."), "old179-source"])
    assert.throws(() => requireStoreNodeExecutionEnvironment({ ...value, E2E_STORE_NODE_EXECUTION_LEGACY_SOURCE: wrong }, "pre-0180"));
});

test("requires actual compiled personal browser members and exact loopback API", () => {
  const value = { ...env(), E2E_COMPILED_WEB: "1", WEB_AUTH_MODE: "personal", API_BASE_URL: "http://localhost:8130", ERP_FIXTURE_ACTORS: "{}" };
  assert.equal(requireStoreNodeExecutionEnvironment(value, "current", true).nonce, nonce);
  for (const key of ["E2E_COMPILED_WEB", "WEB_AUTH_MODE", "API_BASE_URL", "ERP_FIXTURE_ACTORS"]) {
    const copy = { ...value }; delete copy[key]; assert.throws(() => requireStoreNodeExecutionEnvironment(copy, "current", true));
  }
  for (const api of ["https://localhost:8130", "http://remote.invalid:8130", "http://localhost:8130/foreign", "http://localhost:8130?foreign=1"])
    assert.throws(() => requireStoreNodeExecutionEnvironment({ ...value, API_BASE_URL: api }, "current", true));
});
