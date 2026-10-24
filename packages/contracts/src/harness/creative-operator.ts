import { z } from "zod";
import { CreativeExecutionKindSchema, HarnessUsdSchema } from "@yummyai/contracts/harness";
import { AgentMethodSelectionSchema } from "@yummyai/contracts/harness/methods";

const Id = z.uuidv7();
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Cost = z.object({
  basis: z.enum(["not_applicable", "not_submitted", "unknown", "processor_reported"]),
  amountUsd: HarnessUsdSchema.nullable(), budgetState: z.enum(["reserved", "committed", "released"]).nullable(),
  budgetAmountUsd: HarnessUsdSchema.nullable(), providerInvoiceVerified: z.literal(false),
}).strict().superRefine((value, context) => {
  if ((value.basis === "processor_reported") !== (value.amountUsd !== null))
    context.addIssue({ code: "custom", path: ["amountUsd"], message: "Only the original service report can carry an amount" });
});
export const CreativeHistoryScopeSchema = z.enum(["design_batch", "inspection", "mockup_batch", "studio_generation"]);
export const CreativeHistoryQuerySchema = z.object({ after: Id.optional() }).strict();
export const CreativeOperatorCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request_recovery"), commandId: z.uuid(), expectedFingerprint: Hash }).strict(),
  z.object({
    action: z.literal("record_check"), commandId: z.uuid(), expectedFingerprint: Hash,
    finding: z.enum(["provider_pending", "provider_failed", "response_located", "needs_owner_review"]),
    proofChecksum: Hash, matchesOriginalRequest: z.literal(true),
  }).strict(),
]);
export const CreativeOperatorEventSchema = z.object({
  id: Id, action: z.enum(["request_recovery", "record_check"]), recordedAt: z.iso.datetime(),
  finding: z.enum(["provider_pending", "provider_failed", "response_located", "needs_owner_review"]).nullable(),
  proofChecksum: Hash.nullable(), verification: z.literal("operator_attested"),
}).strict();
export const CreativeExecutionViewSchema = z.object({
  id: Id, parentId: Id.nullable(), kind: CreativeExecutionKindSchema, stepKey: z.string().max(160),
  phase: z.enum(["pending", "preparing", "submitted", "response_staging", "response_ready", "completed", "failed", "uncertain"]),
  fingerprint: Hash, inputFingerprint: Hash, method: AgentMethodSelectionSchema.nullable(),
  processingAttempts: z.int().nonnegative().max(3), dispatches: z.int().nonnegative(),
  createdAt: z.iso.datetime(), submittedAt: z.iso.datetime().nullable(), receivedAt: z.iso.datetime().nullable(),
  providerRequestId: z.string().max(512).nullable(), responseChecksum: Hash.nullable(),
  responseState: z.enum(["missing", "retained", "expired", "purged"]),
  cost: Cost,
  artifacts: z.array(z.object({ assetId: Id, version: z.int().positive(), checksumSha256: Hash }).strict()).max(100),
  unavailableArtifacts: z.int().nonnegative(), completionChecksum: Hash.nullable(), errorCode: z.string().max(160).nullable(),
  canRequestRecovery: z.boolean(), recoveryBlockers: z.array(z.string().max(240)).max(10), canRecordCheck: z.boolean(),
  events: z.array(CreativeOperatorEventSchema).max(10), hasMoreEvents: z.boolean(),
}).strict();
export const CreativeExecutionHistorySchema = z.object({
  scope: CreativeHistoryScopeSchema, ownerId: Id, entries: z.array(CreativeExecutionViewSchema).max(20), nextCursor: Id.nullable(),
}).strict();
export type CreativeHistoryScope = z.infer<typeof CreativeHistoryScopeSchema>;
export type CreativeExecutionView = z.infer<typeof CreativeExecutionViewSchema>;
export type CreativeExecutionHistory = z.infer<typeof CreativeExecutionHistorySchema>;
export type CreativeOperatorCommand = z.infer<typeof CreativeOperatorCommandSchema>;
