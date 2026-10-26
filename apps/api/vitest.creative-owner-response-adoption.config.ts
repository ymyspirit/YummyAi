import { defineConfig } from "vitest/config";
import { requireCreativeOwnerResponseAdoptionEnvironment } from "../../tools/testing/creative-owner-response-adoption-environment.mjs";

requireCreativeOwnerResponseAdoptionEnvironment();
export default defineConfig({ cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR,
  test: { include: ["src/design/creative-owner-response-adoption.integration.test.ts",
    "src/design/creative-owner-response-adoption-boundaries.integration.test.ts",
    "src/design/creative-owner-response-adoption-retention.integration.test.ts"], maxWorkers: 1, fileParallelism: false,
    testTimeout: 120_000, hookTimeout: 120_000 } });
