import { defineConfig } from "vitest/config";
import { requireStudioVideoDirectoryEnvironment } from "../../tools/testing/studio-video-directory-environment.mjs";

requireStudioVideoDirectoryEnvironment();
export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/design/studio-video-directory.integration.test.ts"], maxWorkers: 1, fileParallelism: false,
    testTimeout: 120_000, hookTimeout: 120_000 },
});
