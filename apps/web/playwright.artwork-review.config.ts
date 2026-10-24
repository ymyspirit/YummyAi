import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// The spec owns all order/editor transport in memory. It creates no business data
// and never calls a model. Keep actual application pages and demo flags disabled.
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({
  ...base,
  workers: 1,
  testMatch: ["order-artwork-review.spec.ts", "order-operator-workbench.spec.ts"],
  outputDir: "../../tmp/artwork-review-e2e",
  webServer: servers.map((server, index) => ({
    ...server,
    reuseExistingServer: index === 0,
    env: { ...server.env, DASHBOARD_DEMO_MODE: "0", ANALYSIS_DEMO_MODE: "0", PRODUCT_DEMO_MODE: "0", DESIGN_DEMO_MODE: "0", LISTING_DEMO_MODE: "0" },
  })),
});
