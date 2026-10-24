import { defineConfig } from "vitest/config";
import { requireAgentFulfillmentCommandEnvironment } from "../../tools/testing/require-agent-fulfillment-command-environment.mjs";

requireAgentFulfillmentCommandEnvironment(process.env);
export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/ai/agent-fulfillment-command.integration.test.ts"], maxWorkers: 1, fileParallelism: false,
    testTimeout: 240_000, hookTimeout: 240_000 },
});
