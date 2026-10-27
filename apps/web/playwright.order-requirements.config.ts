import { defineConfig } from "@playwright/test";
import personal from "./playwright.erp-identity.config";

if (process.env.E2E_ORDER_REQUIREMENTS_ISOLATED !== "1")
  throw new Error("Use the isolated personal order-requirements acceptance runner");

export default defineConfig({
  ...personal,
  testMatch: ["order-requirements.spec.ts"],
  workers: 1,
  outputDir: "../../tmp/order-requirements-e2e",
});
