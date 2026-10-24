import { defineConfig } from "@playwright/test";
import isolated from "./playwright.order-daily.config";
export default defineConfig({ ...isolated, testMatch: ["rule-center.spec.ts"], grep: undefined, use: { ...isolated.use, actionTimeout: 15_000 }, outputDir: "../../tmp/rule-center-e2e" });
