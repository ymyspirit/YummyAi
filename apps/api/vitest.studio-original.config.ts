import { defineConfig } from "vitest/config";
import { requireStudioOriginalEnvironment } from "../../tools/testing/require-studio-original-environment.mjs";

requireStudioOriginalEnvironment();
export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/design/studio-original.integration.test.ts"], maxWorkers: 1, fileParallelism: false,
    testTimeout: 90_000, hookTimeout: 90_000 },
});
