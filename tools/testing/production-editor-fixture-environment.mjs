import process from "node:process";
import { URL } from "node:url";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

const invalid = () => { throw new Error("PRODUCTION_EDITOR_FIXTURE_ENVIRONMENT_INVALID"); };
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Admission only. This helper never reads .env, opens a socket or creates a
 * database, storage or queue client. The runner owns every accepted resource. */
export function requireProductionEditorFixtureEnvironment(environment = process.env) {
  let databaseUrl;
  try { databaseUrl = requireDisposableIntegrationEnvironment(environment); } catch { invalid(); }
  const database = new URL(databaseUrl);
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
  if (!nonce || !loopback.has(database.hostname) || database.search || database.hash
    || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`
    || environment.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}`) invalid();

  const redisUrl = environment.REDIS_URL;
  if (!redisUrl || redisUrl !== environment.E2E_DISPOSABLE_REDIS_URL) invalid();
  let redis;
  try { redis = new URL(redisUrl); } catch { invalid(); }
  if (redis.protocol !== "redis:" || !loopback.has(redis.hostname) || !redis.port || Number(redis.port) < 1
    || redis.username || redis.password || !["", "/"].includes(redis.pathname) || redis.search || redis.hash) invalid();

  const designFault = environment.E2E_DESIGN_AGENT_FAULT;
  if (designFault !== undefined && !["unknown_pillow_cutout", "expire_order_before_response"].includes(designFault)) invalid();
  return { isolatedDaily: true, databaseUrl, redisUrl, bucket: environment.S3_PRIVATE_BUCKET, nonce, designFault };
}
