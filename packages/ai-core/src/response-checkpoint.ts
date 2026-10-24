import { z } from "zod";
import type { ModelResult } from "./provider.js";
import { parseStructuredOutput } from "./providers/shared.js";

/** Private response data. Persist encrypted before interpreting model content. */
export const ModelResponseCheckpointSchema = z
  .object({
    version: z.literal("model-response-v1"),
    providerId: z.string().min(1),
    modelKey: z.string().min(1),
    providerRequestId: z.string().max(512).nullable(),
    payload: z.unknown(),
    inputTokens: z.int().nonnegative().nullable(),
    outputTokens: z.int().nonnegative().nullable(),
    costUsd: z.number().nonnegative().nullable(),
    receivedAt: z.iso.datetime(),
  })
  .strict();
export type ModelResponseCheckpoint = z.infer<typeof ModelResponseCheckpointSchema>;

export function decodeModelResponse<T>(
  raw: ModelResponseCheckpoint,
  schema: z.ZodType<T>,
): ModelResult<T> {
  const saved = ModelResponseCheckpointSchema.parse(raw);
  return {
    providerId: saved.providerId,
    modelKey: saved.modelKey,
    providerRequestId: saved.providerRequestId ?? undefined,
    value: parseStructuredOutput(saved.payload, schema),
    inputTokens: saved.inputTokens ?? 0,
    outputTokens: saved.outputTokens ?? 0,
    usageReported: saved.inputTokens !== null && saved.outputTokens !== null,
    costUsd: saved.costUsd,
    completedAt: new Date(saved.receivedAt),
  };
}
