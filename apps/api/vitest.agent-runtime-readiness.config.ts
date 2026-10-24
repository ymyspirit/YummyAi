import { defineConfig } from "vitest/config";
import { requireAgentRuntimeReadinessEnvironment } from "../../tools/testing/require-agent-runtime-readiness-environment.mjs";

requireAgentRuntimeReadinessEnvironment();

export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/ai/agent-runtime-readiness.integration.test.ts"], maxWorkers: 1, fileParallelism: false, testTimeout: 180_000, hookTimeout: 180_000 },
});
