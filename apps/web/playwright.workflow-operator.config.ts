import { defineConfig } from "@playwright/test";
import isolated from "./playwright.order-daily.config";
const servers = Array.isArray(isolated.webServer) ? isolated.webServer : [];
export default defineConfig({
  ...isolated,
  testMatch: ["workflow-operator.spec.ts", "workflow-responsibility.spec.ts", "business-task-inbox.spec.ts"],
  grep: undefined,
  timeout: 180_000,
  use: { ...isolated.use, baseURL: "http://localhost:3124", actionTimeout: 15_000 },
  outputDir: "../../tmp/workflow-operator-e2e",
  webServer: servers.map((server) => ({
    ...server,
    ...(String(server.url).includes(":8000")
      ? { url: "http://127.0.0.1:8120/health" }
      : {
          command: process.env.KNOWLEDGE_BROWSER_COMMAND ?? "pnpm dev --port 3124",
          ...(process.env.KNOWLEDGE_BROWSER_CWD ? { cwd: process.env.KNOWLEDGE_BROWSER_CWD } : {}),
          url: "http://localhost:3124",
        }),
    env: { ...server.env, API_BASE_URL: "http://127.0.0.1:8120", PORT: "8120" },
  })),
});
