import { defineConfig } from "vitest/config";
import { requireAgentMcpV2Environment } from "../../tools/testing/require-agent-mcp-v2-environment.mjs";

requireAgentMcpV2Environment();
export default defineConfig({ ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/ai/agent-mcp-v2.integration.test.ts"], maxWorkers: 1, fileParallelism: false, testTimeout: 180_000, hookTimeout: 180_000 } });
