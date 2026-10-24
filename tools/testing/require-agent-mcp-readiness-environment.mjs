import process from "node:process";
import { requireAgentReadinessEnvironment } from "./require-agent-readiness-environment.mjs";

/** MCP diagnostics share the original diagnostics' disposable resource boundary. */
export function requireAgentMcpReadinessEnvironment(environment = process.env, browser = false) {
  if (environment.E2E_AGENT_MCP_READINESS_ISOLATED !== "1") throw new Error("MCP readiness requires its dedicated isolation flag before loading tests");
  return requireAgentReadinessEnvironment(environment, browser);
}
