import { defineConfig } from "@playwright/test";
import base from "./playwright.product-access.config";
export default defineConfig({ ...base, testMatch: "factory-erp-import.spec.ts", workers: 1,
  outputDir: process.env.YUMMYAI_TEST_CACHE_DIR ? `${process.env.YUMMYAI_TEST_CACHE_DIR}/factory-erp-import-browser` : "../../tmp/factory-erp-import-e2e" });
