import { defineConfig } from "@playwright/test";
import baseline from "./playwright.config";
const servers = Array.isArray(baseline.webServer) ? baseline.webServer : [];
export default defineConfig({
  ...baseline,
  testMatch: "ai-assist.spec.ts",
  grep: /third batch/,
  metadata: { aiBusinessTransport: true },
  webServer: [
    servers[0]!,
    {
      command: "pnpm --dir ../api exec node --import tsx ../web/e2e/ai-business-fixture-server.ts",
      url: "http://127.0.0.1:3311/health",
      reuseExistingServer: false,
      timeout: 30000,
    },
    { ...servers[1]!, env: { ...servers[1]!.env, API_BASE_URL: "http://127.0.0.1:3311" } },
  ],
});
