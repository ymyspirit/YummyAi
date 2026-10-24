import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

export const orderSummaryIsolationFlags = ["E2E_ISOLATED_DAILY", "E2E_ORDER_SUMMARY_AVAILABILITY_ISOLATED"];
/** Refuse ordinary resources before any DB, storage, or Redis connection. */
export function requireOrderSummaryEnvironment(environment = process.env, browser = false) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment));
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const local = ["localhost", "127.0.0.1", "[::1]"], redis = environment.E2E_DISPOSABLE_REDIS_URL;
  if (!nonce || !local.includes(url.hostname) || environment.E2E_LEGACY_SCHEMA_TARGET !== "current"
    || orderSummaryIsolationFlags.some(flag => environment[flag] !== "1")
    || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !redis || environment.REDIS_URL !== redis
    || environment.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}`
    || !["redis:", "rediss:"].includes(new URL(redis).protocol) || !local.includes(new URL(redis).hostname))
    throw new Error("Order summaries require the exact isolated nonce database bucket Redis and current schema");
  if (browser) {
    const api = new URL(environment.API_BASE_URL ?? "https://invalid.invalid");
    if (environment.E2E_COMPILED_WEB !== "1" || environment.WEB_AUTH_MODE !== "personal" || !local.includes(api.hostname)
      || api.port !== "8130" || !environment.ERP_FIXTURE_ACTORS)
      throw new Error("Order summary browser requires compiled personal3130/8130 and original fixture identity");
  }
  return { url: url.href, nonce, name: `order_daily_e2e_${nonce}`,
    lane: fileURLToPath(new URL("../../tmp/order-summary-availability-20261023-a4d9e821", import.meta.url)) };
}
