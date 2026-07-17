import { fileURLToPath } from "node:url";

import { Queue, type ConnectionOptions } from "bullmq";
import { config } from "dotenv";

import { JobEnvelopeSchema, type JobEnvelope } from "./contracts.js";
import type { QueueName } from "./queues.js";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

export function redisConnection(redisUrl = required("REDIS_URL")): ConnectionOptions {
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    password: parsed.password || undefined,
  };
}

export function createQueue(name: QueueName, redisUrl?: string): Queue {
  return new Queue(name, { connection: redisConnection(redisUrl) });
}

export async function enqueueJob(
  queue: Queue,
  name: string,
  envelope: JobEnvelope,
) {
  const validated = JobEnvelopeSchema.parse(envelope);
  return queue.add(name, validated, {
    attempts: validated.maxAttempts - validated.attempt,
    jobId: validated.idempotencyKey,
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: { age: 604_800, count: 5_000 },
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
