import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";
import process from "node:process";
import { URL } from "node:url";

export const nativeV2IsolationFlags = ["E2E_AGENT_NATIVE_V2_ISOLATED", "E2E_AGENT_RESOURCES_ISOLATED", "E2E_AGENT_MCP_ISOLATED", "E2E_AGENT_NATIVE_ISOLATED",
  "E2E_AGENT_TOOLS_ISOLATED", "E2E_AGENT_PLAN_ISOLATED", "E2E_AGENT_LOOP_ISOLATED", "E2E_AGENT_COMMAND_ISOLATED", "E2E_AGENT_READ_ISOLATED",
  "E2E_ROLE_BENCHMARK_ISOLATED", "E2E_BUSINESS_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_EVALUATION_ISOLATED", "E2E_ISOLATED_DAILY"];
/** Fail before configuration imports or database connection. */
export function requireNativeV2Environment(environment = process.env, target = "current", browser = false) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment)), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const local = ["localhost", "127.0.0.1", "[::1]"], redis = environment.E2E_DISPOSABLE_REDIS_URL;
  if (!nonce || !["current", "pre-0176"].includes(target) || nativeV2IsolationFlags.some(flag => environment[flag] !== "1") || environment.E2E_LEGACY_SCHEMA_TARGET !== target
    || !local.includes(url.hostname) || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !redis || environment.REDIS_URL !== redis
    || environment.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` || !["redis:", "rediss:"].includes(new URL(redis).protocol) || !local.includes(new URL(redis).hostname))
    throw new Error("NativeV2 requires all flags and exact disposable nonce database, bucket and Redis before loading tests");
  if (browser) {
    const api = new URL(environment.API_BASE_URL ?? "https://invalid.invalid");
    if (environment.E2E_COMPILED_WEB !== "1" || environment.WEB_AUTH_MODE !== "personal" || !local.includes(api.hostname) || api.port !== "8130" || !environment.ERP_FIXTURE_ACTORS)
      throw new Error("NativeV2 browser requires compiled personal3130/8130 before loading tests");
  }
  return { url: url.href, nonce };
}
