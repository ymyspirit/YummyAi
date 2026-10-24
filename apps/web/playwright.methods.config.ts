import { defineConfig } from "@playwright/test";
import isolated from "./playwright.order-daily.config";

const servers = Array.isArray(isolated.webServer) ? isolated.webServer : [];
export default defineConfig({
  ...isolated,
  testMatch: ["methods.spec.ts"],
  grep: undefined,
  use: { ...isolated.use, baseURL: "http://localhost:3130", actionTimeout: 15_000 },
  outputDir: "../../tmp/method-workbench-e2e",
  webServer: servers.map((server) => ({
    ...server,
    ...(String(server.url).includes(":8000")
      ? { url: "http://127.0.0.1:8128/health" }
      : {
          command: process.env.KNOWLEDGE_BROWSER_COMMAND ?? "pnpm dev --port 3130",
          ...(process.env.KNOWLEDGE_BROWSER_CWD ? { cwd: process.env.KNOWLEDGE_BROWSER_CWD } : {}),
          url: "http://localhost:3130",
        }),
    env: { ...server.env, API_BASE_URL: "http://127.0.0.1:8128", PORT: "8128" },
  })),
});
