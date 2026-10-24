import { defineConfig } from "@playwright/test";
import base from "./playwright.sales-launch.config";
export default defineConfig({
  ...base,
  testMatch: [
    "sales-plan-launch.spec.ts",
    "sales-plans.spec.ts",
    "ai-tasks.spec.ts",
    "product-visuals.spec.ts",
    "sales-plan-delivery.spec.ts",
  ],
  grep: /sales plan launch|one physical SPU|AI task workspace|controlled pillow visuals|controlled listing delivery/,
  outputDir: "../../tmp/sales-delivery-e2e",
});
