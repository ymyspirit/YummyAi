import { defineConfig } from "@playwright/test";
import personal from "./playwright.product-access.config";
export default defineConfig({
  ...personal,
  testMatch: ["quality-assessment.spec.ts", "quality-groups.spec.ts", "whole-order.spec.ts", "order-profit-review.spec.ts", "order-centers.spec.ts"],
  workers: 1,
  outputDir: "../../tmp/quality-assessment-e2e",
});
