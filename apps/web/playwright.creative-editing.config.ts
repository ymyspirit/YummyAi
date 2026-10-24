import { defineConfig } from "@playwright/test";
import base from "./playwright.order-daily.config";

export default defineConfig({
  ...base,
  testMatch: ["creative-project-editing.spec.ts", "research-creative.spec.ts"],
  grep: /.*/,
  workers: 1,
  outputDir: "../../tmp/creative-editing-e2e",
});
