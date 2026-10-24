import { defineConfig } from "vitest/config";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";

const disposable = new URL(requireDisposableIntegrationEnvironment());
if (process.env.E2E_QUALITY_SCRAP_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" ||
    process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${disposable.pathname.slice("/order_daily_e2e_".length)}`)
  throw new Error("Quality scrap requires its dedicated current-schema nonce database and private bucket");

export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/orders/quality-scrap.integration.test.ts"], testTimeout: 120_000, hookTimeout: 120_000, maxWorkers: 1 },
});
