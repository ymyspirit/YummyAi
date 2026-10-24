import { defineConfig } from "vitest/config";
import { requireStudioModelSelectionEnvironment } from "../../tools/testing/studio-model-selection-environment.mjs";

requireStudioModelSelectionEnvironment();
export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/design/studio-model-selection.integration.test.ts"], maxWorkers: 1, fileParallelism: false,
    testTimeout: 120_000, hookTimeout: 120_000 },
});
