import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";
import base from "./playwright.product-access.config";

const database = new URL(requireDisposableIntegrationEnvironment()), api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1], redis = process.env.E2E_DISPOSABLE_REDIS_URL;
if (!nonce || process.env.E2E_AGENT_ENTRY_ISOLATED !== "1" || process.env.E2E_AGENT_READ_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" ||
    process.env.E2E_COMPILED_WEB !== "1" || process.env.WEB_AUTH_MODE !== "personal" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` ||
    !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) || !["127.0.0.1", "localhost", "[::1]"].includes(api.hostname) || api.port !== "8130" ||
    !redis || process.env.REDIS_URL !== redis || process.env.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` ||
    !["redis:", "rediss:"].includes(new URL(redis).protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(redis).hostname) || !process.env.ERP_FIXTURE_ACTORS)
  throw new Error("Agent entry browser requires the exact current compiled personal nonce database, bucket, Redis and identity before connection");
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({ ...base, testMatch: "agent-entry.spec.ts", grep: undefined, workers: 1, fullyParallel: false, retries: 0, timeout: 240_000,
  use: { ...base.use, baseURL: "http://localhost:3130", trace: "off", video: "off", screenshot: "off" },
  webServer: servers.map(server => ({ ...server, env: { ...server.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1",
    TSX_TSCONFIG_PATH: String(server.url).includes(":8130") ? fileURLToPath(new URL("../api/tsconfig.json", import.meta.url)) : "" } })),
  outputDir: fileURLToPath(new URL("../../tmp/agent-entry-20261022-c4a83b17/qa/browser", import.meta.url)),
});
