import { defineConfig } from "@playwright/test";
import isolated from "./playwright.order-daily.config";

// Inherits the mandatory disposable database/bucket guard and actual API/Web.
export default defineConfig({
  ...isolated,
  testMatch: ["design-agent.spec.ts"],
  grep: undefined,
  outputDir: "../../tmp/design-agent-e2e",
});
