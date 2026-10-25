import { z } from "zod";
import { HarnessUsdSchema } from "@yummyai/contracts/harness";

const Id = z.uuidv7();
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const CREATIVE_RESPONSE_ADOPTION_VERSION = "creative-response-adoption-v1" as const;
export const CREATIVE_RESPONSE_ADOPTION_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
export const CREATIVE_RESPONSE_ADOPTION_BASIS_HEADER = "x-yummyai-creative-response-basis";
export const CREATIVE_RESPONSE_ADOPTION_CHECKSUM_HEADER = "x-yummyai-response-checksum";
export const CREATIVE_RESPONSE_ADOPTION_ARTIFACT_HEADER = "x-yummyai-artifact-checksum";
export const CreativeResponseAdoptionCommandSchema = z.object({
  requestId: z.uuid(), expectedBasis: Hash, acknowledgeReviewRequired: z.literal(true),
}).strict();
export const CreativeResponseAdoptionCancelSchema = z.object({ requestId: z.uuid() }).strict();
export const CreativeResponseAdoptionArtifactSchema = z.object({
  assetId: Id, version: z.literal(1), checksumSha256: Hash,
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/tiff"]),
  width: z.int().positive(), height: z.int().positive(),
}).strict();
export const CreativeResponseAdoptionReceiptSchema = z.object({
  version: z.literal(CREATIVE_RESPONSE_ADOPTION_VERSION), id: Id, executionId: Id, requestId: z.uuid(),
  basis: Hash, candidateId: Id, originalPhase: z.enum(["failed", "uncertain"]),
  inputFingerprint: Hash, responseChecksum: Hash, encryptedChecksum: Hash,
  artifact: CreativeResponseAdoptionArtifactSchema, modelKey: z.string().min(1).max(160),
  modelVersion: z.string().min(1).max(160), originalCostUsd: HarnessUsdSchema.nullable(),
  disposition: z.literal("generated"), rightsStatus: z.literal("unverified"),
  approval: z.literal("review_required"), committedAt: z.iso.datetime(),
}).strict();
export const CreativeResponseAdoptionRequestViewSchema = z.object({
  id: Id, executionId: Id, requestId: z.uuid(), command: CreativeResponseAdoptionCommandSchema,
  status: z.enum(["prepared", "processing", "committed", "cancelled"]),
  attempts: z.int().nonnegative().max(3), leaseActive: z.boolean(),
  canRetry: z.boolean(), canCancel: z.boolean(), errorCode: z.string().max(100).nullable(),
  artifactCleanup: z.enum(["not_required", "pending", "complete", "registered"]),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), receipt: CreativeResponseAdoptionReceiptSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.requestId !== value.command.requestId || (value.status === "committed") !== (value.receipt !== null))
    ctx.addIssue({ code: "custom", message: "The request and committed receipt must retain their original identity" });
  if (value.receipt && (value.receipt.id !== value.id || value.receipt.executionId !== value.executionId
    || value.receipt.requestId !== value.requestId || value.receipt.basis !== value.command.expectedBasis))
    ctx.addIssue({ code: "custom", message: "The receipt must belong to the exact original adoption request" });
});
export const CreativeResponseAdoptionWorkspaceSchema = z.object({
  version: z.literal(CREATIVE_RESPONSE_ADOPTION_VERSION), executionId: Id, candidateId: Id, batchId: Id, identityStamp: Hash,
  kind: z.literal("creative_candidate"), stepKey: z.literal("generate"),
  originalPhase: z.enum(["pending", "preparing", "submitted", "response_staging", "response_ready", "completed", "failed", "uncertain"]),
  candidateStatus: z.string().max(60), basis: Hash.nullable(), canInspectOriginal: z.boolean(), canAdopt: z.boolean(),
  blockers: z.array(z.string().min(1).max(240)).max(16),
  source: z.object({
    inputFingerprint: Hash, responseChecksum: Hash.nullable(), encryptedChecksum: Hash.nullable(),
    archiveState: z.enum(["registered_unverified", "missing", "expired", "purged"]),
    archiveExpiresAt: z.iso.datetime().nullable(), providerRequestId: z.string().max(512).nullable(),
    receivedAt: z.iso.datetime().nullable(), modelKey: z.string().max(160).nullable(),
    modelVersion: z.string().max(160).nullable(), originalCostUsd: HarnessUsdSchema.nullable(),
    providerInvoiceVerified: z.literal(false),
  }).strict(),
  // One immutable adoption fact per original execution, indexed on the server.
  requests: z.array(CreativeResponseAdoptionRequestViewSchema).max(1),
  noNewModelCall: z.literal(true), resultRequiresReview: z.literal(true),
}).strict();

export type CreativeResponseAdoptionCommand = z.infer<typeof CreativeResponseAdoptionCommandSchema>;
export type CreativeResponseAdoptionReceipt = z.infer<typeof CreativeResponseAdoptionReceiptSchema>;
export type CreativeResponseAdoptionRequestView = z.infer<typeof CreativeResponseAdoptionRequestViewSchema>;
export type CreativeResponseAdoptionWorkspace = z.infer<typeof CreativeResponseAdoptionWorkspaceSchema>;
