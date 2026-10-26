import { defineConfig } from "vitest/config";
import { requireStudioPaidImageEnvironment } from "../../tools/testing/studio-paid-image-environment.mjs";

requireStudioPaidImageEnvironment();
export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/design/studio-paid-image.integration.test.ts"], maxWorkers: 1,
    fileParallelism: false, testTimeout: 120_000, hookTimeout: 120_000 },
});
