import { defineConfig } from "vitest/config";
import { requireStoreNodeIdentityEnvironment } from "../../tools/testing/require-store-node-identity-environment.mjs";
requireStoreNodeIdentityEnvironment(process.env, "pre-0179");
export default defineConfig({ test: { include: ["src/marketplaces/store-node-identity-upgrade.integration.test.ts"], environment: "node", maxWorkers: 1,
  hookTimeout: 120_000, testTimeout: 120_000, sequence: { concurrent: false } } });
