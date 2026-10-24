import { defineConfig } from "@playwright/test";
import { requireAgentRuntimeReadinessEnvironment } from "../../tools/testing/require-agent-runtime-readiness-environment.mjs";
import base from "./playwright.agent-native-v3.config";

requireAgentRuntimeReadinessEnvironment(process.env, true);

export default defineConfig({ ...base, testMatch: "agent-runtime-readiness.spec.ts", grep: undefined,
  outputDir: "../../tmp/agent-runtime-readiness-20261023-5a91d7c3/qa/browser" });
