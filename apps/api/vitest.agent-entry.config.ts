import { defineConfig } from "vitest/config";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";

const database = new URL(requireDisposableIntegrationEnvironment());
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
const redis = process.env.E2E_DISPOSABLE_REDIS_URL;
if (!nonce || process.env.E2E_AGENT_ENTRY_ISOLATED !== "1" || process.env.E2E_AGENT_READ_ISOLATED !== "1" ||
    process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` ||
    !redis || process.env.REDIS_URL !== redis || process.env.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` ||
    !["redis:", "rediss:"].includes(new URL(redis).protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(redis).hostname))
  throw new Error("Agent entry acceptance requires all opt-ins and its exact current nonce database, bucket and Redis before test loading");

export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/ai/assist-target-page.integration.test.ts"], maxWorkers: 1, fileParallelism: false,
    testTimeout: 120_000, hookTimeout: 120_000 },
});
