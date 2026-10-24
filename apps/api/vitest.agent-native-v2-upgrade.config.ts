import { defineConfig } from "vitest/config";
import { requireAgentNativeV2LegacyEnvironment } from "../../tools/testing/agent-native-v2-legacy-upgrade.mjs";
requireAgentNativeV2LegacyEnvironment(process.env, "pre-0176");
export default defineConfig({ ...(process.env.YUMMYAI_TEST_CACHE_DIR ? {cacheDir:process.env.YUMMYAI_TEST_CACHE_DIR}:{}),
  test:{include:["src/ai/agent-native-v2-upgrade.integration.test.ts"],maxWorkers:1,fileParallelism:false,testTimeout:240_000,hookTimeout:180_000} });
