import process from "node:process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const publicationNodePreviewIsolationFlags = Object.freeze(["E2E_ISOLATED_DAILY", "E2E_PUBLICATION_NODE_PREVIEW_ISOLATED"]);
/** Pure preflight. No connection, .env lookup or process mutation. */
export function requirePublicationNodePreviewEnvironment(env = process.env, target = "current", browser = false) {
  const database = new URL(requireDisposableIntegrationEnvironment(env));
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
  const local = ["localhost", "127.0.0.1", "[::1]"], redis = env.E2E_DISPOSABLE_REDIS_URL;
  if (!nonce || !["current", "pre-0182"].includes(target) || env.E2E_LEGACY_SCHEMA_TARGET !== target ||
    publicationNodePreviewIsolationFlags.some(flag => env[flag] !== "1") || !local.includes(database.hostname) ||
    env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !redis || env.REDIS_URL !== redis ||
    env.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}`)
    throw new Error("Publication node preview requires exact isolated nonce resources before connection");
  let value; try { value = new URL(redis); } catch { throw new Error("Publication node preview Redis is invalid"); }
  if (!["redis:", "rediss:"].includes(value.protocol) || !local.includes(value.hostname) || value.username || value.password || value.hash || value.search)
    throw new Error("Publication node preview requires its local disposable Redis");
  if (target === "pre-0182") {
    const source = env.E2E_PUBLICATION_NODE_PREVIEW_LEGACY_SOURCE;
    if (!source || !isAbsolute(source) || resolve(source) !== resolve(root, "tmp/publication-node-preview-20261022-a6f4c2d9/old181-source"))
      throw new Error("Publication node preview requires its exact original181 source tree");
  }
  if (browser) {
    let api; try { api = new URL(env.API_BASE_URL ?? "https://invalid.invalid"); } catch { throw new Error("Publication node preview API URL is invalid"); }
    if (target !== "current" || env.E2E_COMPILED_WEB !== "1" || env.WEB_AUTH_MODE !== "personal" || api.protocol !== "http:" ||
      !local.includes(api.hostname) || api.port !== "8130" || api.pathname !== "/" || api.search || api.hash || api.username || api.password || !env.ERP_FIXTURE_ACTORS)
      throw new Error("Publication node preview browser requires compiled personal3130/8130 and actual members");
  }
  return { url: database.href, name: database.pathname.slice(1), nonce };
}
