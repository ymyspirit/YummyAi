import { defineConfig } from "vitest/config";
import { requirePublicationNodePreviewEnvironment } from "../../tools/testing/publication-node-preview-environment.mjs";
requirePublicationNodePreviewEnvironment(process.env, "pre-0182");
export default defineConfig({ test: { include: ["src/marketplaces/publication-node-preview-upgrade.integration.test.ts"], environment: "node", maxWorkers: 1,
  hookTimeout: 180_000, testTimeout: 180_000, sequence: { concurrent: false } } });
