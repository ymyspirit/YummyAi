import path from "node:path";
import { defineConfig } from "@playwright/test";
import personal from "./playwright.erp-identity.config";

const database = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
const token = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
if (!process.env.YUMMYAI_TEST_CACHE_DIR || process.env.E2E_ISOLATED_DAILY !== "1"
  || process.env.E2E_ORDER_PROFIT_REVIEW_ISOLATED !== "1" || process.env.WEB_AUTH_MODE !== "personal"
  || process.env.API_BASE_URL !== "http://127.0.0.1:8130"
  || !["postgres:", "postgresql:"].includes(database.protocol) || !token
  || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${token}`)
  throw new Error("Use the disposable personal order-profit-review acceptance runner");

export default defineConfig({
  ...personal,
  // Nest-decorated fixture imports must use the API's installed TSX loader.
  build: { external: ["**/apps/api/**"] },
  testMatch: ["order-profit-review.spec.ts"],
  grep: undefined,
  workers: 1,
  timeout: 300_000,
  outputDir: path.join(process.env.YUMMYAI_TEST_CACHE_DIR, "playwright"),
  // The factory config merges process.env after the base server environment.
  // Keep the fixture-only loader out of both application processes.
  webServer: (Array.isArray(personal.webServer) ? personal.webServer : []).map(server => ({
    ...server,
    env: { ...server.env, NODE_OPTIONS: "", TSX_TSCONFIG_PATH: "" },
  })),
});
