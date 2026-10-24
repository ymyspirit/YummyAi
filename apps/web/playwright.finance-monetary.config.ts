import path from "node:path";
import { defineConfig } from "@playwright/test";
import personal from "./playwright.erp-identity.config";

if (!process.env.YUMMYAI_TEST_CACHE_DIR || process.env.E2E_FINANCE_MONETARY_ISOLATED !== "1")
  throw new Error("Use the disposable finance monetary acceptance runner");
export default defineConfig({ ...personal, testMatch: ["finance-monetary.spec.ts"], grep: undefined, workers: 1, timeout: 180_000,
  outputDir: path.join(process.env.YUMMYAI_TEST_CACHE_DIR, "playwright") });
