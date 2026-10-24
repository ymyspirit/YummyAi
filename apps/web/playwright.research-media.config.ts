import { defineConfig } from "@playwright/test";
import isolated from "./playwright.order-daily.config";
const servers = Array.isArray(isolated.webServer) ? isolated.webServer : [];
export default defineConfig({
  ...isolated,
  testMatch: ["research-media.spec.ts", "research-creative.spec.ts"],
  grep: undefined,
  timeout: 180_000,
  use: { ...isolated.use, baseURL: "http://localhost:3126", actionTimeout: 15_000 },
  outputDir: "../../tmp/research-media-e2e",
  webServer: servers.map((server) => ({
    ...server,
    ...(String(server.url).includes(":8000")
      ? { url: "http://127.0.0.1:8122/health" }
      : {
          command: process.env.KNOWLEDGE_BROWSER_COMMAND ?? "pnpm dev --port 3126",
          ...(process.env.KNOWLEDGE_BROWSER_CWD ? { cwd: process.env.KNOWLEDGE_BROWSER_CWD } : {}),
          url: "http://localhost:3126",
        }),
    env: { ...server.env, API_BASE_URL: "http://127.0.0.1:8122", PORT: "8122" },
  })),
});
