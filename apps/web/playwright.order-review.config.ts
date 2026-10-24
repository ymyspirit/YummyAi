import { defineConfig } from "@playwright/test";
import base from "./playwright.order-intake.config";
export default defineConfig({
  ...base, testMatch: [...(base.testMatch as string[]), "order-profit-review.spec.ts"],
  grep: /sales plan launch|one physical SPU|AI task workspace|controlled pillow visuals|controlled listing delivery|controlled order intake|controlled order review/,
  outputDir: "../../tmp/order-review-e2e",
});
