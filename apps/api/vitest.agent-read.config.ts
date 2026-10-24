import { defineConfig } from "vitest/config";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";

const database = new URL(requireDisposableIntegrationEnvironment());
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
if (!nonce || process.env.E2E_AGENT_READ_ISOLATED !== "1" ||
    process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Agent read acceptance requires its exact current nonce database and private bucket before test loading");

export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: {
    include: ["src/ai/agent-read.integration.test.ts", "src/ai/assist-request-recovery.integration.test.ts"],
    maxWorkers: 1, fileParallelism: false, testTimeout: 120_000, hookTimeout: 120_000,
  },
});
