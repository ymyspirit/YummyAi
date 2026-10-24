import { defineConfig } from "vitest/config";
import { requireStoreNodeIdentityEnvironment } from "../../tools/testing/require-store-node-identity-environment.mjs";
requireStoreNodeIdentityEnvironment();
export default defineConfig({ test: { include: ["src/marketplaces/store-node-identity.integration.test.ts"], environment: "node", maxWorkers: 1,
  hookTimeout: 120_000, testTimeout: 90_000, sequence: { concurrent: false } } });
