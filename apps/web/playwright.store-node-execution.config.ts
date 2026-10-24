import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requireStoreNodeExecutionEnvironment } from "../../tools/testing/require-store-node-execution-environment.mjs";
import base from "./playwright.product-access.config";

requireStoreNodeExecutionEnvironment(process.env, "current", true);
const root = fileURLToPath(new URL("../../", import.meta.url)), servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({ ...base, testMatch: "store-node-execution.spec.ts", grep: undefined, workers: 1, fullyParallel: false, retries: 0, timeout: 180_000,
  use: { ...base.use, baseURL: "http://localhost:3130", trace: "off", video: "off", screenshot: "off" },
  webServer: servers.map(server => String(server.url).includes(":8130") ? { ...server, cwd: root, url: "http://127.0.0.1:8130/__store_node_execution_fixture_ready",
    command: `node --import "${new URL("../api/node_modules/tsx/dist/loader.mjs", import.meta.url).href}" "${fileURLToPath(new URL("../api/src/marketplaces/store-node-execution-browser.test-fixture.ts", import.meta.url))}" --store-node-execution-api`,
    env: { ...server.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: fileURLToPath(new URL("../api/tsconfig.json", import.meta.url)) },
  } : server), outputDir: fileURLToPath(new URL("../../tmp/store-node-execution-20261022-e6f2c8a1/qa/browser", import.meta.url)),
});
