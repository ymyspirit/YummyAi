import assert from "node:assert/strict";
import test from "node:test";
import { requireStudioOriginalEnvironment } from "../testing/require-studio-original-environment.mjs";

const nonce = "a".repeat(32);
const isolated = () => ({ NODE_ENV: "test", E2E_ISOLATED_DAILY: "1", YUMMYAI_STUDIO_PERSONAL_TEST_ISOLATION: "1",
  E2E_STUDIO_ORIGINAL_ISOLATED: "1", E2E_LEGACY_SCHEMA_TARGET: "current",
  DATABASE_URL: `postgres://synthetic:synthetic@127.0.0.1:42830/order_daily_e2e_${nonce}`,
  S3_PRIVATE_BUCKET: `order-daily-e2e-${nonce}`, REDIS_URL: "redis://127.0.0.1:41111",
  E2E_DISPOSABLE_REDIS_URL: "redis://127.0.0.1:41111", E2E_DISPOSABLE_REDIS_CONTAINER: `yummyai-daily-${nonce}` });

test("original handoff family cannot borrow only the previous personal isolation flag", () => {
  for (const value of [undefined, "0"]) assert.throws(() => requireStudioOriginalEnvironment({ ...isolated(), E2E_STUDIO_ORIGINAL_ISOLATED: value }));
});
test("original handoff keeps the exact disposable guard and returns only its new owned QA lane", () => {
  const value = requireStudioOriginalEnvironment(isolated());
  assert.equal(value.nonce, nonce); assert.match(value.lane.replaceAll("\\", "/"), /\/tmp\/studio-original-20261024-c14d7a62\/qa\/?$/);
  assert.throws(() => requireStudioOriginalEnvironment({ ...isolated(), DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:42830/yummyai" }));
});
