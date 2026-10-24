import { defineConfig } from "@playwright/test";
import personal from "./playwright.product-access.config";
export default defineConfig({
  ...personal,
  testMatch: ["sales-composition.spec.ts", "channel-mapping.spec.ts", "product-access.spec.ts"],
  outputDir: "../../tmp/sales-composition-20261018/browser-default",
});
