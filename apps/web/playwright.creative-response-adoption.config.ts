import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requireCreativeResponseAdoptionEnvironment } from "../../tools/testing/creative-response-adoption-environment.mjs";
import { requireP2BrowserLock as requireStudioDocumentTransferBrowserLock, p2PinnedBrowserUse as studioDocumentTransferPinnedBrowserUse } from "../../tools/testing/require-p2-browser-lock.mjs";
import base from "./playwright.product-access.config.js";

const isolated = requireCreativeResponseAdoptionEnvironment(process.env, true);
const browser = requireStudioDocumentTransferBrowserLock(process.env);
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({ ...base, testMatch: "creative-response-adoption.spec.ts", grep: undefined,
  workers: 1, fullyParallel: false, retries: 0, timeout: 300_000, expect: { timeout: 25_000 },
  use: { ...studioDocumentTransferPinnedBrowserUse(browser, base.use), baseURL: "http://localhost:3130",
    viewport: { width: 1440, height: 960 }, trace: "off", video: "off", screenshot: "off" },
  projects: base.projects?.map(project => ({ ...project, use: { ...studioDocumentTransferPinnedBrowserUse(browser, project.use), viewport: { width: 1440, height: 960 } } })),
  webServer: servers.map(server => ({ ...server, env: { ...server.env, CANVAS_STUDIO_URL: process.env.CANVAS_STUDIO_URL!,
    CANVAS_STUDIO_PRODUCTION_ENABLED: "1", E2E_CREATIVE_RESPONSE_ADOPTION_ISOLATED: "1", E2E_STUDIO_RUNTIME_MANIFEST: process.env.E2E_STUDIO_RUNTIME_MANIFEST!,
    POD_BATCH_WORKFLOWS_ENABLED: "true", POD_ENABLED_TOOLS: "text_to_image,canvas_extend",
    POD_PROCESSOR_URL: process.env.POD_PROCESSOR_URL!, POD_PROCESSOR_API_KEY: process.env.POD_PROCESSOR_API_KEY!, POD_PROCESSOR_DEPLOYMENT_ID: process.env.POD_PROCESSOR_DEPLOYMENT_ID!,
    NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: String(server.url).includes(":8130")
      ? fileURLToPath(new URL("../api/tsconfig.json", import.meta.url)) : "" } })),
  outputDir: `${isolated.lane}/browser`, metadata: { isolatedNonce: isolated.nonce,
    scope: "original_candidate_response_adoption_and_read_only_lost_ack_recovery", paidExecutionExercised: false, browserLock: browser.metadata },
});
