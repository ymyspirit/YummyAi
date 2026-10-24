import { defineConfig } from "@playwright/test";
import base from "./playwright.order-daily.config";
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({
  ...base,
  testMatch: ["ai-tasks.spec.ts"],
  grep: /AI task workspace/,
  workers: 1,
  outputDir: "../../tmp/ai-tasks-e2e",
  webServer: servers.map((server, index) =>
    index === 0
      ? {
          ...server,
          url: "http://127.0.0.1:8116/health",
          env: { ...server.env, PORT: "8116", API_BASE_URL: "http://127.0.0.1:8116" },
        }
      : { ...server, env: { ...server.env, API_BASE_URL: "http://127.0.0.1:8116" } },
  ),
});
