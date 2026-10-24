import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { QueueName } from "../../packages/jobs/src/queues.ts";
import { redisConnection } from "../../packages/jobs/src/queue.ts";
import { resolveWorkspacePath } from "./backup-restore.mjs";
import { inspectLocalDurableWorkerState } from "./worker-durable-inventory.mts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const Redis = requireWeb("ioredis");
const listStates = ["wait", "paused", "active"] as const;
const sortedStates = ["delayed", "prioritized", "waiting-children", "completed", "failed"] as const;
const pendingStates = [...listStates, "delayed", "prioritized", "waiting-children"];

export class WorkerQueueInspectionError extends Error {
  constructor(readonly code: string) { super(code); this.name = "WorkerQueueInspectionError"; }
}

export async function inspectLocalWorkerQueues({ reportPath, includeDurable = false }: { reportPath?: string; includeDurable?: boolean } = {}) {
  const reportFile = reportPath ? await resolveWorkspacePath(root, reportPath, { fresh: true }) : undefined;
  let url: URL;
  try { url = new URL(process.env.REDIS_URL!); } catch { throw new WorkerQueueInspectionError("queue_inspection_configuration_missing"); }
  if (url.protocol !== "redis:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.search || url.hash || (url.username && url.username !== "default"))
    throw new WorkerQueueInspectionError("queue_inspection_requires_supported_local_redis");
  // The current shared Worker connection uses database 0. Do not report another
  // configured database as if it were the namespace the consumers actually use.
  if (url.pathname && url.pathname !== "/" && url.pathname !== "/0")
    throw new WorkerQueueInspectionError("queue_inspection_worker_database_mismatch");
  const redis = new Redis({ ...redisConnection(url.href), lazyConnect: true, enableOfflineQueue: false, connectTimeout: 3000, maxRetriesPerRequest: 1, retryStrategy: () => null });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    const queues = [];
    for (const name of Object.values(QueueName)) {
      const counts: Record<string, number> = {};
      for (const state of listStates) counts[state] = await redis.llen(`bull:${name}:${state}`);
      for (const state of sortedStates) counts[state] = await redis.zcard(`bull:${name}:${state}`);
      queues.push({ name, counts });
    }
    const pendingEntries = queues.reduce((sum, queue) => sum + pendingStates.reduce((count, state) => count + queue.counts[state]!, 0), 0);
    const report = {
      recordedAt: new Date().toISOString(), status: "inspected", redisDatabase: 0,
      declaredQueues: queues.length, pendingEntries, requiresOperationalReview: pendingEntries > 0,
      workerStartAuthorized: false, normalWorkerStarted: false, jobsConsumed: 0,
      queueConstructorsUsed: false, jobPayloadsRead: false, queueStateChanged: false,
      snapshotAtomic: false, queues,
      ...(includeDurable ? { durable: await inspectLocalDurableWorkerState() } : {}),
    };
    if (reportFile) {
      await fs.mkdir(path.dirname(reportFile), { recursive: true });
      await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    }
    return report;
  } catch (error) {
    if (error instanceof WorkerQueueInspectionError) throw error;
    throw new WorkerQueueInspectionError("queue_inspection_failed");
  } finally {
    if (redis.status === "ready") {
      try { await redis.quit(); } finally { redis.disconnect(); }
    } else redis.disconnect();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  let reportPath: string | undefined, includeDurable = false, valid = true;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--include-durable" && !includeDurable) includeDurable = true;
    else if (args[index] === "--report" && !reportPath && args[index + 1] && !args[index + 1]!.startsWith("--")) reportPath = args[++index];
    else valid = false;
  }
  const operation = valid ? inspectLocalWorkerQueues({ reportPath, includeDurable }) : Promise.reject(new WorkerQueueInspectionError("queue_inspection_arguments_invalid"));
  operation.then(report => process.stdout.write(JSON.stringify(report) + "\n")).catch(error => {
    process.stderr.write((error instanceof WorkerQueueInspectionError ? error.code : "queue_inspection_failed") + "\n");
    process.exitCode = 1;
  });
}
