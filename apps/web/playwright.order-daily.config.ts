import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Run only against a disposable database, bucket and Redis instance; see the runbook.
const database = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
const fixtureToken = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || !fixtureToken || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${fixtureToken}`)
  throw new Error("Use the isolated order daily acceptance runner; business resources are not allowed");
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({
  ...base,
  testMatch: ["order-centers.spec.ts", "amazon-report-workspace.spec.ts", "amazon-report-unpriced.spec.ts"],
  grep: /six centers|finance and advertising|manual report UI imports/,
  workers: 1,
  outputDir: "../../tmp/order-daily-e2e",
  webServer: servers.map((server) => ({ ...server, env: {
    ...server.env, DASHBOARD_DEMO_MODE: "0", ANALYSIS_DEMO_MODE: "0",
    PRODUCT_DEMO_MODE: "0", DESIGN_DEMO_MODE: "0", LISTING_DEMO_MODE: "0",
  }})),
});
