import { z } from "zod";

const IdempotencyKeySchema = z.string().trim().min(8).max(200);
const NullableTextSchema = z.string().trim().min(1).max(500).nullable();

export const AfterSalesCaseTypeSchema = z.enum([
  "customer_contact",
  "refund_request",
  "return_request",
  "replacement_request",
  "delivery_issue",
  "quality_issue",
]);

export const AfterSalesCaseStatusSchema = z.enum([
  "open",
  "awaiting_customer",
  "awaiting_internal",
  "approved",
  "rejected",
  "resolved",
  "cancelled",
]);

export const CreateAfterSalesCaseInputSchema = z.object({
  type: AfterSalesCaseTypeSchema,
  reasonCode: z.string().trim().min(1).max(100),
  summary: z.string().trim().min(1).max(2_000),
  idempotencyKey: IdempotencyKeySchema,
});

export const CustomerContactChannelSchema = z.enum(["marketplace", "email", "phone", "internal"]);
export const CustomerContactDirectionSchema = z.enum(["inbound", "outbound", "internal"]);

export const RecordCustomerContactInputSchema = z.object({
  channel: CustomerContactChannelSchema,
  direction: CustomerContactDirectionSchema,
  body: z.string().trim().min(1).max(50_000),
  externalMessageId: NullableTextSchema,
  occurredAt: z.iso.datetime(),
  idempotencyKey: IdempotencyKeySchema,
});

export const AfterSalesResolutionSchema = z.enum([
  "no_action",
  "full_refund",
  "partial_refund",
  "return_and_refund",
  "replacement",
]);

export const AfterSalesResponsibilityPartySchema = z.enum([
  "customer",
  "marketplace",
  "carrier",
  "supplier",
  "internal",
  "undetermined",
]);

export const DecideAfterSalesCaseInputSchema = z.object({
  resolution: AfterSalesResolutionSchema,
  refundAmountMinor: z.number().int().nonnegative().nullable(),
  refundCurrency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  returnRequired: z.boolean(),
  responsibilityParty: AfterSalesResponsibilityPartySchema,
  reasonCode: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1).max(10_000),
  expectedDecisionVersion: z.number().int().nonnegative(),
  idempotencyKey: IdempotencyKeySchema,
}).superRefine((value, context) => {
  const needsRefund = ["full_refund", "partial_refund", "return_and_refund"].includes(value.resolution);
  if (needsRefund && (value.refundAmountMinor === null || value.refundCurrency === null)) {
    context.addIssue({ code: "custom", message: "Refund resolution requires amount and currency", path: ["refundAmountMinor"] });
  }
  if (!needsRefund && (value.refundAmountMinor !== null || value.refundCurrency !== null)) {
    context.addIssue({ code: "custom", message: "Non-refund resolution cannot include refund money", path: ["refundAmountMinor"] });
  }
  if (value.resolution === "return_and_refund" && !value.returnRequired) {
    context.addIssue({ code: "custom", message: "Return-and-refund requires a return", path: ["returnRequired"] });
  }
});

export const CreateReturnShipmentInputSchema = z.object({
  carrierCode: z.string().trim().min(1).max(80),
  trackingNumber: z.string().trim().min(1).max(200),
  labelAssetId: z.uuidv7().nullable(),
  idempotencyKey: IdempotencyKeySchema,
});

export const RecordReturnTrackingEventInputSchema = z.object({
  status: z.enum(["label_created", "in_transit", "delivered", "lost", "cancelled"]),
  provider: z.string().trim().min(1).max(100),
  externalEventId: z.string().trim().min(1).max(200),
  detailCode: z.string().trim().min(1).max(100),
  occurredAt: z.iso.datetime(),
});

export const LinkReplacementOrderInputSchema = z.object({
  replacementOrderId: z.uuidv7(),
  reason: z.string().trim().min(1).max(2_000),
  idempotencyKey: IdempotencyKeySchema,
});

export const AddResponsibilityEvidenceInputSchema = z.object({
  party: AfterSalesResponsibilityPartySchema,
  code: z.string().trim().min(1).max(100),
  detail: z.string().trim().min(1).max(10_000),
  assetId: z.uuidv7().nullable(),
  idempotencyKey: IdempotencyKeySchema,
});

export type CreateAfterSalesCaseInput = z.infer<typeof CreateAfterSalesCaseInputSchema>;
export type RecordCustomerContactInput = z.infer<typeof RecordCustomerContactInputSchema>;
export type DecideAfterSalesCaseInput = z.infer<typeof DecideAfterSalesCaseInputSchema>;
export type CreateReturnShipmentInput = z.infer<typeof CreateReturnShipmentInputSchema>;
export type RecordReturnTrackingEventInput = z.infer<typeof RecordReturnTrackingEventInputSchema>;
export type LinkReplacementOrderInput = z.infer<typeof LinkReplacementOrderInputSchema>;
export type AddResponsibilityEvidenceInput = z.infer<typeof AddResponsibilityEvidenceInputSchema>;
