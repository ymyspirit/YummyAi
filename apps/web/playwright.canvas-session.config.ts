import { defineConfig } from "@playwright/test";
import methods from "./playwright.methods.config";

const servers = Array.isArray(methods.webServer) ? methods.webServer : [];
const runtimeHealth = new URL("/health", process.env.CANVAS_STUDIO_URL ?? "http://127.0.0.1:4176").href;
export default defineConfig({
  ...methods,
  testMatch: ["canvas-session.spec.ts", "canvas-upgrade.spec.ts", "creative-studio.spec.ts", "creative-studio-configuration.spec.ts", "canvas-bridge-workflow.spec.ts", "creative-execution-operator.spec.ts", "mockup-management.spec.ts"],
  grep: /.*/,
  workers: 1,
  outputDir: "../../tmp/canvas-session-e2e",
  webServer: [{
    command: "pnpm --dir ../.. studio:start",
    url: runtimeHealth,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ...process.env, NODE_OPTIONS: "" },
  }, ...servers],
});
