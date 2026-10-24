import { defineConfig } from "@playwright/test";
import { requireAgentMcpReadinessEnvironment } from "../../tools/testing/require-agent-mcp-readiness-environment.mjs";
import base from "./playwright.agent-native-v3.config";

requireAgentMcpReadinessEnvironment(process.env, true);

export default defineConfig({
  ...base,
  testMatch: "agent-mcp-readiness.spec.ts",
  grep: undefined,
  outputDir: "../../tmp/agent-mcp-readiness-20261023-8b2c6d14/qa/browser",
});
