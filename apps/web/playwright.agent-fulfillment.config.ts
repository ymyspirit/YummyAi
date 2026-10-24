import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requireFulfillmentEnvironment } from "../../tools/testing/require-agent-fulfillment-environment.mjs";
import base from "./playwright.product-access.config";
requireFulfillmentEnvironment(process.env, true);
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({ ...base, testMatch: "agent-fulfillment.spec.ts", grep: undefined, workers: 1, fullyParallel: false, retries: 0, timeout: 300_000,
  use: { ...base.use, baseURL: "http://localhost:3130", trace: "off", video: "off", screenshot: "off" },
  webServer: servers.map(server => ({ ...server, env: { ...server.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1",
    TSX_TSCONFIG_PATH: String(server.url).includes(":8130") ? fileURLToPath(new URL("../api/tsconfig.json", import.meta.url)) : "" } })),
  outputDir: fileURLToPath(new URL("../../tmp/agent-fulfillment-20261022-6e2a9c74/qa/browser", import.meta.url)),
});
