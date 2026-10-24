import { defineConfig } from "vitest/config";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";

const disposable = new URL(requireDisposableIntegrationEnvironment());
if (process.env.E2E_FACTORY_QUANTITY_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0162" ||
    process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${disposable.pathname.slice("/order_daily_e2e_".length)}`)
  throw new Error("Factory quantity upgrade requires the real161 prefix and exact disposable private bucket");

export default defineConfig({ test: { include: ["src/orders/factory-quantity-upgrade.integration.test.ts"],
  testTimeout: 180_000, hookTimeout: 120_000, maxWorkers: 1 } });
