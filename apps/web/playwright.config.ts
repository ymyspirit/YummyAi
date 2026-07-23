import { defineConfig, devices } from "@playwright/test";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "list",
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --dir ../.. --filter @yummyai/api start",
      url: "http://127.0.0.1:8000/health",
      reuseExistingServer: false,
      timeout: 120_000,
      env: { ...process.env, NODE_OPTIONS: "" },
    },
    {
      command: "pnpm dev --port 3100",
      url: "http://localhost:3100",
      reuseExistingServer: false,
      timeout: 120_000,
      env: { ...process.env, NODE_OPTIONS: "", DASHBOARD_DEMO_MODE: "1", ANALYSIS_DEMO_MODE: "1", PRODUCT_DEMO_MODE: "1", DESIGN_DEMO_MODE: "1", LISTING_DEMO_MODE: "1" },
    },
  ],
});
