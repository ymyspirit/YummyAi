import { z } from "zod";
import { FactoryErpEvidenceSourceSchema } from "@yummyai/contracts/order/factory-erp-source-pin";

const Id = z.uuidv7().transform(value => value.toLowerCase());
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const FactoryErpVoidOutcomeSchema = z.enum(["confirmed_active", "confirmed_voided", "export_record_incorrect", "followup_required"]);
export const FactoryErpVoidReasonSchema = z.enum(["factory_contact", "corrected_export", "conflicting_records", "binding_mismatch", "needs_factory_confirmation"]);
const Attestation = z.object({ outcome: FactoryErpVoidOutcomeSchema, reasonCode: FactoryErpVoidReasonSchema });
function reasonMatches(value: z.infer<typeof Attestation>, context: z.RefinementCtx) {
  const concluded = value.reasonCode === "factory_contact" || value.reasonCode === "corrected_export";
  if ((value.outcome !== "followup_required") !== concluded)
    context.addIssue({ code: "custom", message: "A concluded review requires explicit factory contact or a checked corrected export; unresolved evidence remains follow-up" });
}
export const FactoryErpVoidObservationIdentitySchema = z.object({
  id: Id, sequence: z.int().positive(), importId: Id, rowNumber: z.int().min(2).max(5001), rowChecksum: Hash,
  fileChecksum: Hash, previewChecksum: Hash, recordedAt: z.iso.datetime(),
}).strict();
export type FactoryErpVoidObservationIdentity = z.infer<typeof FactoryErpVoidObservationIdentitySchema>;
export const ReviewFactoryErpVoidSchema = Attestation.extend({
  expectedBindingRevision: z.int().min(1).max(1_000_000), expectedItemsChecksum: Hash, expectedObservationSequence: z.int().positive(),
  observation: FactoryErpVoidObservationIdentitySchema, expectedPreviousReviewId: Id.nullable(), source: FactoryErpEvidenceSourceSchema,
  provenance: z.literal("operator_attested"), confirmed: z.literal(true), idempotencyKey: Id,
}).strict().superRefine((value, context) => {
  reasonMatches(value, context);
  if (value.observation.sequence > value.expectedObservationSequence)
    context.addIssue({ code: "custom", message: "The original void observation cannot be newer than the pinned binding history" });
});
export type ReviewFactoryErpVoid = z.infer<typeof ReviewFactoryErpVoidSchema>;
export const FactoryErpVoidReviewResultSchema = Attestation.extend({
  id: Id, bindingId: Id, factoryId: Id, observation: FactoryErpVoidObservationIdentitySchema, source: FactoryErpEvidenceSourceSchema,
  originalBindingRevision: z.int().positive(), originalItemsChecksum: Hash, originalObservationSequence: z.int().positive(),
  reviewRevision: z.int().min(1).max(1_000_000), previousReviewId: Id.nullable(), provenance: z.literal("operator_attested"),
  requestChecksum: Hash, createdAt: z.iso.datetime(),
}).strict().superRefine((value, context) => {
  reasonMatches(value, context);
  if ((value.reviewRevision === 1) !== (value.previousReviewId === null) || value.observation.sequence > value.originalObservationSequence)
    context.addIssue({ code: "custom", message: "Review receipts preserve the exact original observation and linear previous review" });
});
export type FactoryErpVoidReviewResult = z.infer<typeof FactoryErpVoidReviewResultSchema>;
export const FactoryErpVoidObservationViewSchema = FactoryErpVoidObservationIdentitySchema.extend({
  sourceReadable: z.boolean(), latestReview: FactoryErpVoidReviewResultSchema.nullable(), pending: z.boolean(), requiresOrderHandling: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.latestReview && !(Object.keys(value.latestReview.observation) as (keyof FactoryErpVoidObservationIdentity)[]).every(key => value.latestReview!.observation[key] === value[key]) ||
      value.pending !== (value.latestReview === null || value.latestReview.outcome === "followup_required") ||
      value.requiresOrderHandling !== (value.latestReview?.outcome === "confirmed_voided"))
    context.addIssue({ code: "custom", message: "Only the latest review of this exact void observation determines its review state" });
});
export type FactoryErpVoidObservationView = z.infer<typeof FactoryErpVoidObservationViewSchema>;
export const FactoryErpVoidSummarySchema = z.object({
  total: z.int().nonnegative(), pending: z.int().nonnegative(), requiresOrderHandling: z.int().nonnegative(),
  latest: FactoryErpVoidObservationViewSchema.nullable(), nextPending: FactoryErpVoidObservationViewSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.pending + value.requiresOrderHandling > value.total || (value.total === 0) !== (value.latest === null) ||
      (value.pending === 0) !== (value.nextPending === null) || value.nextPending && !value.nextPending.pending)
    context.addIssue({ code: "custom", message: "Complete summary counts and pending navigation must agree" });
});
export type FactoryErpVoidSummary = z.infer<typeof FactoryErpVoidSummarySchema>;
export const FactoryErpVoidBasisSchema = z.object({
  bindingId: Id, factoryId: Id, bindingRevision: z.int().positive(), itemsChecksum: Hash, state: z.enum(["active", "released"]),
  observationSequence: z.int().nonnegative(), summary: FactoryErpVoidSummarySchema,
}).strict().superRefine((value, context) => {
  for (const observation of [value.summary.latest, value.summary.nextPending]) if (observation && (observation.sequence > value.observationSequence ||
      observation.latestReview && (observation.latestReview.bindingId !== value.bindingId || observation.latestReview.factoryId !== value.factoryId || observation.latestReview.originalBindingRevision !== value.bindingRevision || observation.latestReview.originalItemsChecksum !== value.itemsChecksum)))
    context.addIssue({ code: "custom", message: "A binding summary cannot adopt another original group or a future observation" });
});
export const FactoryErpVoidObservationPageQuerySchema = z.object({ cursor: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();
export const FactoryErpVoidObservationPageSchema = z.object({ basis: FactoryErpVoidBasisSchema, items: z.array(FactoryErpVoidObservationViewSchema).max(100), nextCursor: z.int().positive().nullable() }).strict();
export const FactoryErpVoidObservationDetailSchema = z.object({ basis: FactoryErpVoidBasisSchema, observation: FactoryErpVoidObservationViewSchema }).strict();
export const FactoryErpVoidReviewPageQuerySchema = z.object({ cursor: Id.optional(), observationId: Id.optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();
export const FactoryErpVoidReviewPageSchema = z.object({ items: z.array(FactoryErpVoidReviewResultSchema).max(100), nextCursor: Id.nullable() }).strict();
