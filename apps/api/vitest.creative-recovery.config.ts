import { defineConfig } from "vitest/config";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";

requireDisposableIntegrationEnvironment();
if (process.env.E2E_CREATIVE_RECOVERY_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.DATABASE_POOL_SIZE !== "1")
  throw new Error("Creative recovery requires the dedicated disposable current-schema acceptance family");

export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/design/creative-cancellation-terminal.integration.test.ts"],
    maxWorkers: 1, fileParallelism: false, testTimeout: 120_000, hookTimeout: 120_000 },
});
