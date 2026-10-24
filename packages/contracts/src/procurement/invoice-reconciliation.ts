import { z } from "zod";
import { NonnegativeStockQuantitySchema, PositiveStockQuantitySchema } from "@yummyai/contracts/inventory/quantity-schema";
import { addStockQuantity, compareStockQuantity, stockQuantityMatchesUnit, stockQuantityWithinCommandLimit } from "@yummyai/contracts/inventory/quantity";
import { ProcurementUnitSchema } from "@yummyai/contracts/procurement/measurement";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";

const Id = z.uuidv7().transform(value => value.toLowerCase());
const Minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SignedMinor = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const Quantity = NonnegativeStockQuantitySchema.refine(stockQuantityWithinCommandLimit);
const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const common = { expectedFingerprint: Fingerprint, idempotencyKey: z.string().trim().min(8).max(200), reason: z.string().trim().min(1).max(2000) };
export const SupplierAdjustmentDocumentSchema = z.object({
  kind: z.enum(["credit_note", "debit_note"]), number: z.string().trim().min(1).max(100),
  issuedAt: z.iso.datetime(), currency: z.string().regex(/^[A-Z]{3}$/),
  evidenceReference: z.string().trim().min(1).max(2000),
}).strict();
export const SupplierAdjustmentLineSchema = z.object({ invoiceLineId: Id, quantity: Quantity, unit: ProcurementUnitSchema, amountMinor: Minor }).strict()
  .superRefine((v, c) => {
    if (!stockQuantityMatchesUnit(v.quantity, v.unit)) c.addIssue({ code: "custom", path: ["quantity"], message: "调整数量与原单位不一致" });
    if (compareStockQuantity(v.quantity, 0) === 0 && v.amountMinor === 0) c.addIssue({ code: "custom", message: "调整必须有实际数量或金额" });
  });
export const InvoiceReconciliationInputSchema = z.discriminatedUnion("action", [
  z.object({ ...common, action: z.literal("adjustment_record"), document: SupplierAdjustmentDocumentSchema,
    lines: z.array(SupplierAdjustmentLineSchema).min(1).max(200) }).strict().superRefine((v, c) => {
    if (new Set(v.lines.map(l => l.invoiceLineId)).size !== v.lines.length) c.addIssue({ code: "custom", path: ["lines"], message: "原发票行不可重复" });
    if (v.document.kind === "debit_note" && v.lines.some(l => compareStockQuantity(l.quantity, 0) !== 0))
      c.addIssue({ code: "custom", path: ["lines"], message: "金额补差不得重复占用收货数量 补开数量使用新发票" });
  }),
  z.object({ ...common, action: z.literal("adjustment_review"), adjustmentId: Id, decision: z.enum(["approved", "rejected"]) }).strict(),
  z.object({ ...common, action: z.literal("receipt_match"), lines: z.array(z.object({ invoiceLineId: Id, receiptLineId: Id,
    quantity: PositiveStockQuantitySchema, unit: ProcurementUnitSchema }).strict()).min(1).max(200) }).strict().superRefine((v, c) => {
    if (new Set(v.lines.map(l => `${l.invoiceLineId}:${l.receiptLineId}`)).size !== v.lines.length)
      c.addIssue({ code: "custom", path: ["lines"], message: "同一发票行与收货行不可重复" });
    for (const l of v.lines) if (!stockQuantityMatchesUnit(l.quantity, l.unit)) c.addIssue({ code: "custom", path: ["lines"], message: "匹配数量与原单位不一致" });
  }),
]);
export type InvoiceReconciliationInput = z.infer<typeof InvoiceReconciliationInputSchema>;
export type SupplierAdjustmentDocument = z.infer<typeof SupplierAdjustmentDocumentSchema>;
export type SupplierAdjustmentLine = z.infer<typeof SupplierAdjustmentLineSchema>;
export const InvoiceReconciliationBalanceLineSchema = z.object({
  invoiceLineId: Id, lineKey: z.string(), unit: ProcurementUnitSchema.nullable(),
  originalQuantity: Quantity, creditedQuantity: Quantity, netQuantity: Quantity,
  allocatedQuantity: Quantity.nullable(), unallocatedQuantity: Quantity.nullable(),
  originalAmountMinor: Minor.nullable(), creditAmountMinor: Minor, debitAmountMinor: Minor, netAmountMinor: Minor.nullable(),
  expectedAmountMinor: Minor.nullable(), varianceMinor: SignedMinor.nullable(),
}).strict();
export const InvoiceReconciliationBalanceSchema = z.object({
  status: z.enum(["matched", "reconciliation_required", "fully_credited", "unknown"]),
  currency: z.string().regex(/^[A-Z]{3}$/), comparisonCurrency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  unknownReasons: z.array(z.enum(["legacy_basis_missing", "currency_mismatch", "price_basis_unrepresentable"])),
  netAmountMinor: Minor, varianceMinor: SignedMinor.nullable(),
  lines: z.array(InvoiceReconciliationBalanceLineSchema).min(1).max(200),
}).strict().superRefine((v, c) => {
  const issue = (message: string) => c.addIssue({ code: "custom", message });
  for (const l of v.lines) {
    if (compareStockQuantity(addStockQuantity(l.creditedQuantity, l.netQuantity), l.originalQuantity) !== 0 ||
      (l.allocatedQuantity === null) !== (l.unallocatedQuantity === null) || l.allocatedQuantity !== null &&
      compareStockQuantity(addStockQuantity(l.allocatedQuantity, l.unallocatedQuantity!), l.netQuantity) !== 0)
      issue("当前数量余额与原数量及真实分配不一致");
    if ((l.originalAmountMinor === null) !== (l.netAmountMinor === null) || l.originalAmountMinor !== null &&
      BigInt(l.originalAmountMinor) + BigInt(l.debitAmountMinor) - BigInt(l.creditAmountMinor) !== BigInt(l.netAmountMinor!))
      issue("当前金额余额与原票及已核准凭证不一致");
    if (l.expectedAmountMinor === null ? l.varianceMinor !== null : l.netAmountMinor === null ||
      l.varianceMinor === null || BigInt(l.netAmountMinor) - BigInt(l.expectedAmountMinor) !== BigInt(l.varianceMinor))
      issue("当前差额缺少一致的金额依据");
  }
  if (v.lines.every(l => l.netAmountMinor !== null) && v.lines.reduce((a, l) => a + BigInt(l.netAmountMinor!), 0n) !== BigInt(v.netAmountMinor))
    issue("当前总金额与逐行余额不一致");
  if (v.lines.some(l => l.varianceMinor === null) ? v.varianceMinor !== null : v.varianceMinor === null ||
    v.lines.reduce((a, l) => a + BigInt(l.varianceMinor!), 0n) !== BigInt(v.varianceMinor)) issue("当前总差额与逐行依据不一致");
  if (v.status === "matched" && (v.currency !== v.comparisonCurrency || v.unknownReasons.length > 0 || v.varianceMinor !== 0 ||
    v.lines.some(l => l.unit === null || l.unallocatedQuantity === null || compareStockQuantity(l.unallocatedQuantity, 0) !== 0 || l.varianceMinor !== 0)))
    issue("匹配完成需要确知且完整的数量及同币种金额依据");
  if (v.status === "fully_credited" && (v.netAmountMinor !== 0 || v.lines.some(l => compareStockQuantity(l.netQuantity, 0) !== 0 ||
    l.netAmountMinor !== 0 || l.allocatedQuantity === null || compareStockQuantity(l.allocatedQuantity, 0) !== 0)))
    issue("整票冲销需要净数量 净金额及实际分配均归零");
  if (v.status === "unknown" && (v.unknownReasons.length === 0 || v.varianceMinor !== null)) issue("未知状态须保留具体原因及未知差额");
});
export type InvoiceReconciliationBalance = z.infer<typeof InvoiceReconciliationBalanceSchema>;
/** This is an immutable local approval/result. A typed supplier reference is not external document verification or payment. */
export const InvoiceReconciliationEventSchema = z.object({
  id: Id, invoiceId: Id, purchaseOrderId: Id, purchaseOrderVersionId: Id, originalProofId: Id,
  sequence: z.number().int().positive(), previousId: Id.nullable(), adjustmentId: Id.nullable(),
  action: z.enum(["adjustment_record", "adjustment_review", "receipt_match"]),
  input: InvoiceReconciliationInputSchema, createdBy: Id, createdAt: z.iso.datetime(),
  balance: InvoiceReconciliationBalanceSchema,
}).strict().superRefine((v, c) => {
  if (v.action !== v.input.action || (v.input.action === "adjustment_review" ? v.adjustmentId !== v.input.adjustmentId : v.adjustmentId !== null))
    c.addIssue({ code: "custom", message: "实际凭据与原处理操作不一致" });
});
export type InvoiceReconciliationEvent = z.infer<typeof InvoiceReconciliationEventSchema>;
export const SupplierAdjustmentViewSchema = z.object({
  id: Id, invoiceId: Id, document: SupplierAdjustmentDocumentSchema, lines: z.array(SupplierAdjustmentLineSchema).min(1).max(200),
  reason: z.string(), createdBy: Id, createdAt: z.iso.datetime(), status: z.enum(["pending", "approved", "rejected"]),
  reviewId: Id.nullable(), reviewedBy: Id.nullable(), reviewedAt: z.iso.datetime().nullable(), reviewReason: z.string().nullable(),
}).strict();
export type SupplierAdjustmentView = z.infer<typeof SupplierAdjustmentViewSchema>;
export const InvoiceReconciliationDetailSchema = z.object({
  invoiceId: Id, invoiceNumber: z.string(), originalStatus: z.enum(["matched", "reconciliation_required"]),
  purchaseOrderId: Id, purchaseOrderCode: z.string(), purchaseOrderVersionId: Id.nullable(), supplierId: Id,
  originalProofId: Id.nullable(), fingerprint: Fingerprint,
  canRecord: z.boolean(), canApprove: z.boolean(), blockReason: z.string().nullable(),
  balance: InvoiceReconciliationBalanceSchema, adjustments: z.array(SupplierAdjustmentViewSchema),
  events: z.array(InvoiceReconciliationEventSchema),
  receipts: z.array(z.object({ receiptLineId: Id, lineKey: z.string(), unit: ProcurementUnitSchema,
    acceptedQuantity: Quantity, availableQuantity: Quantity.nullable() }).strict()),
}).strict();
export type InvoiceReconciliationDetail = z.infer<typeof InvoiceReconciliationDetailSchema>;
export const InvoiceReconciliationQuerySchema = z.object({ before: Id.optional(), purchaseOrderId: Id.optional(), pendingOnly: z.enum(["true", "false"]).optional() }).strict();
export type InvoiceReconciliationQuery = z.infer<typeof InvoiceReconciliationQuerySchema>;
export const InvoiceReconciliationListSchema = z.object({
  items: z.array(z.object({ invoiceId: Id, invoiceNumber: z.string(), purchaseOrderId: Id, purchaseOrderCode: z.string(),
    originalStatus: z.enum(["matched", "reconciliation_required"]), status: InvoiceReconciliationBalanceSchema.shape.status,
    currency: z.string(), netAmountMinor: Minor, varianceMinor: SignedMinor.nullable(), pendingCount: z.number().int().nonnegative(),
  }).strict()).max(50), nextCursor: Id.nullable(), unavailableCount: z.number().int().nonnegative().max(50),
}).strict();
export type InvoiceReconciliationList = z.infer<typeof InvoiceReconciliationListSchema>;
export function canonicalInvoiceReconciliationRequest(invoiceId: string, input: InvoiceReconciliationInput) {
  return canonicalJson({ version: 1, invoiceId: invoiceId.toLowerCase(), input: { ...input,
    ...(input.action === "adjustment_record" ? { document: { ...input.document, issuedAt: new Date(input.document.issuedAt).toISOString() } } : {}) } });
}
