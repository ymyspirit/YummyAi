import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";
import base from "./playwright.product-access.config";

const database = new URL(requireDisposableIntegrationEnvironment()), api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
if (!nonce || !["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) || api.port !== "8130" ||
    process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_AGENT_DELEGATION_ISOLATED !== "1" ||
    process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.E2E_COMPILED_WEB !== "1" ||
    process.env.WEB_AUTH_MODE !== "personal" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Agent delegation browser requires the exact compiled personal 3130/8130 nonce environment before connection");
export default defineConfig({ ...base, testMatch: "agent-delegation.spec.ts", workers: 1, fullyParallel: false, retries: 0, timeout: 180_000,
  // Credentials may appear only in the current browser memory. Never capture a
  // response body or input value in a trace, video or automatic failure image.
  use: { ...base.use, trace: "off", video: "off", screenshot: "off" },
  outputDir: fileURLToPath(new URL("../../tmp/agent-delegation-20261022-a23e7b91/frontend/browser", import.meta.url)) });
