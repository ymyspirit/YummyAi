import { SecretVault } from "../../packages/ai-core/src/index.js";
import { connectDatabase } from "../../packages/database/src/client.js";
import { createStorageFromEnvironment, type Storage } from "../../packages/storage/src/index.js";
import { createWorker } from "../../apps/worker/src/main.js";
import { StudioGenerationProcessor } from "../../apps/worker/src/processors/studio-generation.processor.js";
import { HttpStudioGateway } from "../../apps/worker/src/processors/studio-generation.gateway.js";
import { QueueName } from "../../packages/jobs/src/queues.js";

// Disposable acceptance process. It cannot consume a normal queue or call a remote provider.
const queueName = process.env.CREATIVE_RECOVERY_PROBE_QUEUE ?? "";
const executionId = process.env.CREATIVE_RECOVERY_PROBE_EXECUTION ?? "";
const endpoint = new URL(process.env.CREATIVE_RECOVERY_PROBE_URL ?? "https://invalid.invalid");
if (process.env.E2E_ISOLATED_DAILY !== "1"
  || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname)
  || !/^studio-generation-[a-f0-9-]{36}$/.test(queueName) || !/^[a-f0-9-]{36}$/.test(executionId)
  || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port
  || endpoint.pathname !== "/v1" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
  throw new Error("Unsafe creative recovery acceptance process");
const database = connectDatabase(), storage = createStorageFromEnvironment();
const holding: Storage = new Proxy(storage, { get(target, key) {
  if (key === "putPrivate") return async (...args: Parameters<Storage["putPrivate"]>) => {
    const stored = await target.putPrivate(...args);
    if (process.env.CREATIVE_RECOVERY_PROBE_HOLD === "1" && args[1].fileName.startsWith(`${executionId}-pod-output-`)) {
      process.stdout.write(JSON.stringify({ phase: "artifact_uploaded", executionId }) + "\n");
      await new Promise<void>(() => {});
    }
    return stored;
  };
  const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
} });
const transport: typeof fetch = (input, options) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== endpoint.origin || !url.pathname.startsWith("/v1/")) throw new Error("Recovery probe refused remote provider");
  return globalThis.fetch(input, options);
};
const processor = new StudioGenerationProcessor(database, holding, new SecretVault(Buffer.alloc(32, 37)),
  new HttpStudioGateway(transport, 1), undefined, new SecretVault(Buffer.alloc(32, 43)));
const worker = createWorker(queueName as typeof QueueName.StudioGeneration, envelope => processor.process(envelope));
for (const phase of ["completed", "failed"] as const)
  worker.on(phase, () => process.stdout.write(JSON.stringify({ phase, executionId }) + "\n"));
await worker.waitUntilReady();
process.stdout.write(JSON.stringify({ phase: "ready", executionId }) + "\n");
const close = async () => { await worker.close(); await database.client.end(); };
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
