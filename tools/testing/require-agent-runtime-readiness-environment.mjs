import process from "node:process";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { requireAgentReadinessEnvironment } from "./require-agent-readiness-environment.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
/** Reject foreign resources before application imports, spawning or connections. */
export function requireAgentRuntimeReadinessEnvironment(environment = process.env, browser = false) {
  if (environment.E2E_AGENT_RUNTIME_READINESS_ISOLATED !== "1") throw new Error("Agent runtime readiness requires its dedicated isolation flag before loading tests");
  const { url, nonce } = requireAgentReadinessEnvironment(environment, browser);
  return { url, nonce, name: "order_daily_e2e_" + nonce, lane: path.join(root, "tmp/agent-runtime-readiness-20261023-5a91d7c3") };
}
