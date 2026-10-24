import { defineConfig } from "@playwright/test";
import base from "./playwright.order-daily.config";
const servers=Array.isArray(base.webServer)?base.webServer:[];
export default defineConfig({ ...base, testMatch: ["logistics.spec.ts", "production-delivery.spec.ts", "production-surface.spec.ts"], grep: /logistics|production delivery/, use: {...base.use, actionTimeout: 20_000}, workers: 1, outputDir: "../../tmp/logistics-e2e",webServer:servers.map(server=>String(server.url).includes(":8000")?server:{...server,command:process.env.KNOWLEDGE_BROWSER_COMMAND??server.command,...(process.env.KNOWLEDGE_BROWSER_CWD?{cwd:process.env.KNOWLEDGE_BROWSER_CWD}:{})}) });
