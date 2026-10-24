import { createHash } from "node:crypto";
import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { StoreNodeExecutionLeaseSchema, StoreNodeExecutionPermitSchema, StoreNodeExecutionRequestClassSchema,
  StoreNodeExecutionCheckpointInputSchema, StoreNodeExecutionCompleteInputSchema, type StoreNodeExecutionLease } from "@yummyai/contracts/marketplace/store-node-execution";
import { nodeCheck } from "./error.js";
import { openStoreNodeJournal, sealStoreNodeJournal } from "./identity.js";
import { readStoreNodeJournal, type StoreNodeLocalLock } from "./storage.js";

const ResponseSchema = z.object({ status: z.int().min(100).max(599), contentType: z.string().max(512), retryAfter: z.string().max(512).nullable(),
  amazonRateLimit: z.string().max(512).optional(), body: z.string().max(24 * 1024 * 1024) }).strict();
const RowSchema = z.object({ stepId: EntityIdSchema, ordinal: z.int().min(1).max(128), requestClass: StoreNodeExecutionRequestClassSchema,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(["prepared", "submitted", "received", "unknown", "not_sent"]),
  permit: StoreNodeExecutionPermitSchema.nullable(), response: ResponseSchema.nullable(), stepAcknowledged: z.boolean() }).strict();
const JournalSchema = z.object({ version: z.literal(1), lease: StoreNodeExecutionLeaseSchema, rows: z.array(RowSchema).max(128),
  checkpoint: StoreNodeExecutionCheckpointInputSchema.nullable(), checkpointAcknowledged: z.boolean(),
  completion: StoreNodeExecutionCompleteInputSchema.nullable(), completed: z.boolean() }).strict();
export type StoreNodeExecutionJournalData = z.infer<typeof JournalSchema>;
export type StoreNodeExecutionJournalRow = z.infer<typeof RowSchema>;
export class StoreNodeExecutionJournal {
  private queue = Promise.resolve();
  private constructor(readonly data: StoreNodeExecutionJournalData, private readonly persist: (value: StoreNodeExecutionJournalData) => Promise<void>) {}
  static async open(options: { directory: string; passphrase: string; spki: string; lock: StoreNodeLocalLock }): Promise<StoreNodeExecutionJournal | null> {
    const bytes = await readStoreNodeJournal(options.directory); if (!bytes) return null;
    try { return this.from(JournalSchema.parse(await openStoreNodeJournal(bytes, options.passphrase, options.spki)), options); }
    finally { bytes.fill(0); }
  }
  static async create(lease: StoreNodeExecutionLease, options: { passphrase: string; spki: string; lock: StoreNodeLocalLock }): Promise<StoreNodeExecutionJournal> {
    const journal = this.from({ version: 1, lease, rows: [], checkpoint: null, checkpointAcknowledged: false, completion: null, completed: false }, options);
    await journal.update(() => undefined); return journal;
  }
  private static from(data: StoreNodeExecutionJournalData, options: { passphrase: string; spki: string; lock: StoreNodeLocalLock }) {
    return new StoreNodeExecutionJournal(data, async value => {
      const bytes = await sealStoreNodeJournal(JournalSchema.parse(value), options.passphrase, options.spki);
      try { nodeCheck(bytes.length <= 64 * 1024 * 1024, "store_node_result_too_large"); await options.lock.commitJournal(bytes); }
      finally { bytes.fill(0); }
    });
  }
  update<T>(action: (data: StoreNodeExecutionJournalData) => T): Promise<T> {
    const result = this.queue.then(async () => { const value = action(this.data); await this.persist(this.data); return value; });
    this.queue = result.then(() => undefined, () => undefined); return result;
  }
}
export async function cacheStoreNodeResponse(response: Response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  try {
    nodeCheck(bytes.length <= 16 * 1024 * 1024, "store_node_result_too_large");
    return { status: response.status, contentType: response.headers.get("content-type") ?? "application/json", retryAfter: response.headers.get("retry-after"),
      ...(response.headers.has("x-amzn-ratelimit-limit") ? { amazonRateLimit: response.headers.get("x-amzn-ratelimit-limit")! } : {}),
      body: bytes.toString("base64"), responseDigest: createHash("sha256").update(bytes).digest("hex") };
  } finally { bytes.fill(0); }
}
export function replayStoreNodeResponse(value: z.infer<typeof ResponseSchema>): Response {
  const bytes = Buffer.from(value.body, "base64");
  nodeCheck(bytes.toString("base64") === value.body && bytes.length <= 16 * 1024 * 1024, "store_node_execution_failed");
  return new Response(bytes, { status: value.status, headers: { "content-type": value.contentType, ...(value.retryAfter ? { "retry-after": value.retryAfter } : {}),
    ...(value.amazonRateLimit !== undefined ? { "x-amzn-ratelimit-limit": value.amazonRateLimit } : {}) } });
}
