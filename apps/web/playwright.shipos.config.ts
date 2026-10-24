import { defineConfig } from "@playwright/test";
import base from "./playwright.order-daily.config";
import personal from "./playwright.erp-identity.config";
if (!process.env.SHIPOS_TEST_BASE_URL || !/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.SHIPOS_TEST_BASE_URL)) throw new Error("Use the disposable ShipOS acceptance runner");
const personalMode = process.env.WEB_AUTH_MODE === "personal";
const selected = personalMode ? personal : base;
const servers = Array.isArray(selected.webServer) ? selected.webServer : [];
export default defineConfig({ ...selected, testMatch: ["shipos.spec.ts"], grep: /ShipOS/, workers: 1, outputDir: "../../tmp/shipos-e2e",
  use: { ...selected.use, actionTimeout: 15_000 },
  webServer: personalMode ? servers : servers.map(server => ({ ...server, ...(String(server.url).includes(":8000") ? { url: "http://127.0.0.1:8110/health" } : {}), env: { ...server.env, API_BASE_URL: "http://127.0.0.1:8110", PORT: "8110" } })),
});
