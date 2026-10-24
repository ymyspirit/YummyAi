import { defineConfig } from "@playwright/test";
import base from "./playwright.ai-tasks.config";
process.env.E2E_REAL_PRODUCTS = "1";
export default defineConfig({
  ...base,
  testMatch: ["sales-plan-launch.spec.ts", "sales-plans.spec.ts", "ai-tasks.spec.ts", "product-visuals.spec.ts"],
  grep: /sales plan launch|one physical SPU|AI task workspace|controlled pillow visuals/,
  outputDir: "../../tmp/sales-launch-e2e",
});
