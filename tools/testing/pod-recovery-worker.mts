import { createEnvironmentSecretVault } from "../../packages/ai-core/src/environment-vault.js";
import { connectDatabase } from "../../packages/database/src/client.js";
import { createStorageFromEnvironment, type Storage } from "../../packages/storage/src/index.js";
import { createWorker } from "../../apps/worker/src/main.js";
import { HttpPodArtworkGateway } from "../../apps/worker/src/processors/pod-artwork.http-gateway.js";
import { PodArtworkProcessor } from "../../apps/worker/src/processors/pod-artwork.processor.js";
import { DrizzlePodArtworkExecutionRepository } from "../../apps/worker/src/processors/pod-artwork.repository.js";
import { QueueName } from "../../packages/jobs/src/queues.js";

// Executable acceptance probe, never a production Worker entry point.
const queueName = process.env.POD_RECOVERY_PROBE_QUEUE ?? "", taskId = process.env.POD_RECOVERY_PROBE_TASK ?? "";
const endpoint = new URL(process.env.POD_RECOVERY_PROBE_URL ?? "https://invalid.invalid");
if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname)
  || !/^pod-artwork-[a-f0-9-]{36}$/.test(queueName) || !/^[a-f0-9-]{36}$/.test(taskId)
  || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/pod") throw new Error("Unsafe POD acceptance probe");
const database = connectDatabase(), storage = createStorageFromEnvironment();
const holding: Storage = new Proxy(storage, { get(target, key) {
  if (key === "putPrivate") return async (...args: Parameters<Storage["putPrivate"]>) => {
    const stored = await target.putPrivate(...args);
    if (process.env.POD_RECOVERY_PROBE_HOLD === "1" && args[1].fileName.startsWith(`${taskId}-pod-output-`)) {
      process.stdout.write(JSON.stringify({ phase: "artifact_uploaded", taskId }) + "\n");
      await new Promise<void>(() => {});
    }
    return stored;
  };
  const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
} });
const repository = new DrizzlePodArtworkExecutionRepository(database, holding, createEnvironmentSecretVault("POD_EXECUTION_ENCRYPTION_KEY", "yummyai:pod-execution-v1"));
const gateway = new HttpPodArtworkGateway(endpoint.toString(), "synthetic-local-only", globalThis.fetch, 1024 * 1024, "synthetic-crash-probe-v1");
const worker = createWorker(queueName as typeof QueueName.PodArtwork, envelope => new PodArtworkProcessor(repository, gateway).process(envelope));
worker.on("failed", () => process.stdout.write(JSON.stringify({ phase: "failed", taskId }) + "\n"));
await worker.waitUntilReady();
process.stdout.write(JSON.stringify({ phase: "ready", taskId }) + "\n");
const close = async () => { await worker.close(); await database.client.end(); };
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
