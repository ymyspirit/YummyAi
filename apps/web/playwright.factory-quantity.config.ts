import { defineConfig } from "@playwright/test";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";
import identity from "./playwright.erp-identity.config";

const disposable = new URL(requireDisposableIntegrationEnvironment());
if (process.env.E2E_FACTORY_QUANTITY_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" ||
    process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${disposable.pathname.slice("/order_daily_e2e_".length)}` || process.env.E2E_COMPILED_WEB !== "1")
  throw new Error("Factory quantity requires its compiled personal dual-runtime disposable runner");
const port = Number(process.env.E2E_FACTORY_QUANTITY_API_PORT), factoryOrigin = new URL(process.env.FACTORY_QUANTITY_FACTORY_ORIGIN!);
if (!Number.isInteger(port) || port < 1025 || port > 65535 || [3000, 8000, 8001, 4177, 3130, 3132, 8130].includes(port) ||
    factoryOrigin.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(factoryOrigin.hostname) ||
    factoryOrigin.origin !== process.env.FACTORY_QUANTITY_FACTORY_ORIGIN || factoryOrigin.username || factoryOrigin.password ||
    factoryOrigin.search || factoryOrigin.hash || !factoryOrigin.port ||
    [port, 3000, 8000, 8001, 4177, 3130, 3132, 8130].includes(Number(factoryOrigin.port)))
  throw new Error("Independent factory quantity API and factory Web loopback ports are required");
const factoryCwd = process.env.FACTORY_QUANTITY_FACTORY_CWD, factoryCommand = process.env.FACTORY_QUANTITY_FACTORY_COMMAND;
if (!factoryCwd || !factoryCommand || !process.env.KNOWLEDGE_BROWSER_CWD || !process.env.KNOWLEDGE_BROWSER_COMMAND)
  throw new Error("Both verified private compiled runtime directories and commands are required");
const api = `http://127.0.0.1:${port}`; process.env.API_BASE_URL = api;
const servers = Array.isArray(identity.webServer) ? identity.webServer : [];
const erpServers = servers.map(server => ({ ...server, ...(String(server.url).includes(":8130") ? { url: `${api}/health` } : {}),
  reuseExistingServer: false, env: { ...server.env, API_BASE_URL: api, PORT: String(port), WEB_AUTH_MODE: "personal",
    FACTORY_PORTAL_ONLY: "0", WEB_ORIGIN: "http://localhost:3130", FACTORY_PORTAL_ORIGIN: factoryOrigin.origin } }));
export default defineConfig({ ...identity, testMatch: ["factory-quantity.spec.ts"], workers: 1, timeout: 180_000,
  webServer: [...erpServers, { command: factoryCommand, cwd: factoryCwd, url: `${factoryOrigin.origin}/factory-work-items`,
    timeout: 120_000, reuseExistingServer: false, env: { ...process.env, API_BASE_URL: api, PORT: String(port),
      WEB_AUTH_MODE: "personal", FACTORY_PORTAL_ONLY: "1", WEB_ORIGIN: "http://localhost:3130", FACTORY_PORTAL_ORIGIN: factoryOrigin.origin } }],
});
