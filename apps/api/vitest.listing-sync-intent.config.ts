import { defineConfig } from "vitest/config";
import { requireListingSyncIntentEnvironment } from "../../tools/testing/require-listing-sync-intent-environment.mjs";
requireListingSyncIntentEnvironment();
export default defineConfig({ test: { include: ["src/marketplaces/listing-sync-intent.integration.test.ts", "src/marketplaces/marketplace-listing-sync.integration.test.ts"], environment: "node", maxWorkers: 1,
  hookTimeout: 120_000, testTimeout: 60_000, sequence: { concurrent: false } } });
