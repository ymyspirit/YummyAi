import { defineConfig } from "@playwright/test";
import { requireAgentReadinessEnvironment } from "../../tools/testing/require-agent-readiness-environment.mjs";
import base from "./playwright.agent-native-v3.config";
requireAgentReadinessEnvironment(process.env, true);
export default defineConfig({ ...base, testMatch: "agent-readiness.spec.ts", grep: undefined,
  outputDir: "../../tmp/agent-readiness-20261023-f4b6d2a9/qa/browser",
});
