import { defineConfig } from "vitest/config";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";

const disposable = new URL(requireDisposableIntegrationEnvironment());
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(disposable.pathname)?.[1];
if (process.env.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || !nonce ||
    process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Factory ERP imports require the dedicated current-schema nonce database and private bucket before loading tests");

export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/orders/factory-erp-import.integration.test.ts"], testTimeout: 120_000, hookTimeout: 180_000, maxWorkers: 1, fileParallelism: false },
});
