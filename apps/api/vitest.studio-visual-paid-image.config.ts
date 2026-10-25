import { defineConfig } from "vitest/config";
import { requireStudioVisualPaidImageEnvironment } from "../../tools/testing/studio-visual-paid-image-environment.mjs";

requireStudioVisualPaidImageEnvironment();
export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/design/studio-visual-paid-image.integration.test.ts"], maxWorkers: 1,
    fileParallelism: false, testTimeout: 120_000, hookTimeout: 120_000 },
});
