import { defineConfig } from "@playwright/test";
import personal from "./playwright.product-access.config";
export default defineConfig({
  ...personal,
  testMatch: ["sales-editor-lifecycle.spec.ts", "sales-composition.spec.ts", "product-access.spec.ts"],
  outputDir: "../../tmp/sales-editor-lifecycle-20261019/browser-default",
});
