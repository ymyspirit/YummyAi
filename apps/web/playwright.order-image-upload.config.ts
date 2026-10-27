import { defineConfig } from "@playwright/test";
import personal from "./playwright.erp-identity.config";

if (process.env.E2E_ORDER_IMAGE_UPLOAD_ISOLATED !== "1")
  throw new Error("Use the isolated personal order-image-upload acceptance runner");

export default defineConfig({
  ...personal,
  testMatch: ["order-review.spec.ts", "order-image-upload-real.spec.ts"],
  grep: /whole order image upload/,
  workers: 1,
  outputDir: "../../tmp/order-image-upload-e2e",
});
