import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requireFulfillmentCommandEnvironment } from "../../tools/testing/require-fulfillment-command-environment.mjs";
import base from "./playwright.product-access.config";

const isolated = requireFulfillmentCommandEnvironment(process.env, "current", true);
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({
  ...base, testMatch: "fulfillment-command.spec.ts", grep: undefined, workers: 1, fullyParallel: false, retries: 0, timeout: 300_000,
  expect: { timeout: 15_000 },
  use: { ...base.use, baseURL: "http://localhost:3130", viewport: { width: 1440, height: 960 }, trace: "off", video: "off", screenshot: "off" },
  projects: base.projects?.map(project => ({ ...project, use: { ...project.use, viewport: { width: 1440, height: 960 } } })),
  webServer: servers.map(server => ({ ...server, env: { ...server.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1",
    TSX_TSCONFIG_PATH: String(server.url).includes(":8130") ? fileURLToPath(new URL("../api/tsconfig.json", import.meta.url)) : "" } })),
  outputDir: fileURLToPath(new URL("../../tmp/fulfillment-recovery-20261023-c1e5a7b9/qa/browser", import.meta.url)),
  metadata: { isolatedNonce: isolated.nonce, scope: "actual_personal_original_fulfillment_recovery" },
});
