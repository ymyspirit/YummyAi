import path from "node:path";
import { defineConfig } from "@playwright/test";
import personal from "./playwright.erp-identity.config";

if (!process.env.YUMMYAI_TEST_CACHE_DIR) throw new Error("Use the disposable incoming acceptance runner");
export default defineConfig({ ...personal, testMatch: ["incoming-inspection.spec.ts", "inventory-classification.spec.ts", "manual-procurement.spec.ts"], grep: undefined, workers: 1,
  timeout: 180_000, outputDir: path.join(process.env.YUMMYAI_TEST_CACHE_DIR, "playwright") });
