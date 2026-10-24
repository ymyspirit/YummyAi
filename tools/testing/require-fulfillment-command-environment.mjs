import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

export const fulfillmentCommandIsolationFlags = ["E2E_ISOLATED_DAILY", "E2E_FULFILLMENT_COMMAND_ISOLATED"];
/** Called before connections; all three resources must belong to one nonce. */
export function requireFulfillmentCommandEnvironment(environment = process.env, target = "current", browser = false) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment));
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const local = ["localhost", "127.0.0.1", "[::1]"], redis = environment.E2E_DISPOSABLE_REDIS_URL;
  if (!nonce || !["current", "pre-0185"].includes(target) || environment.E2E_LEGACY_SCHEMA_TARGET !== target
    || fulfillmentCommandIsolationFlags.some(flag => environment[flag] !== "1") || !local.includes(url.hostname)
    || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !redis || environment.REDIS_URL !== redis
    || environment.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` || !["redis:", "rediss:"].includes(new URL(redis).protocol)
    || !local.includes(new URL(redis).hostname)) throw new Error("Fulfillment recovery requires its exact isolated nonce database bucket Redis and schema target");
  if (browser) {
    const api = new URL(environment.API_BASE_URL ?? "https://invalid.invalid");
    if (environment.E2E_COMPILED_WEB !== "1" || environment.WEB_AUTH_MODE !== "personal" || !local.includes(api.hostname)
      || api.port !== "8130" || !environment.ERP_FIXTURE_ACTORS) throw new Error("Fulfillment browser requires compiled personal3130/8130 and original fixture identity");
  }
  return { url: url.href, nonce, name: `order_daily_e2e_${nonce}`, lane: fileURLToPath(new URL("../../tmp/fulfillment-recovery-20261023-c1e5a7b9", import.meta.url)) };
}
