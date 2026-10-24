import { defineConfig } from "vitest/config";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";

const database = new URL(requireDisposableIntegrationEnvironment()), redis = process.env.E2E_DISPOSABLE_REDIS_URL;
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
const loopback = ["localhost", "127.0.0.1", "[::1]"];
if (!nonce || process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_AGENT_LOOP_ISOLATED !== "1" || process.env.E2E_AGENT_READ_ISOLATED !== "1" ||
  process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || !loopback.includes(database.hostname) || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` ||
  !redis || process.env.REDIS_URL !== redis || process.env.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` ||
  !["redis:", "rediss:"].includes(new URL(redis).protocol) || !loopback.includes(new URL(redis).hostname))
  throw new Error("Agent loop integration requires all isolated opt-ins and the exact current nonce database, bucket and Redis before loading tests");

export default defineConfig({ ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/ai/agent-loop.integration.test.ts"], maxWorkers: 1, fileParallelism: false, testTimeout: 120_000, hookTimeout: 120_000 },
});
