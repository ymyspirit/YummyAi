import {
  JobEnvelopeSchema,
  redisConnection,
  type JobEnvelope,
  type QueueNameValue,
} from "@yummyai/jobs";
import { Worker, type Processor } from "bullmq";

export type EnvelopeProcessor = (envelope: JobEnvelope) => Promise<unknown>;

export function createWorker(
  queueName: QueueNameValue,
  processor: EnvelopeProcessor,
  redisUrl = required("REDIS_URL"),
  options: { autorun?: boolean; name?: string } = {},
): Worker {
  const wrapped: Processor = async (job) => {
    const envelope = JobEnvelopeSchema.parse(job.data);
    return processor(JobEnvelopeSchema.parse({ ...envelope, attempt: job.attemptsMade }));
  };
  return new Worker(queueName, wrapped, {
    autorun: options.autorun ?? true,
    ...(options.name === undefined ? {} : { name: options.name }),
    connection: redisConnection(redisUrl),
    settings: { backoffStrategy: providerAwareBackoff },
  });
}

export function providerAwareBackoff(attemptsMade: number, type?: string, error?: Error): number {
  if (type !== "provider-aware") {
    throw new Error(`Unsupported Worker backoff strategy: ${type ?? "missing"}`);
  }
  const exponentialMs = 5_000 * 2 ** Math.max(0, attemptsMade - 1);
  const retryAfterMs = Number((error as Error & { retryAfterMs?: unknown } | undefined)?.retryAfterMs);
  const requestedMs = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : 0;
  return Math.min(Math.max(exponentialMs, requestedMs), 15 * 60 * 1_000);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
