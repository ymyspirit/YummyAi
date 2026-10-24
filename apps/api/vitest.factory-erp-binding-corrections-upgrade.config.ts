import { defineConfig } from "vitest/config";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";

const disposable = new URL(requireDisposableIntegrationEnvironment());
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(disposable.pathname)?.[1];
if (!nonce || process.env.E2E_FACTORY_ERP_BINDING_ISOLATED !== "1" || process.env.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" ||
    process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0165" ||
    process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Factory binding upgrade requires its genuine164 disposable database and private bucket before loading tests");

export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/orders/factory-erp-binding-corrections-upgrade.integration.test.ts"], testTimeout: 180_000,
    hookTimeout: 180_000, maxWorkers: 1, fileParallelism: false },
});
