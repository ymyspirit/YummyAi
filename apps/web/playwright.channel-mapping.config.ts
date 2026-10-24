import { defineConfig } from "@playwright/test";
import personal from "./playwright.product-access.config";
export default defineConfig({
  ...personal,
  testMatch: ["channel-mapping.spec.ts", "product-access.spec.ts"],
  outputDir: "../../tmp/channel-mapping-20261018/browser-default",
});
