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
): Worker {
  const wrapped: Processor = async (job) => {
    const envelope = JobEnvelopeSchema.parse(job.data);
    return processor(JobEnvelopeSchema.parse({ ...envelope, attempt: job.attemptsMade }));
  };
  return new Worker(queueName, wrapped, {
    connection: redisConnection(redisUrl),
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
