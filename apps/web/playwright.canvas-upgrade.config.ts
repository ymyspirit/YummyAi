import { defineConfig } from "@playwright/test";
import base from "./playwright.order-daily.config";

export default defineConfig({
  ...base,
  testMatch: ["creative-studio.spec.ts", "creative-studio-configuration.spec.ts", "canvas-upgrade.spec.ts"],
  grep: /.*/,
  workers: 1,
  outputDir: "../../tmp/canvas-upgrade-e2e",
});
