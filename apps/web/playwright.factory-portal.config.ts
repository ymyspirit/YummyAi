import { defineConfig } from "@playwright/test";
import isolated from "./playwright.order-daily.config";
const servers = Array.isArray(isolated.webServer) ? isolated.webServer : [];
const apiPort = Number(process.env.E2E_FACTORY_PORTAL_API_PORT ?? "8130");
if (!Number.isInteger(apiPort) || apiPort <= 1024 || apiPort > 65535 || [3000,3130,4177,8000].includes(apiPort))
  throw new Error("A dedicated isolated factory portal API port is required");
export const factoryPortalApiHealthUrl = `http://127.0.0.1:${apiPort}/health`;
export default defineConfig({
  ...isolated,
  testMatch: "factory-portal.spec.ts",
  grep: undefined,
  workers: 1,
  timeout: 180000,
  use: { ...isolated.use, baseURL: "http://localhost:3130", actionTimeout: 15000 },
  outputDir: "../../tmp/factory-portal-e2e",
  webServer: servers.map((server) => ({
    ...server,
    ...(String(server.url).includes(":8000")
      ? { url: factoryPortalApiHealthUrl }
      : {
          command: process.env.KNOWLEDGE_BROWSER_COMMAND ?? "pnpm dev --port 3130",
          ...(process.env.KNOWLEDGE_BROWSER_CWD ? { cwd: process.env.KNOWLEDGE_BROWSER_CWD } : {}),
          url: "http://localhost:3130/factory-work-items",
        }),
    env: {
      ...server.env,
      ...process.env,
      API_BASE_URL: `http://127.0.0.1:${apiPort}`,
      PORT: String(apiPort),
      FACTORY_PORTAL_ONLY: "1",
      FACTORY_PORTAL_ORIGIN: "http://localhost:3130",
      DASHBOARD_DEMO_MODE: "0",
      ANALYSIS_DEMO_MODE: "0",
      PRODUCT_DEMO_MODE: "0",
      DESIGN_DEMO_MODE: "0",
      LISTING_DEMO_MODE: "0",
    },
  })),
});
