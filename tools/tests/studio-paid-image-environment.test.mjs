import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { requireStudioPaidImageEnvironment, requireStudioPaidImageLegacyEnvironment } from "../testing/studio-paid-image-environment.mts";

const nonce = "e".repeat(32);
const canonicalSchema = JSON.parse(readFileSync(new URL("../../packages/database/migrations/meta/_journal.json", import.meta.url), "utf8")).entries.length;
const isolated = () => ({ E2E_ISOLATED_DAILY: "1", YUMMYAI_STUDIO_PERSONAL_TEST_ISOLATION: "1",
  E2E_STUDIO_PAID_IMAGE_ISOLATED: "1", E2E_LEGACY_SCHEMA_TARGET: "current", DATABASE_POOL_SIZE: "1",
  YUMMYAI_TEST_CACHE_DIR: fileURLToPath(new URL("../../tmp/order-daily-artifacts-" + nonce, import.meta.url)),
  DATABASE_URL: `postgres://synthetic:synthetic@127.0.0.1:42830/order_daily_e2e_${nonce}`,
  S3_ENDPOINT: "http://127.0.0.1:19000/", S3_PRIVATE_BUCKET: `order-daily-e2e-${nonce}`,
  REDIS_URL: "redis://127.0.0.1:41111", E2E_DISPOSABLE_REDIS_URL: "redis://127.0.0.1:41111",
  E2E_DISPOSABLE_REDIS_CONTAINER: `yummyai-daily-${nonce}` });

test("paid image rejects mixed resources and any ordinary database before connecting", () => {
  const value = requireStudioPaidImageEnvironment(isolated());
  assert.equal(value.nonce, nonce); assert.equal(value.schema, canonicalSchema);
  assert.equal(value.lane, isolated().YUMMYAI_TEST_CACHE_DIR);
  for (const patch of [{ E2E_STUDIO_PAID_IMAGE_ISOLATED: undefined }, { DATABASE_POOL_SIZE: "2" },
    { DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:42830/yummyai" },
    { S3_PRIVATE_BUCKET: `order-daily-e2e-${"a".repeat(32)}` }, { REDIS_URL: "redis://127.0.0.1:6379" },
    { E2E_DISPOSABLE_REDIS_CONTAINER: `yummyai-daily-${"a".repeat(32)}` }, { DEMO_ERP: "1" }])
    assert.throws(() => requireStudioPaidImageEnvironment({ ...isolated(), ...patch }));
});

test(`paid image uses exact checkout schema ${canonicalSchema} rather than an environment override`, () => {
  assert.equal(requireStudioPaidImageEnvironment({ ...isolated(), E2E_EXPECTED_SCHEMA: "192", YUMMYAI_EXPECTED_MIGRATIONS: "999" }).schema, canonicalSchema);
});

test("paid image rejects missing foreign or nested runner output without touching it", () => {
  const expected = isolated().YUMMYAI_TEST_CACHE_DIR;
  for (const output of [undefined, "tmp/order-daily-artifacts-" + nonce,
    expected.replace(nonce, "a".repeat(32)), expected + "/nested",
    fileURLToPath(new URL("../../tmp/studio-paid-image-20261024-73e2c9b1/qa", import.meta.url))])
    assert.throws(() => requireStudioPaidImageEnvironment({ ...isolated(), YUMMYAI_TEST_CACHE_DIR: output }),
      /studio_paid_image_exact_runner_output_required/);
});

test("paid image permits only private loopback storage without credential or URL decorations", () => {
  for (const endpoint of [undefined, "http://storage.example/", "file:///storage/", "http://name:secret@127.0.0.1:19000/",
    "http://127.0.0.1:19000/foreign", "http://127.0.0.1:19000/?key=value", "http://127.0.0.1:19000/#other"])
    assert.throws(() => requireStudioPaidImageEnvironment({ ...isolated(), S3_ENDPOINT: endpoint }));
});

test("paid image browser requires the compiled personal API and isolated sealed runtime", () => {
  assert.throws(() => requireStudioPaidImageEnvironment(isolated(), true));
  const browser = { ...isolated(), E2E_COMPILED_WEB: "1", WEB_AUTH_MODE: "personal", CANVAS_STUDIO_PRODUCTION_ENABLED: "1",
    ERP_FIXTURE_ACTORS: "synthetic-only", API_BASE_URL: "http://localhost:8130", CANVAS_STUDIO_URL: "http://127.0.0.1:4316/",
    E2E_STUDIO_RUNTIME_MANIFEST: "D:/synthetic-owned-lane/runtime-manifest.json" };
  assert.equal(requireStudioPaidImageEnvironment(browser, true).nonce, nonce);
  for (const patch of [{ WEB_AUTH_MODE: "local-service" }, { E2E_COMPILED_WEB: "0" }, { API_BASE_URL: "http://localhost:8000" },
    { CANVAS_STUDIO_URL: "http://127.0.0.1:4176/" }, { ERP_FIXTURE_ACTORS: "" }, { E2E_STUDIO_RUNTIME_MANIFEST: "" }])
    assert.throws(() => requireStudioPaidImageEnvironment({ ...browser, ...patch }, true));
});

test("only the separate dormant legacy regression may use two isolated connections", () => {
  const legacy = { ...isolated(), DATABASE_POOL_SIZE: "2", E2E_STUDIO_PAID_IMAGE_LEGACY_ISOLATED: "1",
    STUDIO_PAID_IMAGE_ENABLED: "0", STUDIO_PAID_IMAGE_TENANT_IDS: "" };
  assert.equal(requireStudioPaidImageLegacyEnvironment(legacy).nonce, nonce);
  assert.equal(requireStudioPaidImageLegacyEnvironment({ ...legacy, E2E_EXPECTED_SCHEMA: "192", YUMMYAI_EXPECTED_MIGRATIONS: "999" }).schema, canonicalSchema);
  assert.throws(() => requireStudioPaidImageEnvironment(legacy));
  for (const patch of [{ E2E_STUDIO_PAID_IMAGE_LEGACY_ISOLATED: undefined }, { DATABASE_POOL_SIZE: "1" },
    { DATABASE_POOL_SIZE: "10" }, { STUDIO_PAID_IMAGE_ENABLED: "1" }, { STUDIO_PAID_IMAGE_TENANT_IDS: "*" },
    { DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:42830/yummyai" }])
    assert.throws(() => requireStudioPaidImageLegacyEnvironment({ ...legacy, ...patch }));
});
