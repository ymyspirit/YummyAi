import { defineConfig } from "vitest/config";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";

const database = new URL(requireDisposableIntegrationEnvironment());
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
if (!nonce || process.env.E2E_KNOWLEDGE_BENCHMARK_ISOLATED !== "1" || process.env.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" ||
    process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0168" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Knowledge benchmark upgrade requires its exact genuine167 disposable database and private bucket before loading tests");
export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/knowledge/knowledge-benchmark-upgrade.integration.test.ts"], testTimeout: 180_000,
    hookTimeout: 180_000, maxWorkers: 1, fileParallelism: false },
});
