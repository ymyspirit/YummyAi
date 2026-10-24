import { defineConfig } from "@playwright/test";
import personal from "./playwright.product-access.config";
export default defineConfig({
  ...personal,
  testMatch: "sales-plan-session.spec.ts",
  outputDir: "../../tmp/sales-plan-session-e2e",
});
