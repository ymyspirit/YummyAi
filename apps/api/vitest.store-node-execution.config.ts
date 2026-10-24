import { defineConfig } from "vitest/config";
import { requireStoreNodeExecutionEnvironment } from "../../tools/testing/require-store-node-execution-environment.mjs";
requireStoreNodeExecutionEnvironment();
export default defineConfig({ test: { include: ["src/marketplaces/store-node-execution.integration.test.ts"], environment: "node", maxWorkers: 1,
  hookTimeout: 120_000, testTimeout: 120_000, sequence: { concurrent: false } } });
