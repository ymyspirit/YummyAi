import { defineConfig } from "@playwright/test";
import base from "./playwright.product-access.config";
export default defineConfig({ ...base, testMatch: ["logistics.spec.ts", "production-delivery.spec.ts", "production-surface.spec.ts"], grep: /logistics|production delivery/, use: {...base.use, actionTimeout: 20_000}, workers: 1, outputDir: "../../tmp/logistics-e2e" });
