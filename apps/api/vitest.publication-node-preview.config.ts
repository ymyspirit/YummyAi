import { defineConfig } from "vitest/config";
import { requirePublicationNodePreviewEnvironment } from "../../tools/testing/publication-node-preview-environment.mjs";
requirePublicationNodePreviewEnvironment();
export default defineConfig({ test: { include: ["src/marketplaces/publication-node-preview.integration.test.ts",
  "src/marketplaces/marketplace-publication.integration.test.ts", "src/marketplaces/marketplace-publication-batch.integration.test.ts"], environment: "node", maxWorkers: 1,
  hookTimeout: 120_000, testTimeout: 180_000, sequence: { concurrent: false } } });
