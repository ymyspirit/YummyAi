import { defineConfig } from "vitest/config";
import { requireAgentDependencyPlanEnvironment } from "../../tools/testing/require-agent-dependency-plan-environment.mjs";

const target = process.env.E2E_LEGACY_SCHEMA_TARGET === "pre-0184" ? "pre-0184" : "current";
requireAgentDependencyPlanEnvironment(process.env, target);
export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: [target === "current" ? "src/ai/agent-dependency-plan.integration.test.ts" : "src/ai/agent-dependency-plan-upgrade.integration.test.ts"],
    maxWorkers: 1, fileParallelism: false, testTimeout: 180_000, hookTimeout: 180_000 },
});
