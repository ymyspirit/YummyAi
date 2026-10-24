import { defineConfig } from "@playwright/test";
import personal from "./playwright.product-access.config";
export default defineConfig({
  ...personal,
  testMatch: ["specification-facts.spec.ts", "product-development.spec.ts", "development-navigation.spec.ts", "catalog-editor.spec.ts"],
  workers: 1,
  outputDir: "../../tmp/specification-facts-e2e",
});
