import { defineConfig } from "@playwright/test";
import daily from "./playwright.order-daily.config";
import personal from "./playwright.factory-portal.config";

const servers = Array.isArray(personal.webServer) ? personal.webServer : [];

// The ordinary workflow includes owner-bound fulfillment commands. Reuse the
// isolated personal OIDC path while retaining the complete daily smoke scope.
export default defineConfig({
  ...personal,
  testMatch: daily.testMatch,
  grep: daily.grep,
  outputDir: "../../tmp/order-daily-personal-e2e",
  webServer: servers.map(server => ({
    ...server,
    ...(String(server.url).includes(":8130") ? {} : { url: "http://localhost:3130/login" }),
    env: {
      ...server.env,
      FACTORY_PORTAL_ONLY: "0",
      WEB_AUTH_MODE: "personal",
      WEB_ORIGIN: "http://localhost:3130",
    },
  })),
});
