import { defineConfig } from "vitest/config";
import { requireNativeV3Environment } from "../../tools/testing/require-agent-native-v3-environment.mjs";
requireNativeV3Environment();
export default defineConfig({ ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/ai/agent-native-v3.integration.test.ts"], maxWorkers: 1, fileParallelism: false, testTimeout: 180_000, hookTimeout: 180_000 } });
