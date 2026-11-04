import { defineConfig } from "@playwright/test";
import base from "./playwright.order-daily.config";
const api = Number(process.env.E2E_ORDER_DOCUMENTS_API_PORT), web = Number(process.env.E2E_ORDER_DOCUMENTS_WEB_PORT);
if (process.env.E2E_ORDER_DOCUMENTS_ISOLATED !== "1" || ![api, web].every(port => Number.isSafeInteger(port) && port > 1024 && port < 65536 && ![3000, 8000, 4176, 4177, 3130, 8130].includes(port)) || api === web || !process.env.KNOWLEDGE_BROWSER_CWD || !process.env.KNOWLEDGE_BROWSER_COMMAND) throw new Error("Use disposable order document browser acceptance");
const env = { ...process.env, API_BASE_URL: `http://127.0.0.1:${api}`, NODE_OPTIONS: "--max-old-space-size=8192", DASHBOARD_DEMO_MODE: "0", ANALYSIS_DEMO_MODE: "0", PRODUCT_DEMO_MODE: "0", DESIGN_DEMO_MODE: "0", LISTING_DEMO_MODE: "0" };
export default defineConfig({ ...base, grep: /order documents/, testMatch: "order-documents.spec.ts", workers: 1, timeout: 300_000,
  use: { ...base.use, baseURL: `http://localhost:${web}`, actionTimeout: 20_000 },
  webServer: [
    { command: "pnpm --dir ../.. --filter @yummyai/api start", url: `http://127.0.0.1:${api}/health`, reuseExistingServer: false, timeout: 120_000, env: { ...env, PORT: String(api) } },
    { command: process.env.KNOWLEDGE_BROWSER_COMMAND, cwd: process.env.KNOWLEDGE_BROWSER_CWD, url: `http://localhost:${web}`, reuseExistingServer: false, timeout: 180_000, env },
  ] });
