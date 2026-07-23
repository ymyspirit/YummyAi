import { z } from "zod";

import { EntityIdSchema } from "../common/ids.js";

export const OrderFulfillmentPathSchema = z.enum(["template_ready", "designer_required", "customer_approval_required"]);
export const OrderCustomizationStatusSchema = z.enum([
  "incomplete", "ready", "awaiting_design", "awaiting_customer", "approved", "rejected", "quarantined",
]);
export const InitializeOrderCustomizationInputSchema = z.object({
  orderLineId: EntityIdSchema,
  fulfillmentPath: OrderFulfillmentPathSchema,
  customerApprovalDueAt: z.iso.datetime().optional(),
}).strict().superRefine((value, context) => {
  if (value.fulfillmentPath === "customer_approval_required" && !value.customerApprovalDueAt) {
    context.addIssue({ code: "custom", path: ["customerApprovalDueAt"], message: "Customer approval path requires a due time" });
  }
});

export const RemapOrderCustomizationInputSchema = z.object({
  expectedVersionNumber: z.number().int().positive(),
}).strict();

export const RegisterOrderCustomizationFileInputSchema = z.object({
  fieldKey: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
  fileName: z.string().trim().min(1).max(300),
  mediaType: z.string().trim().min(1).max(200),
  byteSize: z.number().int().positive().max(100_000_000),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  objectKey: z.string().trim().min(1).max(1_500),
}).strict();

export const RecordCustomizationFileScanInputSchema = z.object({
  result: z.enum(["clean", "infected", "failed"]),
  engine: z.string().trim().min(1).max(120),
  signatureVersion: z.string().trim().min(1).max(160),
  scannedAt: z.iso.datetime(),
}).strict();

export const CreateOrderProofInputSchema = z.object({
  customizationVersionId: EntityIdSchema,
  designVersionId: EntityIdSchema.nullable().default(null),
  dueAt: z.iso.datetime().optional(),
}).strict();

export const RecordCustomerProofDecisionInputSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  externalDecisionId: z.string().trim().min(1).max(300).regex(/^[A-Za-z0-9._:-]+$/),
  reasonCode: z.string().trim().min(1).max(160).regex(/^[A-Z0-9_]+$/).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === "rejected" && !value.reasonCode) {
    context.addIssue({ code: "custom", path: ["reasonCode"], message: "Rejected proof requires a reason code" });
  }
});

export const OrderCustomizationSummaryViewSchema = z.object({
  id: EntityIdSchema,
  orderId: EntityIdSchema,
  orderLineId: EntityIdSchema,
  schemaVersion: z.number().int().positive(),
  fulfillmentPath: OrderFulfillmentPathSchema,
  status: OrderCustomizationStatusSchema,
  versionId: EntityIdSchema,
  versionNumber: z.number().int().positive(),
  completeness: z.number().int().min(0).max(100),
  mappedFieldKeys: z.array(z.string()),
  missingFieldKeys: z.array(z.string()),
  fileFieldKeys: z.array(z.string()),
  customerApprovalDueAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();

export type OrderFulfillmentPath = z.infer<typeof OrderFulfillmentPathSchema>;
export type OrderCustomizationStatus = z.infer<typeof OrderCustomizationStatusSchema>;
export type InitializeOrderCustomizationInput = z.infer<typeof InitializeOrderCustomizationInputSchema>;
export type RemapOrderCustomizationInput = z.infer<typeof RemapOrderCustomizationInputSchema>;
export type RegisterOrderCustomizationFileInput = z.infer<typeof RegisterOrderCustomizationFileInputSchema>;
export type RecordCustomizationFileScanInput = z.infer<typeof RecordCustomizationFileScanInputSchema>;
export type CreateOrderProofInput = z.infer<typeof CreateOrderProofInputSchema>;
export type RecordCustomerProofDecisionInput = z.infer<typeof RecordCustomerProofDecisionInputSchema>;
export type OrderCustomizationSummaryView = z.infer<typeof OrderCustomizationSummaryViewSchema>;
