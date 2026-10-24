import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requireMarketplaceAuthorityEnvironment } from "../../tools/testing/require-marketplace-authority-environment.mjs";
import base from "./playwright.product-access.config";

requireMarketplaceAuthorityEnvironment(process.env, "current", true);
const root = fileURLToPath(new URL("../../", import.meta.url));
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({ ...base, testMatch: "marketplace-authority.spec.ts", grep: undefined, workers: 1, fullyParallel: false, retries: 0,
  timeout: 180_000, use: { ...base.use, baseURL: "http://localhost:3130", trace: "off", video: "off", screenshot: "off" },
  webServer: servers.map(server => String(server.url).includes(":8130") ? { ...server, cwd: root,
    command: `node --import "${new URL("../api/node_modules/tsx/dist/loader.mjs", import.meta.url).href}" "${fileURLToPath(new URL("../api/src/marketplaces/marketplace-authority.test-fixture.ts", import.meta.url))}" --marketplace-authority-api`,
    env: { ...server.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: fileURLToPath(new URL("../api/tsconfig.json", import.meta.url)) },
  } : server),
  outputDir: fileURLToPath(new URL("../../tmp/marketplace-authority-20261022-d8b7a3c6/qa/browser", import.meta.url)),
});
