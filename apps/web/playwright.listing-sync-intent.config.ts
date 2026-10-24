import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requireListingSyncIntentEnvironment } from "../../tools/testing/require-listing-sync-intent-environment.mjs";
import base from "./playwright.product-access.config";
requireListingSyncIntentEnvironment(process.env, "current", true);
const root = fileURLToPath(new URL("../../", import.meta.url)), servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({ ...base, testMatch: "listing-sync-intent.spec.ts", grep: undefined, workers: 1, fullyParallel: false, retries: 0, timeout: 120_000,
  use: { ...base.use, baseURL: "http://localhost:3130", trace: "off", video: "off", screenshot: "off" },
  webServer: servers.map(server => String(server.url).includes(":8130") ? { ...server, cwd: root, url: "http://127.0.0.1:8130/__listing_sync_intent_fixture_ready",
    command: `node --import "${new URL("../api/node_modules/tsx/dist/loader.mjs", import.meta.url).href}" "${fileURLToPath(new URL("../api/src/marketplaces/listing-sync-intent-browser.test-fixture.ts", import.meta.url))}" --listing-sync-intent-api`,
    env: { ...server.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: fileURLToPath(new URL("../api/tsconfig.json", import.meta.url)) } } : server),
  outputDir: fileURLToPath(new URL("../../tmp/listing-sync-intent-20261022-b7d3e8f2/qa/browser", import.meta.url)),
});
