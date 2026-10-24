import { defineConfig } from "vitest/config";
import { requireFulfillmentCommandEnvironment } from "../../tools/testing/require-fulfillment-command-environment.mjs";

const target = process.env.E2E_LEGACY_SCHEMA_TARGET === "pre-0185" ? "pre-0185" : "current";
requireFulfillmentCommandEnvironment(process.env, target);
export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: [target === "current" ? "src/orders/order-fulfillment-command.integration.test.ts" : "src/orders/order-fulfillment-command-upgrade.integration.test.ts"],
    maxWorkers: 1, fileParallelism: false, testTimeout: 240_000, hookTimeout: 240_000 },
});
