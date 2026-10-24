import { defineConfig } from "vitest/config";
import { requireStoreNodeExecutionEnvironment } from "../../tools/testing/require-store-node-execution-environment.mjs";
requireStoreNodeExecutionEnvironment(process.env, "pre-0180");
export default defineConfig({ test: { include: ["src/marketplaces/store-node-execution-upgrade.integration.test.ts"], environment: "node", maxWorkers: 1,
  hookTimeout: 180_000, testTimeout: 180_000, sequence: { concurrent: false } } });
