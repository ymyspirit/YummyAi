import { defineConfig } from "vitest/config";
import { requireAgentNativeV3LegacyEnvironment } from "../../tools/testing/agent-native-v3-legacy-upgrade.mts";
requireAgentNativeV3LegacyEnvironment(process.env, "pre-0177");
export default defineConfig({ ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/ai/agent-native-v3-upgrade.integration.test.ts"], maxWorkers: 1, fileParallelism: false, testTimeout: 240_000, hookTimeout: 180_000 } });
