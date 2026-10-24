import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// These suites own all order transport in memory; never create live business fixtures.
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({
  ...base,
  testMatch: [
    "order-workbench.spec.ts",
    "order-artwork-review.spec.ts",
    "order-rich-list.spec.ts",
    "order-review.spec.ts",
    "order-processing.spec.ts",
    "creative-studio-configuration.spec.ts",
  ],
  workers: 2,
  outputDir: "../../tmp/order-workbench-e2e",
  webServer: servers.map((server, index) => ({
    ...server,
    reuseExistingServer: index === 0,
    env: {
      ...server.env,
      DASHBOARD_DEMO_MODE: "0",
      ANALYSIS_DEMO_MODE: "0",
      PRODUCT_DEMO_MODE: "0",
      DESIGN_DEMO_MODE: "0",
      LISTING_DEMO_MODE: "0",
    },
  })),
});
