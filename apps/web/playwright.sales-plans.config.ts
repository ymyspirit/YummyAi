import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import base from "./playwright.config";

process.env.E2E_REAL_PRODUCTS = "1";
const cwd = fileURLToPath(new URL(".", import.meta.url));
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({
  ...base,
  workers: 1,
  retries: 0,
  testMatch: "sales-plans.spec.ts",
  outputDir: "../../tmp/sales-plans/test-results",
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
