import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requireStudioVideoDirectoryEnvironment } from "../../tools/testing/studio-video-directory-environment.mjs";
import { requireStudioDocumentTransferBrowserLock, studioDocumentTransferPinnedBrowserUse } from "../../tools/testing/require-studio-document-transfer-browser-lock.mjs";
import base from "./playwright.product-access.config.js";

const isolated = requireStudioVideoDirectoryEnvironment(process.env, true);
const browser = requireStudioDocumentTransferBrowserLock(process.env);
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({ ...base, testMatch: "studio-video-directory.spec.ts", grep: undefined,
  workers: 1, fullyParallel: false, retries: 0, timeout: 300_000, expect: { timeout: 25_000 },
  use: { ...studioDocumentTransferPinnedBrowserUse(browser, base.use), baseURL: "http://localhost:3130",
    viewport: { width: 1440, height: 960 }, trace: "off", video: "off", screenshot: "off" },
  projects: base.projects?.map(project => ({ ...project, use: { ...studioDocumentTransferPinnedBrowserUse(browser, project.use), viewport: { width: 1440, height: 960 } } })),
  webServer: servers.map(server => ({ ...server, env: { ...server.env, CANVAS_STUDIO_URL: process.env.CANVAS_STUDIO_URL!,
    CANVAS_STUDIO_PRODUCTION_ENABLED: "1", E2E_STUDIO_VIDEO_DIRECTORY_ISOLATED: "1", E2E_STUDIO_RUNTIME_MANIFEST: process.env.E2E_STUDIO_RUNTIME_MANIFEST!,
    NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: String(server.url).includes(":8130")
      ? fileURLToPath(new URL("../api/tsconfig.json", import.meta.url)) : "" } })),
  outputDir: `${isolated.lane}/browser`, metadata: { isolatedNonce: isolated.nonce,
    scope: "complete_native_video_inventory_explicit_open_without_task_resume", paidExecutionExercised: false, browserLock: browser.metadata },
});
