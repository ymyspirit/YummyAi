import { z } from "zod";
import {
  CreateProcurementRequisitionInputSchema, CreateProcurementRfqInputSchema,
  RecordProcurementSupplierQuoteInputSchema, CreateInventoryPurchaseOrderInputSchema,
  ReviseInventoryPurchaseOrderInputSchema, ReviewInventoryPurchaseOrderInputSchema,
  RecordProcurementInvoiceInputSchema, ProcurementInvoiceViewSchema,
} from "@yummyai/contracts/procurement";
import { CreateSupplyPurchaseInputSchema } from "@yummyai/contracts/catalog/product-supply";
import { canonicalProcurementWriteRequest, canonicalProcurementInvoiceRequest, ProcurementWriteKindSchema } from "@yummyai/contracts/procurement/procurement-cycle";
import { PositiveStockQuantitySchema } from "@yummyai/contracts/inventory/quantity-schema";
import { ProcurementUnitSchema, ProcurementStockBasisSchema } from "@yummyai/contracts/procurement/measurement";
import { InvoiceReconciliationInputSchema, InvoiceReconciliationEventSchema, canonicalInvoiceReconciliationRequest } from "@yummyai/contracts/procurement/invoice-reconciliation";

const Id = z.uuidv7().transform(value => value.toLowerCase());
const InvoiceCommandResult = ProcurementInvoiceViewSchema.safeExtend({
  allocationStatus: ProcurementInvoiceViewSchema.shape.allocationStatus.unwrap(),
  comparisonCurrency: ProcurementInvoiceViewSchema.shape.comparisonCurrency.unwrap(),
  lines: ProcurementInvoiceViewSchema.shape.lines.unwrap().min(1),
}).strict();
export const ProcurementCommandKindSchema = z.enum([
  "requisition_create", "rfq_create", "quote_record", "purchase_create",
  "supply_purchase_create", "purchase_revise", "purchase_review", "invoice_record", "invoice_reconcile",
]);
export type ProcurementCommandKind = z.infer<typeof ProcurementCommandKindSchema>;
export const ProcurementCommandOperationSchema = z.enum([...ProcurementWriteKindSchema.options, "invoice_record", "invoice_reconcile"]);
export type ProcurementCommandOperation = z.infer<typeof ProcurementCommandOperationSchema>;
const createsRoot = (kind: ProcurementCommandKind) => kind === "requisition_create" || kind === "purchase_create";
export const ProcurementCommandScopeSchema = z.object({ kind: ProcurementCommandKindSchema, targetId: Id.nullable() }).strict()
  .superRefine((value, ctx) => {
    if (createsRoot(value.kind) !== (value.targetId === null)) ctx.addIssue({ code: "custom", path: ["targetId"], message: "原操作与业务对象范围不一致" });
  });
export type ProcurementCommandScope = z.infer<typeof ProcurementCommandScopeSchema>;
export const PrepareProcurementCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("requisition_create"), targetId: z.null(), input: CreateProcurementRequisitionInputSchema }).strict(),
  z.object({ kind: z.literal("rfq_create"), targetId: Id, input: CreateProcurementRfqInputSchema }).strict(),
  z.object({ kind: z.literal("quote_record"), targetId: Id, input: RecordProcurementSupplierQuoteInputSchema }).strict(),
  z.object({ kind: z.literal("purchase_create"), targetId: z.null(), input: CreateInventoryPurchaseOrderInputSchema }).strict(),
  z.object({ kind: z.literal("supply_purchase_create"), targetId: Id, input: CreateSupplyPurchaseInputSchema }).strict(),
  z.object({ kind: z.literal("purchase_revise"), targetId: Id, input: ReviseInventoryPurchaseOrderInputSchema }).strict(),
  z.object({ kind: z.literal("purchase_review"), targetId: Id, input: ReviewInventoryPurchaseOrderInputSchema }).strict(),
  z.object({ kind: z.literal("invoice_record"), targetId: Id, input: RecordProcurementInvoiceInputSchema.safeExtend({ expectedVersion: z.number().int().positive() }) }).strict(),
  z.object({ kind: z.literal("invoice_reconcile"), targetId: Id, input: InvoiceReconciliationInputSchema }).strict(),
]);
export type PrepareProcurementCommand = z.infer<typeof PrepareProcurementCommandSchema>;
export function canonicalProcurementCommandOriginal(original: PrepareProcurementCommand) {
  if (original.kind === "invoice_reconcile") return canonicalInvoiceReconciliationRequest(original.targetId, original.input);
  if (original.kind === "invoice_record") return canonicalProcurementInvoiceRequest(original.targetId, original.input);
  return canonicalProcurementWriteRequest(original.kind === "supply_purchase_create" ? "purchase_create" : original.kind,
    original.targetId, original.kind === "supply_purchase_create" ? { linkId: original.targetId, input: original.input } : original.input);
}
export const ProcurementCommandEmptyBodySchema = z.object({}).strict();
export const ProcurementCommandQuerySchema = z.object({ kind: ProcurementCommandKindSchema.optional(), targetId: Id.optional(), before: Id.optional() }).strict()
  .superRefine((value, ctx) => {
    if (value.kind && createsRoot(value.kind) && value.targetId) ctx.addIssue({ code: "custom", path: ["targetId"], message: "新建操作没有既有目标对象" });
  });
export type ProcurementCommandQuery = z.infer<typeof ProcurementCommandQuerySchema>;
export const ProcurementCommandResultSchema = z.object({ kind: ProcurementCommandKindSchema, id: Id,
  versionId: Id.nullable(), version: z.number().int().positive().nullable() }).strict().superRefine((value, ctx) => {
    if ((value.versionId === null) !== (value.version === null)) ctx.addIssue({ code: "custom", message: "原结果版本依据不完整" });
    if ((value.kind === "invoice_record" || value.kind === "invoice_reconcile") && value.versionId !== null) ctx.addIssue({ code: "custom", message: "发票及实际处理凭据没有自身版本" });
  });
export type ProcurementCommandResult = z.infer<typeof ProcurementCommandResultSchema>;
export const ProcurementReviewBasisSchema = z.object({
  sourceVersionId: Id.nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  lines: z.array(z.object({ lineKey: z.string(), stockItemId: Id, quantity: PositiveStockQuantitySchema,
    unit: ProcurementUnitSchema, stockBasis: ProcurementStockBasisSchema.nullable(),
    unitCostMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    priceBasisQuantity: PositiveStockQuantitySchema.nullable(), lineTotalMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  }).strict()).max(200),
}).strict();
export type ProcurementReviewBasis = z.infer<typeof ProcurementReviewBasisSchema>;
export const ProcurementCommandViewSchema = z.object({ id: Id, kind: ProcurementCommandKindSchema, targetId: Id.nullable(),
  targetLabel: z.string().min(1).max(1000), targetDetail: z.string().max(2000).nullable(),
  status: z.enum(["prepared", "succeeded", "cancelled", "expired"]),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(),
  contextAuthority: z.string().min(1), acknowledged: z.boolean(), canExecute: z.boolean(), canCancel: z.boolean(),
  original: PrepareProcurementCommandSchema.nullable(), result: ProcurementCommandResultSchema.nullable(),
  reviewBasis: ProcurementReviewBasisSchema.nullable().optional(),
  invoiceResult: InvoiceCommandResult.nullable().optional(),
  reconciliationResult: InvoiceReconciliationEventSchema.nullable().optional(),
  blockReason: z.enum(["basis_changed", "permission_denied", "input_unavailable", "expired"]).nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.status === "succeeded") !== (value.result !== null) || (value.status === "prepared") !== (value.completedAt === null))
    ctx.addIssue({ code: "custom", message: "原采购操作状态与实际结果不一致" });
  if (value.original && (value.original.kind !== value.kind || value.original.targetId !== value.targetId) || value.result && value.result.kind !== value.kind)
    ctx.addIssue({ code: "custom", message: "原填写或结果与采购对象不一致" });
  if (value.canExecute && (value.status !== "prepared" || !value.original || value.blockReason !== null || value.acknowledged) ||
    value.canCancel && value.status !== "prepared" || value.acknowledged && (value.status === "prepared" || value.original !== null))
    ctx.addIssue({ code: "custom", message: "原采购操作与留存状态不一致" });
  if (createsRoot(value.kind) !== (value.targetId === null)) ctx.addIssue({ code: "custom", message: "原采购范围不一致" });
  if (value.invoiceResult && (value.kind !== "invoice_record" || value.status !== "succeeded" || value.result?.id !== value.invoiceResult.id || value.targetId !== value.invoiceResult.purchaseOrderId))
    ctx.addIssue({ code: "custom", message: "发票结果与原采购操作不一致" });
  if (value.kind === "invoice_record" && value.status === "succeeded" && !value.invoiceResult)
    ctx.addIssue({ code: "custom", message: "已执行的发票缺少实际结果" });
  if (value.reconciliationResult && (value.kind !== "invoice_reconcile" || value.status !== "succeeded" || value.result?.id !== value.reconciliationResult.id || value.targetId !== value.reconciliationResult.invoiceId))
    ctx.addIssue({ code: "custom", message: "处理凭据与原发票操作不一致" });
  if (value.kind === "invoice_reconcile" && value.status === "succeeded" && !value.reconciliationResult)
    ctx.addIssue({ code: "custom", message: "已执行的处理缺少实际凭据" });
  if (value.reconciliationResult && value.original?.kind === "invoice_reconcile" &&
    canonicalInvoiceReconciliationRequest(value.targetId!, value.original.input) !== canonicalInvoiceReconciliationRequest(value.targetId!, value.reconciliationResult.input))
    ctx.addIssue({ code: "custom", message: "处理凭据与原提交正文不一致" });
});
export type ProcurementCommandView = z.infer<typeof ProcurementCommandViewSchema>;
export const ProcurementCommandListSchema = z.object({ items: z.array(ProcurementCommandViewSchema).max(50), nextCursor: Id.nullable(),
  unavailableCount: z.number().int().min(0).max(50), contextAuthority: z.string().min(1) }).strict();
export type ProcurementCommandList = z.infer<typeof ProcurementCommandListSchema>;
