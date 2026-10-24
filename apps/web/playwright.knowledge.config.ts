import { defineConfig } from "@playwright/test";
import isolated from "./playwright.order-daily.config";
const servers = Array.isArray(isolated.webServer) ? isolated.webServer : [];
export default defineConfig({
  ...isolated,
  testMatch: ["knowledge.spec.ts"],
  grep: undefined,
  use: { ...isolated.use, baseURL: "http://localhost:3122", actionTimeout: 15_000 },
  outputDir: "../../tmp/knowledge-e2e",
  webServer: servers.map((server) => ({
    ...server,
    ...(String(server.url).includes(":8000")
      ? { url: "http://127.0.0.1:8112/health" }
      : {
          command: process.env.KNOWLEDGE_BROWSER_COMMAND ?? "pnpm dev --port 3122",
          ...(process.env.KNOWLEDGE_BROWSER_CWD ? { cwd: process.env.KNOWLEDGE_BROWSER_CWD } : {}),
          url: "http://localhost:3122",
        }),
    env: { ...server.env, API_BASE_URL: "http://127.0.0.1:8112", PORT: "8112" },
  })),
});
