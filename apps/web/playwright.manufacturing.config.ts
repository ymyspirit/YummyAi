import { defineConfig } from "@playwright/test";
import personal from "./playwright.product-access.config";
export default defineConfig({
  ...personal,
  testMatch: "manufacturing.spec.ts",
  workers: 1,
  outputDir: process.env.YUMMYAI_TEST_CACHE_DIR
    ? `${process.env.YUMMYAI_TEST_CACHE_DIR}/manufacturing-browser`
    : "../../tmp/manufacturing-browser",
});
