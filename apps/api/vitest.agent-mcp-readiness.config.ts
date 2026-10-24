import { defineConfig } from "vitest/config";
import { requireAgentMcpReadinessEnvironment } from "../../tools/testing/require-agent-mcp-readiness-environment.mjs";

requireAgentMcpReadinessEnvironment();

export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: {
    include: ["src/ai/agent-mcp-readiness.integration.test.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
