import { defineConfig } from "vitest/config";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";
const disposable = new URL(requireDisposableIntegrationEnvironment());
if (process.env.E2E_FACTORY_CAPACITY_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0159") throw new Error("Factory capacity upgrade requires its actual158 disposable runner");
if (process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${disposable.pathname.slice("/order_daily_e2e_".length)}`) throw new Error("Factory capacity upgrade requires the matching disposable private bucket");
export default defineConfig({ ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}), test: {
  include: ["src/suppliers/factory-capacity-upgrade.integration.test.ts"], testTimeout: 180_000, hookTimeout: 120_000, maxWorkers: 1,
} });
