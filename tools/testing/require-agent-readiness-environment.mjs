import process from "node:process";
import { requireNativeV3Environment } from "./require-agent-native-v3-environment.mjs";

/** Read-only diagnostics still use exactly owned current-schema resources. */
export function requireAgentReadinessEnvironment(environment = process.env, browser = false) {
  if (environment.E2E_AGENT_READINESS_ISOLATED !== "1") throw new Error("Agent readiness requires its dedicated isolation flag before loading tests");
  return requireNativeV3Environment(environment, "current", browser);
}
