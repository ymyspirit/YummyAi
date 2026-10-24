import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";
import base from "./playwright.product-access.config";

const database = new URL(requireDisposableIntegrationEnvironment()), api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
if (!nonce || !["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) || !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) || api.port !== "8130" ||
  process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_ROLE_BENCHMARK_ISOLATED !== "1" || process.env.E2E_BUSINESS_BENCHMARK_ISOLATED !== "1" ||
  process.env.E2E_KNOWLEDGE_BENCHMARK_ISOLATED !== "1" || process.env.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" ||
  process.env.E2E_COMPILED_WEB !== "1" || process.env.WEB_AUTH_MODE !== "personal" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Role benchmark browser requires the exact compiled personal 3130/8130 nonce environment before connection");
export default defineConfig({ ...base, testMatch: "role-benchmark.spec.ts", workers: 1, fullyParallel: false, retries: 0, timeout: 300_000,
  outputDir: fileURLToPath(new URL("../../tmp/role-benchmark-20261021-b84f6d29/frontend/browser", import.meta.url)) });
