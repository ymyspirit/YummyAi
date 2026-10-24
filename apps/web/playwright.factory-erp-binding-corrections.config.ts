import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import base from "./playwright.product-access.config";

if (process.env.E2E_FACTORY_ERP_BINDING_ISOLATED !== "1" || process.env.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" ||
  process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_ISOLATED !== "1" || process.env.E2E_ISOLATED_DAILY !== "1" ||
  process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.E2E_COMPILED_WEB !== "1" || process.env.WEB_AUTH_MODE !== "personal")
  throw new Error("Current-schema compiled disposable factory binding acceptance runner required");

export default defineConfig({
  ...base, testMatch: "factory-erp-binding-corrections.spec.ts", workers: 1, fullyParallel: false, retries: 0,
  outputDir: fileURLToPath(new URL("../../tmp/factory-erp-binding-20261021-c6b2e941/frontend-browser/playwright", import.meta.url)),
});
