import { defineConfig } from "vitest/config";
import { requireStudioPersonalEnvironment } from "../../tools/testing/require-studio-personal-environment.mjs";

requireStudioPersonalEnvironment();
export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/design/creative-studio-personal.integration.test.ts"], maxWorkers: 1, fileParallelism: false,
    testTimeout: 90_000, hookTimeout: 90_000 },
});
