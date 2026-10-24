import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";
import base from "./playwright.product-access.config";

const database = new URL(requireDisposableIntegrationEnvironment()), api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
if (!nonce || !["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) || api.port !== "8130" ||
    process.env.E2E_BUSINESS_BENCHMARK_ISOLATED !== "1" || process.env.E2E_KNOWLEDGE_BENCHMARK_ISOLATED !== "1" ||
    process.env.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" ||
    process.env.E2E_COMPILED_WEB !== "1" || process.env.WEB_AUTH_MODE !== "personal" ||
    process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Business benchmark browser requires the exact compiled personal nonce database, API and private bucket before connection");
export default defineConfig({ ...base, testMatch: "business-benchmark.spec.ts", workers: 1, fullyParallel: false, retries: 0, timeout: 180_000,
  outputDir: fileURLToPath(new URL("../../tmp/business-benchmark-20261021-c9e82d4a/qa/browser", import.meta.url)) });
