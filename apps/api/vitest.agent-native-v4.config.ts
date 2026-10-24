import { defineConfig } from "vitest/config";
import { requireAgentNativeV4Environment } from "../../tools/testing/require-agent-native-v4-environment.mjs";

requireAgentNativeV4Environment();
export default defineConfig({ ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/ai/agent-native-v4.integration.test.ts"], maxWorkers: 1, fileParallelism: false,
    testTimeout: 240_000, hookTimeout: 240_000 } });
