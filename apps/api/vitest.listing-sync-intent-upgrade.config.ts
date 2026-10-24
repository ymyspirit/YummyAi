import { defineConfig } from "vitest/config";
import { requireListingSyncIntentEnvironment } from "../../tools/testing/require-listing-sync-intent-environment.mjs";
requireListingSyncIntentEnvironment(process.env, "pre-0181");
export default defineConfig({ test: { include: ["src/marketplaces/listing-sync-intent-upgrade.integration.test.ts"], environment: "node", maxWorkers: 1,
  hookTimeout: 180_000, testTimeout: 180_000, sequence: { concurrent: false } } });
