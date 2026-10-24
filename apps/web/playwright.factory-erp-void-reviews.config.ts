import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";
import base from "./playwright.product-access.config";

const database = new URL(requireDisposableIntegrationEnvironment());
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
if (!nonce || !["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) ||
  process.env.E2E_FACTORY_ERP_VOID_REVIEW_ISOLATED !== "1" || process.env.E2E_FACTORY_ERP_BINDING_ISOLATED !== "1" ||
  process.env.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" || process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_ISOLATED !== "1" ||
  process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" ||
  process.env.E2E_COMPILED_WEB !== "1" || process.env.WEB_AUTH_MODE !== "personal" ||
  process.env.S3_PRIVATE_BUCKET !== "order-daily-e2e-" + nonce)
  throw new Error("Current-schema compiled personal nonce factory void-review acceptance required");

export default defineConfig({
  ...base,
  testMatch: "factory-erp-void-reviews.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  outputDir: fileURLToPath(new URL("../../tmp/factory-erp-void-review-20261021-b8d4c307/frontend-browser/playwright", import.meta.url)),
});
