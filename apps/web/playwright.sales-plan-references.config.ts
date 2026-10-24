import { defineConfig } from "@playwright/test";
import personal from "./playwright.product-access.config";
export default defineConfig({
  ...personal,
  testMatch: "sales-plan-references.spec.ts",
  outputDir: "../../tmp/sales-plan-references-e2e",
});
