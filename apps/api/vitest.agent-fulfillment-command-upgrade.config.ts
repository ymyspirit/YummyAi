import { defineConfig } from "vitest/config";
import { requireAgentFulfillmentCommandEnvironment } from "../../tools/testing/require-agent-fulfillment-command-environment.mjs";

requireAgentFulfillmentCommandEnvironment(process.env, false, "pre-0186");
export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/ai/agent-fulfillment-command-upgrade.integration.test.ts"], maxWorkers: 1, fileParallelism: false,
    testTimeout: 300_000, hookTimeout: 180_000 },
});
