import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { requireCreativeOwnerResponseAdoptionEnvironment } from "./creative-owner-response-adoption-environment.mts";

const nonce = "c".repeat(32);
const canonicalSchema = JSON.parse(readFileSync(new URL("../../packages/database/migrations/meta/_journal.json", import.meta.url), "utf8")).entries.length;
const isolated = () => ({ E2E_ISOLATED_DAILY: "1", YUMMYAI_STUDIO_PERSONAL_TEST_ISOLATION: "1",
  E2E_CREATIVE_OWNER_RESPONSE_ADOPTION_ISOLATED: "1", E2E_STUDIO_PAID_IMAGE_ISOLATED: "1", DATABASE_POOL_SIZE: "1",
  E2E_LEGACY_SCHEMA_TARGET: "current", DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:42830/order_daily_e2e_" + nonce,
  S3_ENDPOINT: "http://127.0.0.1:19000/", S3_PRIVATE_BUCKET: "order-daily-e2e-" + nonce,
  REDIS_URL: "redis://127.0.0.1:41111", E2E_DISPOSABLE_REDIS_URL: "redis://127.0.0.1:41111",
  E2E_DISPOSABLE_REDIS_CONTAINER: "yummyai-daily-" + nonce,
  YUMMYAI_TEST_CACHE_DIR: fileURLToPath(new URL("../../tmp/order-daily-artifacts-" + nonce, import.meta.url)) });

test("four-owner adoption requires its own admission and the original paid producer isolation", () => {
  assert.equal(requireCreativeOwnerResponseAdoptionEnvironment(isolated()).schema, canonicalSchema);
  for (const patch of [{ E2E_CREATIVE_OWNER_RESPONSE_ADOPTION_ISOLATED: "0" },
    { E2E_CREATIVE_OWNER_RESPONSE_ADOPTION_ISOLATED: undefined }, { E2E_STUDIO_PAID_IMAGE_ISOLATED: "0" },
    { DATABASE_POOL_SIZE: "2" }, { E2E_ISOLATED_DAILY: "0" }, { E2E_LEGACY_SCHEMA_TARGET: "189" }])
    assert.throws(() => requireCreativeOwnerResponseAdoptionEnvironment({ ...isolated(), ...patch }));
});

test(`four-owner adoption inherits exact canonical schema ${canonicalSchema} without a caller-selected target`, () => {
  assert.equal(requireCreativeOwnerResponseAdoptionEnvironment({ ...isolated(), E2E_EXPECTED_SCHEMA: "192", YUMMYAI_EXPECTED_MIGRATIONS: "999" }).schema, canonicalSchema);
});

test("four-owner adoption never accepts a foreign nonce ordinary database or historical output", () => {
  for (const patch of [{ DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:42830/yummyai" },
    { S3_PRIVATE_BUCKET: "order-daily-e2e-" + "d".repeat(32) },
    { E2E_DISPOSABLE_REDIS_CONTAINER: "yummyai-daily-" + "d".repeat(32) },
    { YUMMYAI_TEST_CACHE_DIR: "tmp/order-daily-artifacts-" + nonce },
    { YUMMYAI_TEST_CACHE_DIR: isolated().YUMMYAI_TEST_CACHE_DIR + "/nested" },
    { S3_ENDPOINT: "https://foreign.invalid/" }, { DEMO_ERP: "1" }])
    assert.throws(() => requireCreativeOwnerResponseAdoptionEnvironment({ ...isolated(), ...patch }));
});
