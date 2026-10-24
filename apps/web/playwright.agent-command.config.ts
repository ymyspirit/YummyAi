import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";
import base from "./playwright.product-access.config";

const url = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
const api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid"), local = ["localhost", "127.0.0.1", "[::1]"];
if (!nonce || process.env.E2E_AGENT_COMMAND_ISOLATED !== "1" || process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_COMPILED_WEB !== "1" ||
  process.env.WEB_AUTH_MODE !== "personal" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || !local.includes(url.hostname) || !local.includes(api.hostname) ||
  api.port !== "8130" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !process.env.ERP_FIXTURE_ACTORS)
  throw new Error("Agent commands require compiled personal3130/8130 and exact isolated current nonce resources before loading browser tests");
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({ ...base, testMatch: "agent-command.spec.ts", grep: undefined, workers: 1, fullyParallel: false, retries: 0, timeout: 180_000,
  use: { ...base.use, baseURL: "http://localhost:3130", trace: "off", video: "off", screenshot: "off" },
  webServer: servers.map(server => ({ ...server, env: { ...server.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1",
    TSX_TSCONFIG_PATH: String(server.url).includes(":8130") ? fileURLToPath(new URL("../api/tsconfig.json", import.meta.url)) : "" } })),
  outputDir: fileURLToPath(new URL("../../tmp/agent-command-20261022-6f2d9a84/qa/browser", import.meta.url)) });
