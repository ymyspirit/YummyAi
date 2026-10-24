import process from "node:process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
export const storeNodeIdentityIsolationFlags = Object.freeze(["E2E_ISOLATED_DAILY", "E2E_STORE_NODE_IDENTITY_ISOLATED"]);
/** Pure preflight: never connects, reads .env, starts a process or changes configuration. */
export function requireStoreNodeIdentityEnvironment(env = process.env, target = "current", browser = false) {
  const database = new URL(requireDisposableIntegrationEnvironment(env));
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
  const local = ["localhost", "127.0.0.1", "[::1]"], redis = env.E2E_DISPOSABLE_REDIS_URL;
  if (!nonce || !["current", "pre-0179"].includes(target) || env.E2E_LEGACY_SCHEMA_TARGET !== target ||
    storeNodeIdentityIsolationFlags.some(flag => env[flag] !== "1") || !local.includes(database.hostname) ||
    env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !redis || env.REDIS_URL !== redis ||
    env.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}`)
    throw new Error("Store node identity requires exact isolated nonce resources before connection");
  let redisUrl; try { redisUrl = new URL(redis); } catch { throw new Error("Store node identity disposable Redis is invalid"); }
  if (!["redis:", "rediss:"].includes(redisUrl.protocol) || !local.includes(redisUrl.hostname) || redisUrl.username || redisUrl.password || redisUrl.hash)
    throw new Error("Store node identity requires its local disposable Redis");
  const root = env.E2E_STORE_NODE_LEGACY_SOURCE;
  if (target === "pre-0179" && (!root || !isAbsolute(root) || resolve(root) !== resolve(workspace, "tmp/store-node-identity-20261022-c7e3a6d2/old178-source")))
    throw new Error("Store node identity requires its exact original178 source tree");
  if (browser) {
    let api; try { api = new URL(env.API_BASE_URL ?? "https://invalid.invalid"); } catch { throw new Error("Store node identity API URL is invalid"); }
    if (target !== "current" || env.E2E_COMPILED_WEB !== "1" || env.WEB_AUTH_MODE !== "personal" || api.protocol !== "http:" ||
      !local.includes(api.hostname) || api.port !== "8130" || api.pathname !== "/" || api.search || api.hash || api.username || api.password || !env.ERP_FIXTURE_ACTORS)
      throw new Error("Store node identity browser requires compiled personal3130/8130 and actual members");
  }
  return { url: database.href, name: database.pathname.slice(1), nonce };
}
