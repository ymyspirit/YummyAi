import { defineConfig } from "@playwright/test";
import factory from "./playwright.factory-portal.config";
const servers = Array.isArray(factory.webServer) ? factory.webServer : [];
export default defineConfig({
  ...factory,
  testMatch: "factory-collaboration.spec.ts",
  outputDir: "../../tmp/factory-collaboration-e2e",
  webServer: servers.map((server) => ({
    ...server,
    ...(String(server.url).includes(":8130") ? {} : { url: "http://localhost:3130" }),
    env: { ...server.env, FACTORY_PORTAL_ONLY: "0" },
  })),
});
