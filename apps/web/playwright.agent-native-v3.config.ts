import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requireNativeV3Environment } from "../../tools/testing/require-agent-native-v3-environment.mjs";
import base from "./playwright.product-access.config";
requireNativeV3Environment(process.env, "current", true);
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({ ...base, testMatch: "agent-native-v3.spec.ts", grep: undefined, workers: 1, fullyParallel: false, retries: 0, timeout: 300_000,
  use: { ...base.use, baseURL: "http://localhost:3130", trace: "off", video: "off", screenshot: "off" },
  webServer: servers.map(server => ({ ...server, env: { ...server.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1",
    TSX_TSCONFIG_PATH: String(server.url).includes(":8130") ? fileURLToPath(new URL("../api/tsconfig.json", import.meta.url)) : "" } })),
  outputDir: fileURLToPath(new URL("../../tmp/agent-native-v3-20261022-3f7a21d8/qa/browser", import.meta.url)),
});
