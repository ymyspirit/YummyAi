import path from "node:path";
import { defineConfig } from "@playwright/test";
import personal from "./playwright.erp-identity.config";

const database = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
if (!process.env.YUMMYAI_TEST_CACHE_DIR || process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FINANCE_COST_ALLOCATION_ISOLATED !== "1"
  || !["postgres:", "postgresql:"].includes(database.protocol) || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(database.pathname))
  throw new Error("Use the disposable personal cost allocation acceptance runner");
export default defineConfig({ ...personal, testMatch: ["finance-cost-allocation.spec.ts"], grep: undefined, workers: 1, timeout: 240_000,
  outputDir: path.join(process.env.YUMMYAI_TEST_CACHE_DIR, "playwright") });
