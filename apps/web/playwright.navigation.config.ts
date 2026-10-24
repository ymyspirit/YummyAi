import { defineConfig } from "@playwright/test";
import base from "./playwright.order-daily.config";
const servers = Array.isArray(base.webServer) ? base.webServer : [];

// Inherits disposable resources and disables every demo flag.
export default defineConfig({
  ...base,
  testMatch: ["navigation-workspace.spec.ts"],
  grep: /.*/,
  workers: 1,
  outputDir: "../../tmp/navigation-e2e",
  webServer: servers.map((server) => String(server.url).includes(":8000") ? server : ({
    ...server,
    command: process.env.KNOWLEDGE_BROWSER_COMMAND ?? server.command,
    ...(process.env.KNOWLEDGE_BROWSER_CWD ? { cwd: process.env.KNOWLEDGE_BROWSER_CWD } : {}),
  })),
});
