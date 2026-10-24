import process from "node:process";
import { nativeV3IsolationFlags, requireNativeV3Environment } from "./require-agent-native-v3-environment.mjs";

export const mcpV2IsolationFlags = [...nativeV3IsolationFlags, "E2E_AGENT_MCP_V2_ISOLATED"];

/** No credential helper, DB client or identity fixture may be constructed first. */
export function requireAgentMcpV2Environment(environment = process.env, browser = false) {
  if (environment.E2E_AGENT_MCP_V2_ISOLATED !== "1")
    throw new Error("MCP-v2 requires its explicit disposable opt-in before construction or connection");
  return requireNativeV3Environment(environment, "current", browser);
}
