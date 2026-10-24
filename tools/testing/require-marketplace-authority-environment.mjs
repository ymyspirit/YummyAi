import process from "node:process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
export const marketplaceAuthorityIsolationFlags = ["E2E_ISOLATED_DAILY", "E2E_MARKETPLACE_AUTHORITY_ISOLATED"];
export function requireMarketplaceAuthorityEnvironment(env = process.env, target = "current", browser = false) {
  const url = new URL(requireDisposableIntegrationEnvironment(env));
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const local = ["localhost", "127.0.0.1", "[::1]"], redis = env.E2E_DISPOSABLE_REDIS_URL;
  if (!nonce || !["current", "pre-0178"].includes(target) || env.E2E_LEGACY_SCHEMA_TARGET !== target ||
    marketplaceAuthorityIsolationFlags.some(flag => env[flag] !== "1") || !local.includes(url.hostname) ||
    env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !redis || env.REDIS_URL !== redis ||
    env.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}`) throw new Error("Marketplace authority requires exact isolated nonce resources before connection");
  let redisUrl; try { redisUrl = new URL(redis); } catch { throw new Error("Marketplace authority disposable Redis is invalid"); }
  if (!["redis:", "rediss:"].includes(redisUrl.protocol) || !local.includes(redisUrl.hostname)) throw new Error("Marketplace authority requires local disposable Redis");
  if (target === "pre-0178") {
    const root = env.E2E_MARKETPLACE_AUTHORITY_LEGACY_SOURCE;
    if (!root || !isAbsolute(root) || resolve(root) !== resolve(workspace, "tmp/marketplace-authority-20261022-d8b7a3c6/old177-source"))
      throw new Error("Marketplace authority requires its exact original177 tree");
  }
  if (browser) {
    let api; try { api = new URL(env.API_BASE_URL ?? "https://invalid.invalid"); } catch { throw new Error("Marketplace authority API URL is invalid"); }
    if (env.E2E_COMPILED_WEB !== "1" || env.WEB_AUTH_MODE !== "personal" || !local.includes(api.hostname) || api.port !== "8130" || !env.ERP_FIXTURE_ACTORS)
      throw new Error("Marketplace authority browser requires compiled personal3130/8130 and actual members");
  }
  return { url: url.href, name: url.pathname.slice(1), nonce };
}
