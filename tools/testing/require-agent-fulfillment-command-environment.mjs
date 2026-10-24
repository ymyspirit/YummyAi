import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { fulfillmentCommandIsolationFlags } from "./require-fulfillment-command-environment.mjs";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

export const agentFulfillmentCommandIsolationFlags = [...fulfillmentCommandIsolationFlags, "E2E_AGENT_FULFILLMENT_COMMAND_ISOLATED"];
/** All resources and the explicit schema branch are checked before any connection. */
export function requireAgentFulfillmentCommandEnvironment(environment = process.env, browser = false, target = "current") {
  const url = new URL(requireDisposableIntegrationEnvironment(environment));
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const local = ["localhost", "127.0.0.1", "[::1]"], redis = environment.E2E_DISPOSABLE_REDIS_URL;
  if (!nonce || !["current", "pre-0186"].includes(target) || environment.E2E_LEGACY_SCHEMA_TARGET !== target
    || agentFulfillmentCommandIsolationFlags.some(flag => environment[flag] !== "1") || !local.includes(url.hostname)
    || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !redis || environment.REDIS_URL !== redis
    || environment.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` || !["redis:", "rediss:"].includes(new URL(redis).protocol)
    || !local.includes(new URL(redis).hostname)) throw new Error("Agent fulfillment requires its exact isolated nonce database bucket Redis and schema target");
  if (target === "pre-0186") {
    const source = environment.E2E_AGENT_FULFILLMENT_COMMAND_LEGACY_SOURCE ?? "";
    const expected = fileURLToPath(new URL("../../.artifacts/ordinary-api-source-185-a4d9e821-r6", import.meta.url));
    if (browser || environment.E2E_AGENT_FULFILLMENT_COMMAND_UPGRADE_ISOLATED !== "1" || !isAbsolute(source) || resolve(source) !== resolve(expected))
      throw new Error("Agent fulfillment upgrade requires the exact retained original185 source and isolated admission");
  }
  if (browser) {
    const api = new URL(environment.API_BASE_URL ?? "https://invalid.invalid");
    if (environment.E2E_COMPILED_WEB !== "1" || environment.WEB_AUTH_MODE !== "personal" || !local.includes(api.hostname)
      || api.port !== "8130" || !environment.ERP_FIXTURE_ACTORS) throw new Error("Agent fulfillment browser requires compiled personal3130/8130 and original fixture identity");
  }
  return { url: url.href, nonce, name: `order_daily_e2e_${nonce}`, lane: fileURLToPath(new URL("../../tmp/agent-fulfillment-command-20261023-d6b2f901", import.meta.url)) };
}
