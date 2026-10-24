import { defineConfig } from "@playwright/test";
import base from "./playwright.sales-delivery.config";
export default defineConfig({
  ...base,
  testMatch: [...(base.testMatch as string[]), "order-intake.spec.ts"],
  grep: /sales plan launch|one physical SPU|AI task workspace|controlled pillow visuals|controlled listing delivery|controlled order intake/,
  outputDir: "../../tmp/order-intake-e2e",
});
