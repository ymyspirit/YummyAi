import { defineConfig } from "@playwright/test";
import personal from "./playwright.product-access.config";
export default defineConfig({
  ...personal,
  testMatch: ["sales-package-history.spec.ts", "sales-plan-delivery.spec.ts"],
  outputDir: "../../tmp/sales-package-history-20261018/browser-default",
});
