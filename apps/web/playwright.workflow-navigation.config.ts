import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import base from "./playwright.config";

// Owns synthetic records through authenticated APIs. No demo marketplace data or provider calls.
process.env.E2E_REAL_PRODUCTS = "1";
const cwd = fileURLToPath(new URL(".", import.meta.url));
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({
  ...base,
  workers: 2,
  testMatch: [
    "order-rich-list.spec.ts",
    "order-review.spec.ts",
    "order-processing.spec.ts",
    "development-navigation.spec.ts",
    "listing-navigation.spec.ts",
    "product-supply-procurement.spec.ts",
    "order-centers.spec.ts",
    "product-development.spec.ts",
  ],
  outputDir: "../../tmp/workflow-navigation/test-results",
  webServer: servers.map((server) => ({
    ...server,
    cwd,
    env: {
      ...server.env,
      E2E_REAL_PRODUCTS: "1",
      DASHBOARD_DEMO_MODE: "0",
      ANALYSIS_DEMO_MODE: "0",
      PRODUCT_DEMO_MODE: "0",
      DESIGN_DEMO_MODE: "0",
      LISTING_DEMO_MODE: "0",
    },
  })),
});
