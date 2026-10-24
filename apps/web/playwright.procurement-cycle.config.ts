import path from "node:path";
import { defineConfig } from "@playwright/test";
import personal from "./playwright.erp-identity.config";

if (!process.env.YUMMYAI_TEST_CACHE_DIR) throw new Error("Use the disposable procurement cycle acceptance runner");
export default defineConfig({ ...personal,
  testMatch: ["procurement-cycle.spec.ts", "manual-procurement.spec.ts", "product-supply-procurement.spec.ts"],
  grep: undefined, workers: 1, timeout: 180_000,
  outputDir: path.join(process.env.YUMMYAI_TEST_CACHE_DIR, "playwright") });
