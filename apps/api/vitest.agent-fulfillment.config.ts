import { defineConfig } from "vitest/config";
import { requireFulfillmentEnvironment } from "../../tools/testing/require-agent-fulfillment-environment.mjs";
requireFulfillmentEnvironment();
export default defineConfig({ ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/ai/agent-fulfillment.integration.test.ts"], maxWorkers: 1, fileParallelism: false, testTimeout: 180_000, hookTimeout: 180_000 } });
