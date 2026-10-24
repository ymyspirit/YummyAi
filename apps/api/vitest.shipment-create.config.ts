import { defineConfig } from "vitest/config";
import { requireShipmentCreateEnvironment } from "../../tools/testing/require-shipment-create-environment.mjs";

requireShipmentCreateEnvironment();
export default defineConfig({ ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/ai/agent-native-v4-shipment-create.integration.test.ts"], maxWorkers: 1, fileParallelism: false,
    testTimeout: 240_000, hookTimeout: 240_000 } });
