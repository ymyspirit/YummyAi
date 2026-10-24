import process from "node:process";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const dependencyPlanIsolationFlags = ["E2E_ISOLATED_DAILY", "E2E_AGENT_COMMAND_ISOLATED", "E2E_PROCUREMENT_PROCESS_ISOLATED", "E2E_INVOICE_COMMAND_ISOLATED", "E2E_AGENT_DEPENDENCY_PLAN_ISOLATED"];
/** Reject foreign resources before test imports, connections, or child processes. */
export function requireAgentDependencyPlanEnvironment(environment = process.env, target = "current", browser = false) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment));
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const local = ["localhost", "127.0.0.1", "[::1]"], redis = environment.E2E_DISPOSABLE_REDIS_URL;
  if (!nonce || !["current", "pre-0184"].includes(target) || environment.E2E_LEGACY_SCHEMA_TARGET !== target
    || dependencyPlanIsolationFlags.some(flag => environment[flag] !== "1") || !local.includes(url.hostname)
    || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !redis || environment.REDIS_URL !== redis
    || environment.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` || !["redis:", "rediss:"].includes(new URL(redis).protocol)
    || !local.includes(new URL(redis).hostname)) throw new Error("Agent dependency plans require their exact isolated nonce database bucket Redis and schema target");
  if (browser) {
    const api = new URL(environment.API_BASE_URL ?? "https://invalid.invalid");
    if (environment.E2E_COMPILED_WEB !== "1" || environment.WEB_AUTH_MODE !== "personal" || !local.includes(api.hostname)
      || api.port !== "8130" || !environment.ERP_FIXTURE_ACTORS) throw new Error("Dependency plan browser requires compiled personal3130/8130 and its actual fixture identity");
  }
  return { url: url.href, nonce, name: `order_daily_e2e_${nonce}`, lane: path.join(root, "tmp/agent-dependency-plan-20261023-3f7c2a91") };
}
