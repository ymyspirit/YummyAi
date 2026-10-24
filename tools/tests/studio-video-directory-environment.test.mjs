import assert from "node:assert/strict";
import test from "node:test";
import { requireStudioVideoDirectoryEnvironment } from "../testing/studio-video-directory-environment.mts";

const nonce = "b".repeat(32);
const isolated = () => ({ NODE_ENV: "test", E2E_ISOLATED_DAILY: "1", YUMMYAI_STUDIO_PERSONAL_TEST_ISOLATION: "1",
  E2E_STUDIO_VIDEO_DIRECTORY_ISOLATED: "1", E2E_LEGACY_SCHEMA_TARGET: "current",
  DATABASE_URL: `postgres://synthetic:synthetic@127.0.0.1:42830/order_daily_e2e_${nonce}`,
  S3_PRIVATE_BUCKET: `order-daily-e2e-${nonce}`, REDIS_URL: "redis://127.0.0.1:41111",
  E2E_DISPOSABLE_REDIS_URL: "redis://127.0.0.1:41111", E2E_DISPOSABLE_REDIS_CONTAINER: `yummyai-daily-${nonce}` });

test("native inventory cannot borrow an older family's isolation flag", () => {
  for (const value of [undefined, "0"]) assert.throws(() => requireStudioVideoDirectoryEnvironment({ ...isolated(), E2E_STUDIO_VIDEO_DIRECTORY_ISOLATED: value }));
});
test("native inventory accepts only the complete disposable nonce and a new owned QA lane", () => {
  const value = requireStudioVideoDirectoryEnvironment(isolated());
  assert.equal(value.nonce, nonce); assert.match(value.lane.replaceAll("\\", "/"), /\/tmp\/studio-video-directory-20261024-b6e9a3f2\/qa\/?$/);
  for (const patch of [{ DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:42830/yummyai" },
    { S3_PRIVATE_BUCKET: `order-daily-e2e-${"a".repeat(32)}` }, { E2E_DISPOSABLE_REDIS_CONTAINER: `yummyai-daily-${"a".repeat(32)}` },
    { REDIS_URL: "redis://127.0.0.1:6379" }, { E2E_LEGACY_SCHEMA_TARGET: "pre-0188" }, { DEMO_ERP: "1" }])
    assert.throws(() => requireStudioVideoDirectoryEnvironment({ ...isolated(), ...patch }));
});
test("native inventory browser also requires compiled personal identity and its sealed isolated runtime", () => {
  assert.throws(() => requireStudioVideoDirectoryEnvironment(isolated(), true));
  const environment = { ...isolated(), E2E_COMPILED_WEB: "1", WEB_AUTH_MODE: "personal", CANVAS_STUDIO_PRODUCTION_ENABLED: "1",
    ERP_FIXTURE_ACTORS: "synthetic-only", API_BASE_URL: "http://localhost:8130", CANVAS_STUDIO_URL: "http://127.0.0.1:4316/",
    E2E_STUDIO_RUNTIME_MANIFEST: "D:/synthetic-owned-lane/runtime-manifest.json" };
  assert.equal(requireStudioVideoDirectoryEnvironment(environment, true).nonce, nonce);
  for (const patch of [{ E2E_COMPILED_WEB: "0" }, { WEB_AUTH_MODE: "local-service" }, { CANVAS_STUDIO_URL: "http://127.0.0.1:4176/" },
    { API_BASE_URL: "http://localhost:8000" }, { ERP_FIXTURE_ACTORS: "" }])
    assert.throws(() => requireStudioVideoDirectoryEnvironment({ ...environment, ...patch }, true));
});
