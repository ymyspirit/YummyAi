import { defineConfig } from "vitest/config";
import { requireAgentNativeV4Environment } from "../../tools/testing/require-agent-native-v4-environment.mjs";

requireAgentNativeV4Environment(process.env, "pre-0187");
export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/ai/agent-native-v4-upgrade.integration.test.ts"], maxWorkers: 1, fileParallelism: false,
    testTimeout: 420_000, hookTimeout: 60_000 },
});
