import path from "node:path";
import { defineConfig } from "@playwright/test";
import personal from "./playwright.erp-identity.config";

if (!process.env.YUMMYAI_TEST_CACHE_DIR || process.env.E2E_PROCUREMENT_PRECISION_ISOLATED !== "1")
  throw new Error("Use the disposable procurement precision acceptance runner");
export default defineConfig({ ...personal, testMatch: ["procurement-precision.spec.ts"], grep: undefined, workers: 1, timeout: 300_000,
  outputDir: path.join(process.env.YUMMYAI_TEST_CACHE_DIR, "playwright") });
