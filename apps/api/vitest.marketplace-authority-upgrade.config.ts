import { defineConfig } from "vitest/config";
import { requireMarketplaceAuthorityEnvironment } from "../../tools/testing/require-marketplace-authority-environment.mjs";
requireMarketplaceAuthorityEnvironment(process.env, "pre-0178");
export default defineConfig({ test: { include: ["src/marketplaces/marketplace-authority-upgrade.integration.test.ts"], environment: "node", maxWorkers: 1,
  hookTimeout: 180_000, testTimeout: 180_000, sequence: { concurrent: false } } });
