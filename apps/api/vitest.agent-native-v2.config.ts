import { defineConfig } from "vitest/config";
import { requireNativeV2Environment } from "../../tools/testing/require-agent-native-v2-environment.mjs";
requireNativeV2Environment();
export default defineConfig({ ...(process.env.YUMMYAI_TEST_CACHE_DIR ? {cacheDir:process.env.YUMMYAI_TEST_CACHE_DIR}:{}),
  test: {include:["src/ai/agent-native-v2.integration.test.ts"],maxWorkers:1,fileParallelism:false,testTimeout:180_000,hookTimeout:180_000} });
