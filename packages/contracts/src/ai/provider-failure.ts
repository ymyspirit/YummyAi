import { z } from "zod";

/** Safe transport metadata only. Provider messages, prompts and response bodies
 * are intentionally excluded from persisted and browser-visible diagnostics. */
export const ModelProviderHttpFailureSchema = z.object({
  version: z.literal(1),
  status: z.int().min(400).max(599),
  kind: z.enum(["moderation", "rate_limit", "authentication", "invalid_request", "unavailable", "unknown"]),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/).nullable(),
  providerRequestId: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/).nullable(),
  receivedAt: z.iso.datetime(),
  retryAfterMs: z.int().min(0).max(86_400_000).nullable(),
}).strict();
export type ModelProviderHttpFailure = z.infer<typeof ModelProviderHttpFailureSchema>;
