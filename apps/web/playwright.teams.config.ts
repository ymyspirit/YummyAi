import { defineConfig } from "@playwright/test";
import identity from "./playwright.erp-identity.config";
export default defineConfig({
  ...identity,
  testMatch: "teams.spec.ts",
  outputDir: "../../tmp/catalog-scope-browser",
});
