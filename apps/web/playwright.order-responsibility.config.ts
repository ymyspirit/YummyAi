import { defineConfig } from "@playwright/test";
import isolated from "./playwright.order-daily.config";
const servers = Array.isArray(isolated.webServer) ? isolated.webServer : [];
export default defineConfig({
  ...isolated,
  testMatch: ["order-responsibility.spec.ts"],
  grep: undefined,
  timeout: 120000,
  expect: { timeout: 15000 },
  use: { ...isolated.use, baseURL: "http://localhost:3128", actionTimeout: 15000 },
  outputDir: "../../tmp/order-responsibility-e2e",
  webServer: servers.map((server) => ({
    ...server,
    ...(String(server.url).includes(":8000")
      ? { url: "http://127.0.0.1:8124/health" }
      : {
          command: process.env.KNOWLEDGE_BROWSER_COMMAND ?? "pnpm dev --port 3128",
          ...(process.env.KNOWLEDGE_BROWSER_CWD ? { cwd: process.env.KNOWLEDGE_BROWSER_CWD } : {}),
          url: "http://localhost:3128",
        }),
    env: { ...server.env, API_BASE_URL: "http://127.0.0.1:8124", PORT: "8124" },
  })),
});
