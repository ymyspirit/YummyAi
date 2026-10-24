import { defineConfig } from "@playwright/test";
import base from "./playwright.order-responsibility.config";
export default defineConfig({
  ...base,
  testMatch: ["business-followup.spec.ts"],
  outputDir: "../../tmp/business-followup-e2e",
});
