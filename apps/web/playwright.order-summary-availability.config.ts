import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireOrderSummaryEnvironment } from "../../tools/testing/require-order-summary-availability-environment.mjs";
import base from "./playwright.product-access.config";

const isolated = requireOrderSummaryEnvironment(process.env, true);
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({
  ...base, testMatch: "order-summary-availability.spec.ts", grep: undefined,
  workers: 1, fullyParallel: false, retries: 0, timeout: 240_000, expect: { timeout: 15_000 },
  use: { ...base.use, baseURL: "http://localhost:3130", viewport: { width: 1440, height: 960 }, trace: "off", video: "off", screenshot: "off" },
  projects: base.projects?.map(project => ({ ...project, use: { ...project.use, viewport: { width: 1440, height: 960 } } })),
  webServer: servers.map(server => ({ ...server, env: { ...server.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1",
    TSX_TSCONFIG_PATH: String(server.url).includes(":8130") ? fileURLToPath(new URL("../api/tsconfig.json", import.meta.url)) : "" } })),
  outputDir: resolve(isolated.lane, "qa", "browser"),
  metadata: { isolatedNonce: isolated.nonce, scope: "compiled_personal_original_order_summary_availability" },
});
