import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requireAgentNativeV4Environment } from "../../tools/testing/require-agent-native-v4-environment.mjs";
import base from "./playwright.product-access.config";

const isolated = requireAgentNativeV4Environment(process.env, "current", true);
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({
  ...base, testMatch: "agent-native-v4.spec.ts", grep: undefined, workers: 1, fullyParallel: false, retries: 0, timeout: 300_000,
  expect: { timeout: 20_000 },
  use: { ...base.use, baseURL: "http://localhost:3130", viewport: { width: 1440, height: 960 }, trace: "off", video: "off", screenshot: "off" },
  projects: base.projects?.map(project => ({ ...project, use: { ...project.use, viewport: { width: 1440, height: 960 } } })),
  webServer: servers.map(server => ({ ...server, env: { ...server.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1",
    TSX_TSCONFIG_PATH: String(server.url).includes(":8130") ? fileURLToPath(new URL("../api/tsconfig.json", import.meta.url)) : "" } })),
  outputDir: `${isolated.lane}/browser`, metadata: { isolatedNonce: isolated.nonce, scope: "precomputed_actual_parent_personal_original_form_and_CLEAR", webPaidStartButtonExercised: false },
});
