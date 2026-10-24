import { defineConfig } from "@playwright/test";
import base from "./playwright.product-access.config";
export default defineConfig({ ...base, testMatch: "production-delivery.spec.ts", grep: /production delivery/, workers: 1,
  outputDir: process.env.YUMMYAI_TEST_CACHE_DIR ? `${process.env.YUMMYAI_TEST_CACHE_DIR}/production-delivery-browser` : "../../tmp/production-delivery-e2e" });
