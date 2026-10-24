import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { nativeV3IsolationFlags } from "./require-agent-native-v3-environment.mjs";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

export const nativeV4IsolationFlags = [...nativeV3IsolationFlags, "E2E_AGENT_NATIVE_V4_ISOLATED",
  "E2E_AGENT_FULFILLMENT_COMMAND_ISOLATED", "E2E_FULFILLMENT_COMMAND_ISOLATED"];

/** Validate before application imports, resource clients or connection attempts. */
export function requireAgentNativeV4Environment(environment = process.env, target = "current", browser = false) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment));
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const local = ["localhost", "127.0.0.1", "[::1]"], redis = environment.E2E_DISPOSABLE_REDIS_URL;
  if (!nonce || !["current", "pre-0187"].includes(target) || environment.E2E_LEGACY_SCHEMA_TARGET !== target
    || nativeV4IsolationFlags.some(flag => environment[flag] !== "1") || !local.includes(url.hostname)
    || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !redis || environment.REDIS_URL !== redis
    || environment.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}`
    || !["redis:", "rediss:"].includes(new URL(redis).protocol) || !local.includes(new URL(redis).hostname))
    throw new Error("NativeV4 requires every isolation flag and exact nonce database bucket Redis and schema target");
  if (target === "pre-0187") {
    const source = environment.E2E_AGENT_NATIVE_V4_LEGACY_SOURCE ?? "";
    const expected = fileURLToPath(new URL("../../.artifacts/ordinary-api-source-186-d6b2f901-r9", import.meta.url));
    if (browser || environment.E2E_AGENT_NATIVE_V4_UPGRADE_ISOLATED !== "1" || !isAbsolute(source) || resolve(source) !== resolve(expected))
      throw new Error("NativeV4 upgrade requires the exact retained original186 graph and isolated admission");
  }
  if (browser) {
    const api = new URL(environment.API_BASE_URL ?? "https://invalid.invalid");
    if (environment.E2E_COMPILED_WEB !== "1" || environment.WEB_AUTH_MODE !== "personal"
      || !local.includes(api.hostname) || api.port !== "8130" || !environment.ERP_FIXTURE_ACTORS)
      throw new Error("NativeV4 browser requires compiled personal3130/8130 and original fixture identity");
  }
  return { url: url.href, nonce, name: `order_daily_e2e_${nonce}`,
    lane: fileURLToPath(new URL("../../tmp/agent-native-v4-20261023-e7c41a92/qa", import.meta.url)) };
}
