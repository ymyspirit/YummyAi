import { defineConfig } from "@playwright/test";
import base from "./playwright.order-daily.config";
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({
  ...base,
  testMatch: ["advertising.spec.ts"],
  grep: /advertising workbench/,
  outputDir: "../../tmp/advertising-e2e",
  workers: 1,
  timeout: 120000,
  use: { ...base.use, actionTimeout: 15000 },
  webServer: servers.map((server, index) =>
    index === 0
      ? {
          ...server,
          url: "http://127.0.0.1:8118/health",
          env: { ...server.env, PORT: "8118", API_BASE_URL: "http://127.0.0.1:8118" },
        }
      : { ...server, env: { ...server.env, API_BASE_URL: "http://127.0.0.1:8118" } },
  ),
});
