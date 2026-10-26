import { defineConfig } from "vitest/config";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";

const url = new URL(requireDisposableIntegrationEnvironment());
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
if (!nonce || process.env.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" ||
    process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Knowledge evaluation execution requires its exact current disposable database and private bucket before loading tests");
export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/knowledge/knowledge-evaluation-execution.integration.test.ts", "src/knowledge/knowledge-answer-scope.integration.test.ts", "src/knowledge/knowledge-answer-account-scope.integration.test.ts"], testTimeout: 120_000,
    hookTimeout: 180_000, maxWorkers: 1, fileParallelism: false },
});
