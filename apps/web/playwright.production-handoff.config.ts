import { defineConfig } from "@playwright/test";
import personal from "./playwright.product-access.config";
export default defineConfig({
  ...personal,
  testMatch: ["production-handoff.spec.ts", "production-delivery.spec.ts", "native-production.spec.ts", "production-material.spec.ts", "production-material-reviewed.spec.ts", "inventory-classification.spec.ts"],
  workers: 1,
  outputDir: process.env.YUMMYAI_TEST_CACHE_DIR
    ? `${process.env.YUMMYAI_TEST_CACHE_DIR}/production-handoff-browser`
    : "../../tmp/production-handoff-browser",
});
