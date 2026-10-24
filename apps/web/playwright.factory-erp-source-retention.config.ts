import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import base from "./playwright.product-access.config";

if (process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_ISOLATED !== "1" || process.env.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" ||
  process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_COMPILED_WEB !== "1")
  throw new Error("Compiled disposable factory source retention runner required");

export default defineConfig({
  ...base, testMatch: "factory-erp-source-retention.spec.ts", workers: 1, fullyParallel: false, retries: 0,
  outputDir: fileURLToPath(new URL("../../tmp/factory-erp-lifecycle-20261021-a9f6d812/frontend-browser-draft/playwright", import.meta.url)),
});
