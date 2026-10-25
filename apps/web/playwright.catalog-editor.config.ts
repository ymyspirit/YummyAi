import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import personal from "./playwright.erp-identity.config";
const servers = Array.isArray(personal.webServer) ? personal.webServer : [];
export default defineConfig({
  ...personal,
  testMatch: ["catalog-editor.spec.ts", "pillow-size-basis.spec.ts"],
  outputDir: "../../tmp/catalog-ui-authority-browser",
  webServer:
    process.env.E2E_COMPILED_WEB === "1"
      ? servers.map((server) =>
          String(server.url).includes(":8130")
            ? server
            : {
                ...server,
                cwd: process.env.KNOWLEDGE_BROWSER_CWD ?? fileURLToPath(new URL(".", import.meta.url)),
                command: process.env.KNOWLEDGE_BROWSER_COMMAND ?? "pnpm start --hostname 127.0.0.1 --port 3130",
              },
        )
      : servers,
});
