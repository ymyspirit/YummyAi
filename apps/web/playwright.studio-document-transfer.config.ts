import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requireStudioDocumentTransferEnvironment } from "../../tools/testing/require-studio-document-transfer-environment.mjs";
import { requireStudioDocumentTransferBrowserLock, studioDocumentTransferPinnedBrowserUse } from "../../tools/testing/require-studio-document-transfer-browser-lock.mjs";
import base from "./playwright.product-access.config.js";

const isolated = requireStudioDocumentTransferEnvironment(process.env, true);
const browser = requireStudioDocumentTransferBrowserLock(process.env);
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({ ...base, testMatch: "studio-document-transfer.spec.ts", grep: undefined,
  workers: 1, fullyParallel: false, retries: 0, timeout: 300_000, expect: { timeout: 25_000 },
  use: { ...studioDocumentTransferPinnedBrowserUse(browser, base.use), baseURL: "http://localhost:3130", viewport: { width: 1440, height: 960 }, trace: "off", video: "off", screenshot: "off" },
  projects: base.projects?.map(project => ({ ...project, use: { ...studioDocumentTransferPinnedBrowserUse(browser, project.use), viewport: { width: 1440, height: 960 } } })),
  webServer: servers.map(server => ({ ...server, env: { ...server.env, CANVAS_STUDIO_URL: process.env.CANVAS_STUDIO_URL!,
    CANVAS_STUDIO_PRODUCTION_ENABLED: "1", E2E_STUDIO_DOCUMENT_TRANSFER_ISOLATED: "1", E2E_STUDIO_RUNTIME_MANIFEST: process.env.E2E_STUDIO_RUNTIME_MANIFEST!,
    NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: String(server.url).includes(":8130")
      ? fileURLToPath(new URL("../api/tsconfig.json", import.meta.url)) : "" } })),
  outputDir: `${isolated.lane}/browser`, metadata: { isolatedNonce: isolated.nonce,
    scope: "studio_whole_native_document_transfer_and_exact_request_recovery", paidExecutionExercised: false, browserLock: browser.metadata },
});
