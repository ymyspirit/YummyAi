import { defineConfig } from "vitest/config";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";

const disposable = new URL(requireDisposableIntegrationEnvironment());
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(disposable.pathname)?.[1];
if (!nonce || process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_ISOLATED !== "1" || process.env.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" ||
    process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0164" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Factory ERP source retention upgrade requires the genuine163 prefix and exact disposable private bucket before loading tests");

export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/orders/factory-erp-source-retention-upgrade.integration.test.ts"], testTimeout: 180_000,
    hookTimeout: 120_000, maxWorkers: 1, fileParallelism: false },
});
