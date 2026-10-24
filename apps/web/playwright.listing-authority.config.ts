import { defineConfig } from "@playwright/test";
import personal from "./playwright.product-access.config";
export default defineConfig({
  ...personal,
  testMatch: "listing-authority.spec.ts",
  outputDir: "../../tmp/listing-authority-e2e",
});
