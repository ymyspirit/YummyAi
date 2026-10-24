import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { FinanceCurrencySchema, financeCurrencyMinorDigits } from "@yummyai/contracts/finance/monetary";
import { FinanceBillBalanceFields, FinancePaymentBalanceFields, refineFinanceBillBalance, refineFinancePaymentBalance,
  FinanceBillAdjustmentViewSchema, FinancePaymentAdjustmentViewSchema, FinanceProcurementAdjustmentOptionSchema,
  FinanceProcurementAdjustmentDiagnosticSchema } from "@yummyai/contracts/finance/payables-adjustments";

const Id = EntityIdSchema.transform(value => value.toLowerCase());
const DateTime = z.iso.datetime().refine(value => !value.startsWith("0000-"), "A PostgreSQL-compatible calendar year is required")
  .transform(value => new Date(value).toISOString());
const Money = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Key = z.string().trim().min(8).max(200);
// References are business identifiers, never bank account details or free-form secrets.
const Reference = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const Currency = FinanceCurrencySchema.refine(code => financeCurrencyMinorDigits(code) !== null, "Currency minor units must be known");
export const FinanceBillKindSchema = z.enum(["factory_invoice", "supplier_invoice", "procurement_invoice"]);
export const FinancePaymentMethodSchema = z.enum(["bank_transfer", "card", "cash", "other"]);
export const FinanceAllocationStatusSchema = z.enum(["unallocated", "partially_allocated", "fully_allocated"]);
export const FinanceBillSourceStatusSchema = z.enum(["current", "source_adjusted", "source_unreconciled", "source_unavailable"]);

export const RecordFinanceBillInputSchema = z.object({
  supplierId: Id, kind: FinanceBillKindSchema, externalBillId: Reference,
  currency: Currency, amountMinor: Money, issuedAt: DateTime, dueAt: DateTime.nullable(),
  procurementInvoiceId: Id.nullable(), idempotencyKey: Key,
}).strict().superRefine((value, ctx) => {
  if ((value.kind === "procurement_invoice") !== (value.procurementInvoiceId !== null))
    ctx.addIssue({ code: "custom", path: ["procurementInvoiceId"], message: "Only procurement bills require their real procurement invoice" });
  if (value.dueAt !== null && Date.parse(value.dueAt) < Date.parse(value.issuedAt))
    ctx.addIssue({ code: "custom", path: ["dueAt"], message: "Due date cannot precede issue date" });
});
export const RecordFinancePaymentInputSchema = z.object({
  supplierId: Id, externalPaymentId: Reference, currency: Currency, amountMinor: Money,
  paidAt: DateTime, method: FinancePaymentMethodSchema, evidenceReference: Reference, idempotencyKey: Key,
}).strict();
export const AllocateFinancePaymentInputSchema = z.object({
  paymentId: Id, allocations: z.array(z.object({ billId: Id, amountMinor: Money }).strict()).min(1).max(100),
  idempotencyKey: Key,
}).strict().superRefine((value, ctx) => {
  if (new Set(value.allocations.map(item => item.billId)).size !== value.allocations.length)
    ctx.addIssue({ code: "custom", path: ["allocations"], message: "A bill can occur only once in an allocation batch" });
  if (value.allocations.reduce((sum, item) => sum + BigInt(item.amountMinor), 0n) > BigInt(Number.MAX_SAFE_INTEGER))
    ctx.addIssue({ code: "custom", path: ["allocations"], message: "Allocation total exceeds safe money range" });
});
export const ReleaseFinanceAllocationInputSchema = z.object({
  reasonCode: z.string().trim().min(1).max(100).regex(/^[A-Z0-9][A-Z0-9._-]*$/), idempotencyKey: Key,
}).strict();

export const FinancePayableBillViewSchema = z.object({
  id: Id, supplierId: Id, kind: FinanceBillKindSchema, externalBillId: Reference,
  currency: Currency, ...FinanceBillBalanceFields, issuedAt: DateTime, dueAt: DateTime.nullable(),
  procurementInvoiceId: Id.nullable(), procurementProofId: Id.nullable(),
  sourceStatus: FinanceBillSourceStatusSchema,
  status: FinanceAllocationStatusSchema, recordedAt: DateTime,
}).strict().superRefine(refineFinanceBillBalance).superRefine((value, ctx) => {
  const expected = value.allocatedMinor === 0 ? "unallocated" : value.outstandingMinor === 0 ? "fully_allocated" : "partially_allocated";
  if (value.status !== expected) ctx.addIssue({ code: "custom", path: ["status"], message: "Bill allocation status disagrees with balances" });
});
export const FinancePayablePaymentViewSchema = z.object({
  id: Id, supplierId: Id, externalPaymentId: Reference, currency: Currency, ...FinancePaymentBalanceFields,
  paidAt: DateTime, method: FinancePaymentMethodSchema, evidenceReference: Reference,
  evidenceStatus: z.literal("operator_recorded"),
  status: FinanceAllocationStatusSchema, recordedAt: DateTime,
}).strict().superRefine(refineFinancePaymentBalance).superRefine((value, ctx) => {
  const expected = value.allocatedMinor === 0 ? "unallocated" : value.unallocatedMinor === 0 ? "fully_allocated" : "partially_allocated";
  if (value.status !== expected) ctx.addIssue({ code: "custom", path: ["status"], message: "Payment allocation status disagrees with balances" });
});
export const FinancePaymentAllocationViewSchema = z.object({
  id: Id, batchId: Id, paymentId: Id, billId: Id,
  supplierId: Id, currency: Currency, amountMinor: Money, released: z.boolean(), recordedAt: DateTime,
}).strict();
export const FinanceAllocationReleaseViewSchema = z.object({
  id: Id, allocationId: Id, reasonCode: ReleaseFinanceAllocationInputSchema.shape.reasonCode,
  recordedAt: DateTime,
}).strict();
export const FinancePaymentAllocationBatchViewSchema = z.object({
  id: Id, paymentId: Id, allocations: z.array(FinancePaymentAllocationViewSchema).min(1).max(100),
  recordedAt: DateTime,
}).strict().superRefine((value, ctx) => {
  if (value.allocations.some(item => item.batchId !== value.id || item.paymentId !== value.paymentId))
    ctx.addIssue({ code: "custom", path: ["allocations"], message: "Allocation rows must belong to their batch and payment" });
  if (new Set(value.allocations.map(item => item.id)).size !== value.allocations.length || new Set(value.allocations.map(item => item.billId)).size !== value.allocations.length)
    ctx.addIssue({ code: "custom", path: ["allocations"], message: "Allocation batch identities must be unique" });
});
export const FinancePayablesWorkspaceViewSchema = z.object({
  suppliers: z.array(z.object({ id: Id, name: z.string().min(1), status: z.enum(["active", "suspended", "archived"]) }).strict()),
  bills: z.array(FinancePayableBillViewSchema), payments: z.array(FinancePayablePaymentViewSchema),
  allocations: z.array(FinancePaymentAllocationViewSchema), releases: z.array(FinanceAllocationReleaseViewSchema),
  billAdjustments: z.array(FinanceBillAdjustmentViewSchema), paymentAdjustments: z.array(FinancePaymentAdjustmentViewSchema),
  procurementAdjustments: z.array(FinanceProcurementAdjustmentOptionSchema),
  procurementAdjustmentDiagnostics: z.array(FinanceProcurementAdjustmentDiagnosticSchema),
  permissions: z.object({ canWrite: z.boolean(), canReview: z.boolean() }).strict(), truncated: z.boolean(),
}).strict();

/** The original request is normalized once by its strict input schema. Array order remains evidence. */
export function canonicalFinancePayablesRequest(operation: "bill" | "payment" | "allocation" | "release", input: unknown, targetId: string | null = null): string {
  const parsed = operation === "bill" ? RecordFinanceBillInputSchema.parse(input)
    : operation === "payment" ? RecordFinancePaymentInputSchema.parse(input)
      : operation === "allocation" ? AllocateFinancePaymentInputSchema.parse(input) : ReleaseFinanceAllocationInputSchema.parse(input);
  if (operation === "release" ? targetId === null : targetId !== null) throw new RangeError("finance_payables_target_invalid");
  return canonicalJson({ version: 1, operation, targetId: targetId === null ? null : Id.parse(targetId), input: parsed });
}

/** Exact decimal major units to integer minor units, with no float multiplication or rounding. */
export function parseFinancePayableAmount(value: string, currency: string): number {
  const digits = financeCurrencyMinorDigits(currency), input = value.trim();
  if (digits === null) throw new RangeError("finance_currency_precision_unknown");
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(input) || input.length > 32) throw new RangeError("finance_amount_invalid");
  const [whole, fraction = ""] = input.split(".");
  if (fraction.length > digits) throw new RangeError("finance_amount_precision");
  const minor = BigInt(whole!) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, "0") || "0");
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("finance_money_overflow");
  return Number(minor);
}

export type RecordFinanceBillInput = z.infer<typeof RecordFinanceBillInputSchema>;
export type RecordFinancePaymentInput = z.infer<typeof RecordFinancePaymentInputSchema>;
export type AllocateFinancePaymentInput = z.infer<typeof AllocateFinancePaymentInputSchema>;
export type ReleaseFinanceAllocationInput = z.infer<typeof ReleaseFinanceAllocationInputSchema>;
export type FinancePayableBillView = z.infer<typeof FinancePayableBillViewSchema>;
export type FinancePayablePaymentView = z.infer<typeof FinancePayablePaymentViewSchema>;
export type FinancePaymentAllocationView = z.infer<typeof FinancePaymentAllocationViewSchema>;
export type FinanceAllocationReleaseView = z.infer<typeof FinanceAllocationReleaseViewSchema>;
export type FinancePaymentAllocationBatchView = z.infer<typeof FinancePaymentAllocationBatchViewSchema>;
export type FinancePayablesWorkspaceView = z.infer<typeof FinancePayablesWorkspaceViewSchema>;
