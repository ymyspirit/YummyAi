import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { requireCreativeResponseAdoptionEnvironment } from "./creative-response-adoption-environment.mts";

const nonce = "7".repeat(32), other = "8".repeat(32);
const isolated = () => ({ NODE_ENV: "test", E2E_ISOLATED_DAILY: "1", YUMMYAI_STUDIO_PERSONAL_TEST_ISOLATION: "1",
  E2E_CREATIVE_RESPONSE_ADOPTION_ISOLATED: "1", DATABASE_POOL_SIZE: "1", E2E_LEGACY_SCHEMA_TARGET: "current",
  YUMMYAI_TEST_CACHE_DIR: fileURLToPath(new URL("../../tmp/order-daily-artifacts-" + nonce, import.meta.url)),
  DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:42830/order_daily_e2e_" + nonce,
  S3_PRIVATE_BUCKET: "order-daily-e2e-" + nonce, REDIS_URL: "redis://127.0.0.1:41111",
  E2E_DISPOSABLE_REDIS_URL: "redis://127.0.0.1:41111", E2E_DISPOSABLE_REDIS_CONTAINER: "yummyai-daily-" + nonce });

test("response adoption rejects missing explicit family or single-session admission before connecting", () => {
  for (const patch of [{ E2E_CREATIVE_RESPONSE_ADOPTION_ISOLATED: undefined }, { E2E_CREATIVE_RESPONSE_ADOPTION_ISOLATED: "0" },
    { DATABASE_POOL_SIZE: undefined }, { DATABASE_POOL_SIZE: "2" }])
    assert.throws(() => requireCreativeResponseAdoptionEnvironment({ ...isolated(), E2E_CREATIVE_RECOVERY_ISOLATED: "1", ...patch }),
      /creative_response_adoption_explicit_isolation_required/);
});

test("response adoption uses one disposable nonce and only its new owned lane", () => {
  const value = requireCreativeResponseAdoptionEnvironment(isolated());
  assert.equal(value.nonce, nonce); assert.equal(value.upgrade, false);
  assert.equal(value.lane, isolated().YUMMYAI_TEST_CACHE_DIR); assert.equal(value.schema, 192);
  for (const patch of [{ DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:42830/yummyai" },
    { DATABASE_URL: "postgres://synthetic:synthetic@external.invalid:42830/order_daily_e2e_" + nonce },
    { S3_PRIVATE_BUCKET: "order-daily-e2e-" + other }, { E2E_DISPOSABLE_REDIS_CONTAINER: "yummyai-daily-" + other },
    { REDIS_URL: "redis://127.0.0.1:6379" }, { E2E_DISPOSABLE_REDIS_URL: "redis://external.invalid:41111", REDIS_URL: "redis://external.invalid:41111" },
    { E2E_LEGACY_SCHEMA_TARGET: "189" }, { DEMO_ERP: "1" }])
    assert.throws(() => requireCreativeResponseAdoptionEnvironment({ ...isolated(), ...patch }));
});

test("response adoption upgrade admits the real 189 target without pretending it is current or a browser", () => {
  const environment = { ...isolated(), E2E_CREATIVE_RESPONSE_ADOPTION_UPGRADE_ISOLATED: "1", E2E_LEGACY_SCHEMA_TARGET: "189" };
  const value = requireCreativeResponseAdoptionEnvironment(environment);
  assert.equal(value.upgrade, true); assert.equal(value.nonce, nonce); assert.equal(environment.E2E_LEGACY_SCHEMA_TARGET, "189");
  assert.throws(() => requireCreativeResponseAdoptionEnvironment(environment, true), /creative_response_adoption_real189_upgrade_required/);
  for (const patch of [{ E2E_LEGACY_SCHEMA_TARGET: "current" }, { E2E_LEGACY_SCHEMA_TARGET: "pre-0190" },
    { YUMMYAI_STUDIO_PERSONAL_TEST_ISOLATION: "0" }, { S3_PRIVATE_BUCKET: "order-daily-e2e-" + other },
    { E2E_DISPOSABLE_REDIS_CONTAINER: "yummyai-daily-" + other }, { REDIS_URL: "redis://127.0.0.1:6379" }, { DEMO_ERP: "1" }])
    assert.throws(() => requireCreativeResponseAdoptionEnvironment({ ...environment, ...patch }));
});

test("response adoption rejects missing foreign or nested runner output without touching it", () => {
  const expected = isolated().YUMMYAI_TEST_CACHE_DIR;
  for (const output of [undefined, "tmp/order-daily-artifacts-" + nonce,
    expected.replace(nonce, other), expected + "/nested",
    fileURLToPath(new URL("../../tmp/creative-response-adoption-20261024-a71c9e42/qa", import.meta.url))])
    assert.throws(() => requireCreativeResponseAdoptionEnvironment({ ...isolated(), YUMMYAI_TEST_CACHE_DIR: output }),
      /creative_response_adoption_exact_runner_output_required/);
});

test("response adoption browser requires the compiled personal path and sealed isolated runtime", () => {
  assert.throws(() => requireCreativeResponseAdoptionEnvironment(isolated(), true));
  const environment = { ...isolated(), E2E_COMPILED_WEB: "1", WEB_AUTH_MODE: "personal", CANVAS_STUDIO_PRODUCTION_ENABLED: "1",
    ERP_FIXTURE_ACTORS: "synthetic-only", API_BASE_URL: "http://localhost:8130", CANVAS_STUDIO_URL: "http://127.0.0.1:4316/",
    E2E_STUDIO_RUNTIME_MANIFEST: "D:/synthetic-owned-lane/runtime-manifest.json" };
  assert.equal(requireCreativeResponseAdoptionEnvironment(environment, true).nonce, nonce);
  for (const patch of [{ E2E_COMPILED_WEB: "0" }, { WEB_AUTH_MODE: "local-service" }, { CANVAS_STUDIO_URL: "http://127.0.0.1:4176/" },
    { API_BASE_URL: "http://localhost:8000" }, { ERP_FIXTURE_ACTORS: "" }, { E2E_STUDIO_RUNTIME_MANIFEST: "" }])
    assert.throws(() => requireCreativeResponseAdoptionEnvironment({ ...environment, ...patch }, true));
});
