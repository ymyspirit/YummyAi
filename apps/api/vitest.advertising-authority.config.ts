import { defineConfig } from "vitest/config";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";

const disposable = new URL(requireDisposableIntegrationEnvironment());
if (process.env.E2E_ADVERTISING_AUTHORITY_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current")
  throw new Error("Advertising authority requires its dedicated current-schema disposable runner");
if (process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${disposable.pathname.slice("/order_daily_e2e_".length)}`)
  throw new Error("Advertising authority requires the matching disposable private bucket");
export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: {
    include: ["src/customer-intelligence/advertising-authority.integration.test.ts", "src/customer-intelligence/advertising.integration.test.ts", "src/customer-intelligence/customer-intelligence.integration.test.ts"],
    testTimeout: 60_000,
    maxWorkers: 1,
  },
});
