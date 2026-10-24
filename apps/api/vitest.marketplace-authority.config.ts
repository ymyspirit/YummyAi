import { defineConfig } from "vitest/config";
import { requireMarketplaceAuthorityEnvironment } from "../../tools/testing/require-marketplace-authority-environment.mjs";
requireMarketplaceAuthorityEnvironment();
export default defineConfig({ test: { include: [
  "src/marketplaces/marketplace-authority.integration.test.ts",
  "src/marketplaces/marketplace-worker-credential.integration.test.ts",
  "src/marketplaces/marketplace-authority-oauth.integration.test.ts",
  "src/marketplaces/marketplace-authorization.integration.test.ts",
  "src/marketplaces/marketplace-account.integration.test.ts",
  "src/marketplaces/marketplace-capability.integration.test.ts",
  "src/marketplaces/marketplace-publication.integration.test.ts",
], environment: "node", maxWorkers: 1,
  hookTimeout: 120_000, testTimeout: 90_000, sequence: { concurrent: false } } });
