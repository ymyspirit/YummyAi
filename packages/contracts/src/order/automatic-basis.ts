import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";

/** Read-only matching result. Applying a draft never approves manufacturing. */
export const OrderAutomaticBasisSchema = z.object({
  status: z.enum(["matched", "partial", "missing", "ambiguous", "preserved", "conflict"]),
  sourceVersionId: Id.nullable(),
  sizeInches: z.number().positive().nullable(),
  spuId: Id.nullable(),
  specificationVersionId: Id.nullable(),
  processProfileVersionId: Id.nullable(),
  artworkVersionId: Id.nullable().optional(),
  applied: z.boolean(),
  reasons: z.array(z.string()),
  issues: z.array(z.string()),
}).strict();
export type OrderAutomaticBasis = z.infer<typeof OrderAutomaticBasisSchema>;

export const OrderShippingTimeSchema = z.object({
  computedAt: z.iso.datetime(),
  platform: z.object({
    at: z.iso.datetime().nullable(),
    source: z.enum(["verified_record", "marketplace_api", "report_import", "missing"]),
    verifiedAt: z.iso.datetime().nullable(),
    sourceVersionId: Id.nullable(),
  }).strict(),
  internal: z.object({
    at: z.iso.datetime().nullable(),
    source: z.enum(["operator", "missing"]),
    confidence: z.enum(["explicit", "unknown"]),
    evidenceReference: z.string().nullable(),
  }).strict(),
  nextAttentionAt: z.iso.datetime().nullable(),
  countdownBasis: z.literal("platform").nullable(),
  remainingSeconds: z.number().int().nullable(),
  platformOverdue: z.boolean(),
  internalOverdue: z.boolean(),
  active: z.boolean(),
  missingReasons: z.array(z.string()),
}).strict();
export type OrderShippingTime = z.infer<typeof OrderShippingTimeSchema>;
