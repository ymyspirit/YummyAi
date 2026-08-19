import { z } from "zod";

import { EntityIdSchema } from "../common/ids.js";

export const ReviewStatusSchema = z.enum(["pending", "approved", "rejected", "invalidated"]);

export const SubmitReviewInputSchema = z.object({
  listingId: EntityIdSchema,
  listingVersionId: EntityIdSchema,
});

export const ReviewDecisionInputSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve") }),
  z.object({ decision: z.literal("reject"), reason: z.string().trim().min(3).max(2_000) }),
]);

export const ReviewRecordSchema = z.object({
  id: EntityIdSchema,
  tenantId: EntityIdSchema,
  listingId: EntityIdSchema,
  listingVersionId: EntityIdSchema,
  status: ReviewStatusSchema,
  submittedBy: EntityIdSchema,
  submittedAt: z.iso.datetime(),
  decidedBy: EntityIdSchema.optional(),
  decidedAt: z.iso.datetime().optional(),
  rejectionReason: z.string().optional(),
  invalidatedByVersionId: EntityIdSchema.optional(),
  invalidatedAt: z.iso.datetime().optional(),
});

export const ExportFileSchema = z.object({
  path: z.string().min(1).refine((path) => !path.startsWith("/") && !path.includes(".."), "path must remain inside the package"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  assetId: EntityIdSchema,
  assetVersion: z.int().positive(),
});

export const ExportManifestSchema = z.object({
  exportId: EntityIdSchema,
  tenantId: EntityIdSchema,
  platform: z.enum(["amazon", "etsy"]),
  listingId: EntityIdSchema,
  listingVersionId: EntityIdSchema,
  ruleVersion: z.string().min(1),
  files: z.array(ExportFileSchema),
  createdBy: EntityIdSchema,
  createdAt: z.iso.datetime(),
});

export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;
export type SubmitReviewInput = z.infer<typeof SubmitReviewInputSchema>;
export type ReviewDecisionInput = z.infer<typeof ReviewDecisionInputSchema>;
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;
export type ExportFile = z.infer<typeof ExportFileSchema>;
export type ExportManifest = z.infer<typeof ExportManifestSchema>;
