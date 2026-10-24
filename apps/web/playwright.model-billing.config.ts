import { defineConfig } from "@playwright/test";
import isolated from "./playwright.order-daily.config";
const servers = Array.isArray(isolated.webServer) ? isolated.webServer : [];
export default defineConfig({
  ...isolated,
  testMatch: ["model-billing.spec.ts"],
  grep: undefined,
  workers: 1,
  timeout: 180000,
  use: { ...isolated.use, baseURL: "http://localhost:3129", actionTimeout: 15000 },
  outputDir: "../../tmp/model-billing-e2e",
  webServer: servers.map((server) => ({
    ...server,
    ...(String(server.url).includes(":8000")
      ? { url: "http://127.0.0.1:8126/health" }
      : {
          command: process.env.KNOWLEDGE_BROWSER_COMMAND ?? "pnpm dev --port 3129",
          ...(process.env.KNOWLEDGE_BROWSER_CWD ? { cwd: process.env.KNOWLEDGE_BROWSER_CWD } : {}),
          url: "http://localhost:3129",
        }),
    env: {
      ...server.env,
      API_BASE_URL: "http://127.0.0.1:8126",
      PORT: "8126",
      MODEL_BILLING_TENANT_IDS: "*",
    },
  })),
});
