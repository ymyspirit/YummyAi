import { defineConfig } from "vitest/config";
import { requireStudioPaidImageLegacyEnvironment } from "../../tools/testing/studio-paid-image-environment.mjs";
import { requireStudioModelSelectionEnvironment } from "../../tools/testing/studio-model-selection-environment.mjs";

requireStudioPaidImageLegacyEnvironment();
// The old catalogue fixture consumes only the validated resource nonce, never
// its historical output lane. All output belongs to this paid-image runner.
requireStudioModelSelectionEnvironment();
export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/design/studio-model-selection.integration.test.ts", "src/design/creative-studio.integration.test.ts",
    "src/catalog/product-visuals.integration.test.ts", "src/ai/model-removal.integration.test.ts"],
    maxWorkers: 1, fileParallelism: false, testTimeout: 120_000, hookTimeout: 120_000 },
});
