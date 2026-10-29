import { defineConfig } from "vitest/config";
import { requireOrderSummaryEnvironment } from "../../tools/testing/require-order-summary-availability-environment.mjs";

requireOrderSummaryEnvironment(process.env);
export default defineConfig({
  ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/orders/order-summary-availability.integration.test.ts", "src/orders/order-center-performance.integration.test.ts"],
    maxWorkers: 1, fileParallelism: false, testTimeout: 120_000, hookTimeout: 120_000 },
});
