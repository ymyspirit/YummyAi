import { z } from "zod";

const EntityIdSchema = z.uuidv7();
const IdempotencyKeySchema = z.string().trim().min(8).max(200);
const CodeSchema = z.string().trim().min(1).max(64).regex(/^[A-Z0-9][A-Z0-9._-]*$/);
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
const QuantitySchema = z.number().int().positive().max(2_147_483_647);
const NonNegativeQuantitySchema = z.number().int().nonnegative().max(2_147_483_647);
const MoneyMinorSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const ProcurementUnitSchema = z.enum(["each", "pair", "set", "meter", "gram", "kilogram"]);
export const ProcurementRequisitionStatusSchema = z.enum(["draft", "rfq_open", "ordered", "cancelled"]);
export const ProcurementRfqStatusSchema = z.enum(["open", "closed", "cancelled"]);
export const InventoryPurchaseOrderStatusSchema = z.enum([
  "draft",
  "approved",
  "rejected",
  "partially_received",
  "received",
  "reconciliation_required",
  "cancelled",
]);
export const ProcurementInvoiceStatusSchema = z.enum(["matched", "reconciliation_required"]);
export const ReplenishmentSuggestionStatusSchema = z.enum(["open", "converted", "dismissed"]);

export const ProcurementRequestLineSchema = z.object({
  lineKey: CodeSchema,
  stockItemId: EntityIdSchema,
  destinationLocationId: EntityIdSchema,
  quantity: QuantitySchema,
  unit: ProcurementUnitSchema,
}).strict();

export const ProcurementPurchaseLineSchema = ProcurementRequestLineSchema.extend({
  unitCostMinor: MoneyMinorSchema,
}).strict();

export const CreateProcurementRequisitionInputSchema = z.object({
  code: CodeSchema,
  reasonCode: CodeSchema,
  lines: z.array(ProcurementRequestLineSchema).min(1).max(200),
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => uniqueLineKeys(value.lines, context));

export const CreateProcurementRfqInputSchema = z.object({
  expectedRequisitionVersion: z.number().int().positive(),
  supplierIds: z.array(EntityIdSchema).min(1).max(20),
  responseDueAt: z.iso.datetime(),
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.supplierIds).size !== value.supplierIds.length) {
    context.addIssue({ code: "custom", message: "Supplier IDs must be unique", path: ["supplierIds"] });
  }
});

export const SupplierQuoteLineSchema = z.object({
  lineKey: CodeSchema,
  unitCostMinor: MoneyMinorSchema,
  minimumOrderQuantity: QuantitySchema,
  leadTimeDays: z.number().int().nonnegative().max(3650),
}).strict();

export const RecordProcurementSupplierQuoteInputSchema = z.object({
  supplierId: EntityIdSchema,
  currency: CurrencySchema,
  validUntil: z.iso.datetime(),
  lines: z.array(SupplierQuoteLineSchema).min(1).max(200),
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => uniqueLineKeys(value.lines, context));

export const CreateInventoryPurchaseOrderInputSchema = z.object({
  code: CodeSchema,
  supplierId: EntityIdSchema,
  requisitionId: EntityIdSchema.nullable(),
  quoteId: EntityIdSchema.nullable(),
  currency: CurrencySchema,
  expectedAt: z.iso.datetime(),
  lines: z.array(ProcurementPurchaseLineSchema).min(1).max(200),
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => uniqueLineKeys(value.lines, context));

export const ReviseInventoryPurchaseOrderInputSchema = z.object({
  expectedVersion: z.number().int().positive(),
  currency: CurrencySchema,
  expectedAt: z.iso.datetime(),
  lines: z.array(ProcurementPurchaseLineSchema).min(1).max(200),
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => uniqueLineKeys(value.lines, context));

export const ReviewInventoryPurchaseOrderInputSchema = z.object({
  expectedVersion: z.number().int().positive(),
  decision: z.enum(["approved", "rejected"]),
  reasonCode: CodeSchema,
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const ProcurementReceiptLineInputSchema = z.object({
  lineKey: CodeSchema,
  receivedQuantity: NonNegativeQuantitySchema,
  rejectedQuantity: NonNegativeQuantitySchema,
  rejectionReasonCode: CodeSchema.nullable(),
  lotCode: CodeSchema.nullable(),
  expiresAt: z.iso.datetime().nullable(),
}).strict().superRefine((value, context) => {
  if (value.receivedQuantity + value.rejectedQuantity <= 0) {
    context.addIssue({ code: "custom", message: "Receipt line must receive or reject stock" });
  }
  if (value.receivedQuantity > 0 && !value.lotCode) {
    context.addIssue({ code: "custom", message: "Received stock requires a lot code", path: ["lotCode"] });
  }
  if ((value.rejectedQuantity > 0) !== (value.rejectionReasonCode !== null)) {
    context.addIssue({
      code: "custom",
      message: "Rejected quantity and reason code must both be present or absent",
      path: ["rejectionReasonCode"],
    });
  }
});

export const RecordProcurementReceiptInputSchema = z.object({
  expectedVersion: z.number().int().positive(),
  receivedAt: z.iso.datetime(),
  externalReference: z.string().trim().min(1).max(200).nullable(),
  lines: z.array(ProcurementReceiptLineInputSchema).min(1).max(200),
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => uniqueLineKeys(value.lines, context));

export const ProcurementInvoiceLineInputSchema = z.object({
  lineKey: CodeSchema,
  invoicedQuantity: QuantitySchema,
  unitCostMinor: MoneyMinorSchema,
}).strict();

export const RecordProcurementInvoiceInputSchema = z.object({
  invoiceNumber: z.string().trim().min(1).max(100),
  currency: CurrencySchema,
  issuedAt: z.iso.datetime(),
  lines: z.array(ProcurementInvoiceLineInputSchema).min(1).max(200),
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => uniqueLineKeys(value.lines, context));

export const UpsertReplenishmentPolicyInputSchema = z.object({
  stockItemId: EntityIdSchema,
  locationId: EntityIdSchema,
  reorderPoint: NonNegativeQuantitySchema,
  safetyStock: NonNegativeQuantitySchema,
  minimumOrderQuantity: QuantitySchema,
  leadTimeDays: z.number().int().nonnegative().max(3650),
  serviceLevelBps: z.number().int().min(0).max(10_000),
  reviewIntervalDays: z.number().int().positive().max(3650),
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const CreateReplenishmentSuggestionInputSchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const ProcurementSupplierViewSchema = z.object({
  id: EntityIdSchema,
  name: z.string(),
  kind: z.string(),
  regionCode: z.string(),
  settlementCurrency: CurrencySchema,
  status: z.string(),
});

export const ProcurementStockItemViewSchema = z.object({
  id: EntityIdSchema,
  code: CodeSchema,
  name: z.string(),
  baseUnit: ProcurementUnitSchema,
});

export const ProcurementLocationViewSchema = z.object({
  id: EntityIdSchema,
  code: CodeSchema,
  name: z.string(),
});

export const ProcurementRequisitionViewSchema = z.object({
  id: EntityIdSchema,
  code: CodeSchema,
  status: ProcurementRequisitionStatusSchema,
  currentVersion: z.number().int().positive(),
  reasonCode: CodeSchema,
  lines: z.array(ProcurementRequestLineSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const ProcurementRfqViewSchema = z.object({
  id: EntityIdSchema,
  requisitionId: EntityIdSchema,
  requisitionVersion: z.number().int().positive(),
  status: ProcurementRfqStatusSchema,
  supplierIds: z.array(EntityIdSchema),
  responseDueAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

export const ProcurementSupplierQuoteViewSchema = z.object({
  id: EntityIdSchema,
  rfqId: EntityIdSchema,
  supplierId: EntityIdSchema,
  version: z.number().int().positive(),
  currency: CurrencySchema,
  validUntil: z.iso.datetime(),
  lines: z.array(SupplierQuoteLineSchema),
  totalMinor: MoneyMinorSchema,
  createdAt: z.iso.datetime(),
});

export const InventoryPurchaseOrderViewSchema = z.object({
  id: EntityIdSchema,
  code: CodeSchema,
  supplierId: EntityIdSchema,
  requisitionId: EntityIdSchema.nullable(),
  quoteId: EntityIdSchema.nullable(),
  status: InventoryPurchaseOrderStatusSchema,
  currentVersion: z.number().int().positive(),
  currency: CurrencySchema,
  expectedAt: z.iso.datetime(),
  totalMinor: MoneyMinorSchema,
  lines: z.array(ProcurementPurchaseLineSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const ProcurementReceiptLineViewSchema = z.object({
  lineKey: CodeSchema,
  stockItemId: EntityIdSchema,
  destinationLocationId: EntityIdSchema,
  receivedQuantity: NonNegativeQuantitySchema,
  rejectedQuantity: NonNegativeQuantitySchema,
  rejectionReasonCode: CodeSchema.nullable(),
  lotId: EntityIdSchema.nullable(),
  movementId: EntityIdSchema.nullable(),
  unit: ProcurementUnitSchema,
});

export const ProcurementReceiptViewSchema = z.object({
  id: EntityIdSchema,
  purchaseOrderId: EntityIdSchema,
  purchaseOrderVersion: z.number().int().positive(),
  receivedAt: z.iso.datetime(),
  externalReference: z.string().nullable(),
  hasVariance: z.boolean(),
  lines: z.array(ProcurementReceiptLineViewSchema),
  createdAt: z.iso.datetime(),
});

export const ProcurementInvoiceViewSchema = z.object({
  id: EntityIdSchema,
  purchaseOrderId: EntityIdSchema,
  invoiceNumber: z.string(),
  currency: CurrencySchema,
  totalMinor: MoneyMinorSchema,
  varianceMinor: z.number().int(),
  status: ProcurementInvoiceStatusSchema,
  issuedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

export const ReplenishmentPolicyViewSchema = z.object({
  id: EntityIdSchema,
  stockItemId: EntityIdSchema,
  locationId: EntityIdSchema,
  currentVersion: z.number().int().positive(),
  reorderPoint: NonNegativeQuantitySchema,
  safetyStock: NonNegativeQuantitySchema,
  minimumOrderQuantity: QuantitySchema,
  leadTimeDays: z.number().int().nonnegative(),
  serviceLevelBps: z.number().int().min(0).max(10_000),
  reviewIntervalDays: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
});

export const ReplenishmentSuggestionViewSchema = z.object({
  id: EntityIdSchema,
  policyId: EntityIdSchema,
  policyVersion: z.number().int().positive(),
  stockItemId: EntityIdSchema,
  locationId: EntityIdSchema,
  availableQuantity: z.number().int(),
  inTransitQuantity: NonNegativeQuantitySchema,
  suggestedQuantity: NonNegativeQuantitySchema,
  status: ReplenishmentSuggestionStatusSchema,
  createdAt: z.iso.datetime(),
});

export const ProcurementWorkspaceViewSchema = z.object({
  suppliers: z.array(ProcurementSupplierViewSchema),
  stockItems: z.array(ProcurementStockItemViewSchema),
  locations: z.array(ProcurementLocationViewSchema),
  requisitions: z.array(ProcurementRequisitionViewSchema),
  rfqs: z.array(ProcurementRfqViewSchema),
  quotes: z.array(ProcurementSupplierQuoteViewSchema),
  purchaseOrders: z.array(InventoryPurchaseOrderViewSchema),
  receipts: z.array(ProcurementReceiptViewSchema),
  invoices: z.array(ProcurementInvoiceViewSchema),
  policies: z.array(ReplenishmentPolicyViewSchema),
  suggestions: z.array(ReplenishmentSuggestionViewSchema),
});

export type ProcurementUnit = z.infer<typeof ProcurementUnitSchema>;
export type ProcurementRequestLine = z.infer<typeof ProcurementRequestLineSchema>;
export type ProcurementPurchaseLine = z.infer<typeof ProcurementPurchaseLineSchema>;
export type CreateProcurementRequisitionInput = z.infer<typeof CreateProcurementRequisitionInputSchema>;
export type CreateProcurementRfqInput = z.infer<typeof CreateProcurementRfqInputSchema>;
export type RecordProcurementSupplierQuoteInput = z.infer<typeof RecordProcurementSupplierQuoteInputSchema>;
export type CreateInventoryPurchaseOrderInput = z.infer<typeof CreateInventoryPurchaseOrderInputSchema>;
export type ReviseInventoryPurchaseOrderInput = z.infer<typeof ReviseInventoryPurchaseOrderInputSchema>;
export type ReviewInventoryPurchaseOrderInput = z.infer<typeof ReviewInventoryPurchaseOrderInputSchema>;
export type RecordProcurementReceiptInput = z.infer<typeof RecordProcurementReceiptInputSchema>;
export type RecordProcurementInvoiceInput = z.infer<typeof RecordProcurementInvoiceInputSchema>;
export type UpsertReplenishmentPolicyInput = z.infer<typeof UpsertReplenishmentPolicyInputSchema>;
export type CreateReplenishmentSuggestionInput = z.infer<typeof CreateReplenishmentSuggestionInputSchema>;
export type ProcurementWorkspaceView = z.infer<typeof ProcurementWorkspaceViewSchema>;
export type InventoryPurchaseOrderView = z.infer<typeof InventoryPurchaseOrderViewSchema>;

function uniqueLineKeys(
  lines: Array<{ lineKey: string }>,
  context: z.RefinementCtx,
) {
  if (new Set(lines.map((line) => line.lineKey)).size !== lines.length) {
    context.addIssue({ code: "custom", message: "Line keys must be unique", path: ["lines"] });
  }
}
