import { defineConfig } from "vitest/config";
import { requireStudioDocumentTransferEnvironment } from "../../tools/testing/require-studio-document-transfer-environment.mjs";

requireStudioDocumentTransferEnvironment();
export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/design/studio-document-transfer.integration.test.ts"], maxWorkers: 1, fileParallelism: false,
    testTimeout: 120_000, hookTimeout: 120_000 },
});
