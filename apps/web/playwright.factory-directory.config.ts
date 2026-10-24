import { defineConfig } from "@playwright/test";
import base from "./playwright.product-access.config";
export default defineConfig({ ...base, testMatch: "factory-directory.spec.ts", grep: /factory directory/, workers: 1, outputDir: "../../tmp/factory-directory-e2e" });
