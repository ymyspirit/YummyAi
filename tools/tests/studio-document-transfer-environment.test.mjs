import assert from "node:assert/strict";
import test from "node:test";
import { requireStudioDocumentTransferEnvironment } from "../testing/require-studio-document-transfer-environment.mjs";

const nonce = "d".repeat(32);
const isolated = () => ({ NODE_ENV: "test", E2E_ISOLATED_DAILY: "1", YUMMYAI_STUDIO_PERSONAL_TEST_ISOLATION: "1",
  E2E_STUDIO_DOCUMENT_TRANSFER_ISOLATED: "1", E2E_LEGACY_SCHEMA_TARGET: "current",
  DATABASE_URL: `postgres://synthetic:synthetic@127.0.0.1:42830/order_daily_e2e_${nonce}`,
  S3_PRIVATE_BUCKET: `order-daily-e2e-${nonce}`, REDIS_URL: "redis://127.0.0.1:41111",
  E2E_DISPOSABLE_REDIS_URL: "redis://127.0.0.1:41111", E2E_DISPOSABLE_REDIS_CONTAINER: `yummyai-daily-${nonce}` });

test("document transfer requires its own family before opening any disposable resources", () => {
  for (const flag of [undefined, "0"]) assert.throws(() => requireStudioDocumentTransferEnvironment({ ...isolated(),
    E2E_STUDIO_ORIGINAL_ISOLATED: "1", E2E_STUDIO_DOCUMENT_TRANSFER_ISOLATED: flag }));
});

test("document transfer rejects ordinary databases mixed nonces legacy schema remote hosts and demo admission", () => {
  const invalid = [
    { DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:42830/yummyai" },
    { DATABASE_URL: `postgres://synthetic:synthetic@remote.invalid:42830/order_daily_e2e_${nonce}` },
    { S3_PRIVATE_BUCKET: `order-daily-e2e-${"a".repeat(32)}` },
    { E2E_DISPOSABLE_REDIS_CONTAINER: `yummyai-daily-${"a".repeat(32)}` },
    { REDIS_URL: "redis://127.0.0.1:41112" }, { E2E_LEGACY_SCHEMA_TARGET: "pre-0188" }, { DEMO_PAID: "1" },
  ];
  for (const patch of invalid) assert.throws(() => requireStudioDocumentTransferEnvironment({ ...isolated(), ...patch }));
});

test("document transfer returns only the new owned lane and retains the exact nonce boundary", () => {
  const value = requireStudioDocumentTransferEnvironment(isolated());
  assert.equal(value.nonce, nonce); assert.equal(value.name, `order_daily_e2e_${nonce}`);
  assert.match(value.lane.replaceAll("\\", "/"), /\/tmp\/studio-transfer-20261024-d8b42e71\/qa\/?$/);
  assert.doesNotMatch(value.lane, /studio-original|studio-personal/);
});
