import { defineConfig } from "vitest/config";
import { requireCreativeResponseAdoptionEnvironment } from "../../tools/testing/creative-response-adoption-environment.mjs";

requireCreativeResponseAdoptionEnvironment();
export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/design/creative-response-adoption.integration.test.ts", "src/design/creative-response-adoption-late.integration.test.ts",
    "src/design/creative-response-adoption-boundaries.integration.test.ts"], maxWorkers: 1, fileParallelism: false,
    testTimeout: 120_000, hookTimeout: 120_000 },
});
