import { defineConfig } from "vitest/config";
import { requireAgentNativeLegacyEnvironment } from "../../tools/testing/agent-native-legacy-upgrade.mjs";
requireAgentNativeLegacyEnvironment(process.env,"pre-0175");
export default defineConfig({ ...(process.env.YUMMYAI_TEST_CACHE_DIR ? {cacheDir:process.env.YUMMYAI_TEST_CACHE_DIR}:{}),test:{include:["src/ai/agent-native-upgrade.integration.test.ts"],maxWorkers:1,fileParallelism:false,testTimeout:180_000,hookTimeout:180_000}});
