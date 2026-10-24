import process from "node:process";
import path from "node:path";
import { pathToFileURL, URL } from "node:url";

const fail = () => { throw new Error("LOCAL_FACTORY_ERP_RETENTION_CONFIGURATION_INVALID"); };

/** Fixed local privacy capability; never starts a business queue or consumer. */
export function factoryErpRetentionEnvironment(environment, args = []) {
  if (args.length) fail();
  for (const [key, protocols] of [["DATABASE_URL", ["postgres:", "postgresql:"]],
    ["REDIS_URL", ["redis:"]], ["S3_ENDPOINT", ["http:", "https:"]]]) {
    let url;
    try { url = new URL(environment[key]); } catch { fail(); }
    if (!protocols.includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.search || url.hash) fail();
    if (key === "S3_ENDPOINT" && (url.username || url.password || url.pathname !== "/")) fail();
    if (key === "DATABASE_URL" && (!url.pathname || url.pathname === "/")) fail();
  }
  return { ...environment, NODE_ENV: "production", TSX_DISABLE_CACHE: "1",
    WORKER_QUEUES: "none", WORKER_SCHEDULERS: "factoryErpSourceRetentionScheduler" };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    Object.assign(process.env, factoryErpRetentionEnvironment(process.env, process.argv.slice(2)));
    await import(new URL("../../apps/worker/src/run.ts", import.meta.url).href);
  } catch {
    process.stderr.write("LOCAL_FACTORY_ERP_RETENTION_CONFIGURATION_INVALID\n");
    process.exitCode = 1;
  }
}
