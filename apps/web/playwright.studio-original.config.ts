import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requireStudioOriginalEnvironment } from "../../tools/testing/require-studio-original-environment.mjs";
import base from "./playwright.product-access.config.js";

const isolated = requireStudioOriginalEnvironment(process.env, true);
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({ ...base, testMatch: "studio-original.spec.ts", grep: undefined,
  workers: 1, fullyParallel: false, retries: 0, timeout: 240_000, expect: { timeout: 25_000 },
  use: { ...base.use, baseURL: "http://localhost:3130", viewport: { width: 1440, height: 960 }, trace: "off", video: "off", screenshot: "off" },
  projects: base.projects?.map(project => ({ ...project, use: { ...project.use, viewport: { width: 1440, height: 960 } } })),
  webServer: servers.map(server => ({ ...server, env: { ...server.env, CANVAS_STUDIO_URL: process.env.CANVAS_STUDIO_URL!,
    CANVAS_STUDIO_PRODUCTION_ENABLED: "1", E2E_STUDIO_ORIGINAL_ISOLATED: "1", E2E_STUDIO_RUNTIME_MANIFEST: process.env.E2E_STUDIO_RUNTIME_MANIFEST!,
    NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: String(server.url).includes(":8130")
      ? fileURLToPath(new URL("../api/tsconfig.json", import.meta.url)) : "" } })),
  outputDir: `${isolated.lane}/browser`, metadata: { isolatedNonce: isolated.nonce,
    scope: "studio_original_media_pinned_result_and_canvas_lifecycle", paidExecutionExercised: false },
});
