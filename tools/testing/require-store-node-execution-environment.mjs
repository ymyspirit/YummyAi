import process from "node:process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const storeNodeExecutionIsolationFlags = Object.freeze(["E2E_ISOLATED_DAILY", "E2E_STORE_NODE_EXECUTION_ISOLATED"]);
/** Pure preflight: no .env, network, database, subprocess or configuration mutation. */
export function requireStoreNodeExecutionEnvironment(env = process.env, target = "current", browser = false) {
  const database = new URL(requireDisposableIntegrationEnvironment(env));
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
  const local = ["localhost", "127.0.0.1", "[::1]"], redis = env.E2E_DISPOSABLE_REDIS_URL;
  if (!nonce || !["current", "pre-0180"].includes(target) || env.E2E_LEGACY_SCHEMA_TARGET !== target ||
    storeNodeExecutionIsolationFlags.some(flag => env[flag] !== "1") || !local.includes(database.hostname) ||
    env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !redis || env.REDIS_URL !== redis ||
    env.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}`)
    throw new Error("Store node execution requires exact isolated nonce resources before connection");
  let value; try { value = new URL(redis); } catch { throw new Error("Store node execution Redis is invalid"); }
  if (!["redis:", "rediss:"].includes(value.protocol) || !local.includes(value.hostname) || value.username || value.password || value.hash || value.search)
    throw new Error("Store node execution requires its local disposable Redis");
  if (target === "pre-0180") {
    const source = env.E2E_STORE_NODE_EXECUTION_LEGACY_SOURCE;
    if (!source || !isAbsolute(source) || resolve(source) !== resolve(root, "tmp/store-node-execution-20261022-e6f2c8a1/old179-source"))
      throw new Error("Store node execution requires its exact original179 source tree");
  }
  if (browser) {
    let api; try { api = new URL(env.API_BASE_URL ?? "https://invalid.invalid"); } catch { throw new Error("Store node execution API URL is invalid"); }
    if (target !== "current" || env.E2E_COMPILED_WEB !== "1" || env.WEB_AUTH_MODE !== "personal" || api.protocol !== "http:" ||
      !local.includes(api.hostname) || api.port !== "8130" || api.pathname !== "/" || api.search || api.hash || api.username || api.password || !env.ERP_FIXTURE_ACTORS)
      throw new Error("Store node execution browser requires compiled personal3130/8130 and actual members");
  }
  return { url: database.href, name: database.pathname.slice(1), nonce };
}
