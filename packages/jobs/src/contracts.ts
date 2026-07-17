import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";

export const JobEnvelopeSchema = z
  .object({
    jobId: EntityIdSchema,
    tenantId: EntityIdSchema,
    requestedBy: EntityIdSchema,
    correlationId: EntityIdSchema,
    idempotencyKey: EntityIdSchema,
    requestedAt: z.iso.datetime().default(() => new Date().toISOString()),
    attempt: z.int().min(0).default(0),
    maxAttempts: z.int().positive().max(20).default(3),
    payload: z.unknown(),
  })
  .superRefine((value, context) => {
    if (value.attempt >= value.maxAttempts) {
      context.addIssue({
        code: "custom",
        message: "attempt must be lower than maxAttempts",
        path: ["attempt"],
      });
    }
  });

export type JobEnvelope = z.infer<typeof JobEnvelopeSchema>;
