import { defineConfig } from "@playwright/test";
import personal from "./playwright.erp-identity.config";

if (process.env.E2E_ORDER_REVIEW_GUIDANCE_ISOLATED !== "1")
  throw new Error("Use the isolated personal order-review-guidance acceptance runner");

export default defineConfig({
  ...personal,
  testMatch: ["order-review-guidance.spec.ts", "order-intake.spec.ts"],
  grep: process.argv.some(arg => arg === "--grep" || arg.startsWith("--grep="))
    ? undefined : /order review guidance/,
  workers: 1,
  outputDir: "../../tmp/order-review-guidance-e2e",
});
