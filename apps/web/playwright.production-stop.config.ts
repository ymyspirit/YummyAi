import { defineConfig } from "@playwright/test";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";
import identity from "./playwright.erp-identity.config";

const disposable = new URL(requireDisposableIntegrationEnvironment());
if (process.env.E2E_PRODUCTION_QUANTITY_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current")
  throw new Error("Use the dedicated disposable production-stop-browser runner");
if (process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${disposable.pathname.slice("/order_daily_e2e_".length)}`)
  throw new Error("Production stop requires the matching disposable private bucket");
const port = Number(process.env.E2E_PRODUCTION_STOP_API_PORT);
if (!Number.isInteger(port) || port < 1025 || port > 65535 || [3000, 8000, 4177, 3130, 8130].includes(port))
  throw new Error("A dedicated loopback disposable API port is required");
const api = `http://127.0.0.1:${port}`;
process.env.API_BASE_URL = api;
const servers = Array.isArray(identity.webServer) ? identity.webServer : [];

export default defineConfig({
  ...identity,
  testMatch: ["production-stop.spec.ts", "native-production.spec.ts", "factory-capacity.spec.ts"],
  // Playwright intersects the configured grep with CLI --grep. Include only
  // this slice and its two affected regressions so either can run separately.
  grep: /personal partial stop keeps original|unknown physical counts release nothing|personal native production recovers lost preparation|personal native production previews real local capacity/,
  workers: 1,
  timeout: 180_000,
  webServer: servers.map(server => ({
    ...server,
    ...(String(server.url).includes(":8130") ? { url: `${api}/health` } : {}),
    reuseExistingServer: false,
    env: { ...server.env, API_BASE_URL: api, PORT: String(port) },
  })),
});
