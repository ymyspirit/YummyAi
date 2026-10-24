import { defineConfig } from "@playwright/test";
import base from "./playwright.order-daily.config";

export default defineConfig({
  ...base,
  testMatch: ["responsive-pages.spec.ts"],
  grep: /.*/,
  workers: 1,
  outputDir: "../../tmp/responsive-e2e",
});
