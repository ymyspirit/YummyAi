import { defineConfig } from "@playwright/test";
import methods from "./playwright.methods.config";
export default defineConfig({
  ...methods,
  testMatch: ["business-methods.spec.ts"],
  outputDir: "../../tmp/business-methods-e2e",
});
