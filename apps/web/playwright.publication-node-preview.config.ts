import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requirePublicationNodePreviewEnvironment } from "../../tools/testing/publication-node-preview-environment.mjs";
import base from "./playwright.product-access.config";
requirePublicationNodePreviewEnvironment(process.env, "current", true);
const root = fileURLToPath(new URL("../../", import.meta.url)), servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({ ...base, testMatch: "publication-node-preview.spec.ts", grep: undefined, workers: 1, fullyParallel: false, retries: 0, timeout: 120_000,
  use: { ...base.use, baseURL: "http://localhost:3130", trace: "off", video: "off", screenshot: "off" },
  webServer: servers.map(server => String(server.url).includes(":8130") ? { ...server, cwd: root, url: "http://127.0.0.1:8130/__publication_node_preview_fixture_ready",
    command: `node --import "${new URL("../api/node_modules/tsx/dist/loader.mjs", import.meta.url).href}" "${fileURLToPath(new URL("../api/src/marketplaces/publication-node-preview-browser.test-fixture.ts", import.meta.url))}" --publication-node-preview-api`,
    env: { ...server.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: fileURLToPath(new URL("../api/tsconfig.json", import.meta.url)) } } : server),
  outputDir: fileURLToPath(new URL("../../tmp/publication-node-preview-20261022-a6f4c2d9/qa/browser", import.meta.url)),
});
