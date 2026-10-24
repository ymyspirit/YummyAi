import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";
import base from "./playwright.product-access.config";

const database = new URL(requireDisposableIntegrationEnvironment()), api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1], redis = process.env.E2E_DISPOSABLE_REDIS_URL, loopback = ["localhost", "127.0.0.1", "[::1]"];
if (!nonce || ["E2E_AGENT_NATIVE_ISOLATED", "E2E_AGENT_TOOLS_ISOLATED", "E2E_AGENT_PLAN_ISOLATED", "E2E_AGENT_LOOP_ISOLATED", "E2E_AGENT_COMMAND_ISOLATED", "E2E_AGENT_READ_ISOLATED", "E2E_ROLE_BENCHMARK_ISOLATED", "E2E_BUSINESS_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_EVALUATION_ISOLATED", "E2E_ISOLATED_DAILY"].some(key => process.env[key] !== "1") ||
  process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.E2E_COMPILED_WEB !== "1" || process.env.WEB_AUTH_MODE !== "personal" ||
  process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !loopback.includes(database.hostname) || !loopback.includes(api.hostname) || api.port !== "8130" ||
  !redis || process.env.REDIS_URL !== redis || process.env.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` ||
  !["redis:", "rediss:"].includes(new URL(redis).protocol) || !loopback.includes(new URL(redis).hostname) || !process.env.ERP_FIXTURE_ACTORS)
  throw new Error("Native Agent browser requires exact compiled personal3130/8130 isolated current nonce resources before loading tests");
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({ ...base, testMatch: "agent-native.spec.ts", grep: undefined, workers: 1, fullyParallel: false, retries: 0, timeout: 240_000,
  use: { ...base.use, baseURL: "http://localhost:3130", trace: "off", video: "off", screenshot: "off" },
  webServer: servers.map(server => ({ ...server, env: { ...server.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1",
    TSX_TSCONFIG_PATH: String(server.url).includes(":8130") ? fileURLToPath(new URL("../api/tsconfig.json", import.meta.url)) : "" } })),
  outputDir: fileURLToPath(new URL("../../tmp/agent-native-20261022-a72d5e31/qa/browser", import.meta.url)),
});
