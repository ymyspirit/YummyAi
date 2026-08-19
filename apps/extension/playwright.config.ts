import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./e2e", timeout: 30_000, reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "list", projects: [{ name: "chromium" }] });
