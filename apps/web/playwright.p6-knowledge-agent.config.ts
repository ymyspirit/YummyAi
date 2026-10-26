import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { requireAgentNativeV4Environment } from "../../tools/testing/require-agent-native-v4-environment.mjs";
import base from "./playwright.agent-native-v4.config";

const isolated = requireAgentNativeV4Environment(process.env, "current", true);
if (process.env.E2E_P6_KNOWLEDGE_AGENT_ISOLATED !== "1")
  throw new Error("P6 knowledge Agent browser requires its explicit disposable admission before loading tests");

export default defineConfig({
  ...base,
  testMatch: "p6-knowledge-agent.spec.ts",
  grep: undefined,
  outputDir: fileURLToPath(new URL(`../../tmp/order-daily-artifacts-${isolated.nonce}/playwright`, import.meta.url)),
  metadata: { isolatedNonce: isolated.nonce, scope: "personal_published_product_knowledge_and_original_command_recovery", realPaidCalls: false },
});
