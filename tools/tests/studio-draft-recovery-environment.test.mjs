import assert from "node:assert/strict";
import test from "node:test";
import { requireStudioDraftRecoveryEnvironment } from "../testing/studio-draft-recovery-environment.mts";

const nonce = "f".repeat(32);
const isolated = () => ({ NODE_ENV: "test", E2E_ISOLATED_DAILY: "1", YUMMYAI_STUDIO_PERSONAL_TEST_ISOLATION: "1",
  E2E_STUDIO_DRAFT_RECOVERY_ISOLATED: "1", E2E_LEGACY_SCHEMA_TARGET: "current",
  DATABASE_URL: `postgres://synthetic:synthetic@127.0.0.1:42830/order_daily_e2e_${nonce}`,
  S3_PRIVATE_BUCKET: `order-daily-e2e-${nonce}`, REDIS_URL: "redis://127.0.0.1:41111",
  E2E_DISPOSABLE_REDIS_URL: "redis://127.0.0.1:41111", E2E_DISPOSABLE_REDIS_CONTAINER: `yummyai-daily-${nonce}` });

test("draft recovery cannot borrow any prior browser family admission", () => {
  for (const flag of [undefined, "0"]) assert.throws(() => requireStudioDraftRecoveryEnvironment({ ...isolated(),
    E2E_STUDIO_DRAFT_RECOVERY_ISOLATED: flag, E2E_STUDIO_MODEL_SELECTION_ISOLATED: "1", E2E_STUDIO_DOCUMENT_TRANSFER_ISOLATED: "1" }));
});
test("draft recovery requires one exact disposable nonce and its fresh owned output lane", () => {
  const value = requireStudioDraftRecoveryEnvironment(isolated()); assert.equal(value.nonce, nonce);
  assert.match(value.lane.replaceAll("\\", "/"), /\/tmp\/studio-draft-recovery-20261024-f29c6a81\/qa\/?$/);
  for (const patch of [{ DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:42830/yummyai" },
    { S3_PRIVATE_BUCKET: `order-daily-e2e-${"a".repeat(32)}` }, { E2E_DISPOSABLE_REDIS_CONTAINER: `yummyai-daily-${"a".repeat(32)}` },
    { REDIS_URL: "redis://127.0.0.1:6379" }, { E2E_LEGACY_SCHEMA_TARGET: "pre-0188" }, { DEMO_ERP: "1" }])
    assert.throws(() => requireStudioDraftRecoveryEnvironment({ ...isolated(), ...patch }));
});
test("draft recovery browser requires the compiled personal ERP and the sealed isolated runtime", () => {
  assert.throws(() => requireStudioDraftRecoveryEnvironment(isolated(), true));
  const environment = { ...isolated(), E2E_COMPILED_WEB: "1", WEB_AUTH_MODE: "personal", CANVAS_STUDIO_PRODUCTION_ENABLED: "1",
    ERP_FIXTURE_ACTORS: "synthetic-only", API_BASE_URL: "http://localhost:8130", CANVAS_STUDIO_URL: "http://127.0.0.1:4316/",
    E2E_STUDIO_RUNTIME_MANIFEST: "D:/synthetic-owned-lane/runtime-manifest.json" };
  assert.equal(requireStudioDraftRecoveryEnvironment(environment, true).nonce, nonce);
  for (const patch of [{ E2E_COMPILED_WEB: "0" }, { WEB_AUTH_MODE: "local-service" }, { CANVAS_STUDIO_URL: "http://127.0.0.1:4176/" },
    { API_BASE_URL: "http://localhost:8000" }, { ERP_FIXTURE_ACTORS: "" }])
    assert.throws(() => requireStudioDraftRecoveryEnvironment({ ...environment, ...patch }, true));
});
