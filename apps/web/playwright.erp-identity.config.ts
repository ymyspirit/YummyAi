import { defineConfig } from "@playwright/test";
import factory, { factoryPortalApiHealthUrl } from "./playwright.factory-portal.config";
const servers = Array.isArray(factory.webServer) ? factory.webServer : [];
export default defineConfig({
  ...factory,
  testMatch: "erp-identity.spec.ts",
  outputDir: "../../tmp/erp-identity-e2e",
  webServer: servers.map((server) => ({
    ...server,
    ...(server.url === factoryPortalApiHealthUrl ? {} : { url: "http://localhost:3130/login" }),
    env: {
      ...server.env,
      FACTORY_PORTAL_ONLY: "0",
      WEB_AUTH_MODE: "personal",
      WEB_ORIGIN: "http://localhost:3130",
    },
  })),
});
