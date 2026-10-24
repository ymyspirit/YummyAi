import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { FinanceCurrencySchema, financeCurrencyMinorDigits } from "@yummyai/contracts/finance/monetary";

const Id = EntityIdSchema.transform(value => value.toLowerCase());
const Positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Balance = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Key = z.string().trim().min(8).max(200);
const Reason = z.string().trim().min(1).max(100).regex(/^[A-Z0-9][A-Z0-9._-]*$/);
const noControlCharacters = (value: string) => Array.from(value).every(character => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127);
const Reference = z.string().trim().min(1).max(160).refine(noControlCharacters, "A business document reference is required");
const Evidence = z.string().trim().min(1).max(2000).refine(noControlCharacters, "Evidence must not contain control characters");
const Currency = FinanceCurrencySchema.refine(code => financeCurrencyMinorDigits(code) !== null, "Currency minor units must be known");
const DateTime = z.iso.datetime().refine(value => !value.startsWith("0000-") && /^\d{4}-/.test(value)
  && !/\.[0-9]{3}[0-9]*[1-9][0-9]*Z$/.test(value), "An exact PostgreSQL-compatible millisecond date is required")
  .transform(value => new Date(value).toISOString());
const Command = { expectedNetAmountMinor: Balance, idempotencyKey: Key };
const EvidenceInput = { evidenceReference: Evidence, occurredAt: DateTime, reasonCode: Reason };

export const RecordFinanceBillAdjustmentInputSchema = z.discriminatedUnion("kind", [
  z.object({ ...Command, ...EvidenceInput, kind: z.literal("credit"), amountMinor: Positive, externalDocumentId: Reference }).strict(),
  z.object({ ...Command, ...EvidenceInput, kind: z.literal("debit"), amountMinor: Positive, externalDocumentId: Reference }).strict(),
  z.object({ ...Command, kind: z.literal("procurement_sync"), procurementAdjustmentId: Id, procurementReviewId: Id }).strict(),
  z.object({ ...Command, ...EvidenceInput, kind: z.literal("void") }).strict(),
]);
export const RecordFinancePaymentAdjustmentInputSchema = z.discriminatedUnion("kind", [
  z.object({ ...Command, ...EvidenceInput, kind: z.literal("refund"), amountMinor: Positive, externalDocumentId: Reference }).strict(),
  z.object({ ...Command, ...EvidenceInput, kind: z.literal("void") }).strict(),
]);

export const FinanceBillBalanceFields = {
  amountMinor: Positive, creditMinor: Balance, debitMinor: Balance, voidedMinor: Balance,
  netAmountMinor: Balance, allocatedMinor: Balance, outstandingMinor: Balance,
  lifecycle: z.enum(["active", "fully_credited", "voided"]),
};
export const FinancePaymentBalanceFields = {
  amountMinor: Positive, refundedMinor: Balance, voidedMinor: Balance,
  netAmountMinor: Balance, allocatedMinor: Balance, unallocatedMinor: Balance,
  lifecycle: z.enum(["active", "fully_refunded", "voided"]),
};
const BillBalance = z.object(FinanceBillBalanceFields).strict();
const PaymentBalance = z.object(FinancePaymentBalanceFields).strict();
export type FinanceBillBalance = z.infer<typeof BillBalance>;
export type FinancePaymentBalance = z.infer<typeof PaymentBalance>;
export function refineFinanceBillBalance(value: FinanceBillBalance, ctx: z.RefinementCtx) {
  if (BigInt(value.amountMinor) + BigInt(value.debitMinor) - BigInt(value.creditMinor) - BigInt(value.voidedMinor) !== BigInt(value.netAmountMinor)
    || BigInt(value.allocatedMinor) + BigInt(value.outstandingMinor) !== BigInt(value.netAmountMinor))
    ctx.addIssue({ code: "custom", message: "Bill principal, adjustments and allocations must conserve the net amount" });
  if (value.lifecycle === "voided" ? value.netAmountMinor !== 0 || value.allocatedMinor !== 0
    : value.voidedMinor !== 0 || value.lifecycle !== (value.netAmountMinor === 0 ? "fully_credited" : "active"))
    ctx.addIssue({ code: "custom", path: ["lifecycle"], message: "Bill lifecycle disagrees with its immutable ledger" });
}
export function refineFinancePaymentBalance(value: FinancePaymentBalance, ctx: z.RefinementCtx) {
  if (BigInt(value.amountMinor) - BigInt(value.refundedMinor) - BigInt(value.voidedMinor) !== BigInt(value.netAmountMinor)
    || BigInt(value.allocatedMinor) + BigInt(value.unallocatedMinor) !== BigInt(value.netAmountMinor))
    ctx.addIssue({ code: "custom", message: "Payment principal, refunds and allocations must conserve the net amount" });
  if (value.lifecycle === "voided" ? value.netAmountMinor !== 0 || value.allocatedMinor !== 0 || value.refundedMinor !== 0
    : value.voidedMinor !== 0 || value.lifecycle !== (value.netAmountMinor === 0 ? "fully_refunded" : "active"))
    ctx.addIssue({ code: "custom", path: ["lifecycle"], message: "Payment lifecycle disagrees with its immutable ledger" });
}
export const FinanceBillBalanceSchema = BillBalance.superRefine(refineFinanceBillBalance);
export const FinancePaymentBalanceSchema = PaymentBalance.superRefine(refineFinancePaymentBalance);

export const FinanceBillAdjustmentViewSchema = z.object({
  id: Id, billId: Id, supplierId: Id, currency: Currency,
  kind: z.enum(["credit", "debit", "source_acknowledgement", "void"]), amountMinor: Balance,
  externalDocumentId: Reference.nullable(), ...EvidenceInput,
  procurementAdjustmentId: Id.nullable(), procurementReviewId: Id.nullable(),
  balanceAfter: FinanceBillBalanceSchema, recordedAt: DateTime,
}).strict().superRefine((value, ctx) => {
  if ((value.procurementAdjustmentId === null) !== (value.procurementReviewId === null)
    || (value.kind === "source_acknowledgement" && (value.amountMinor !== 0 || value.procurementAdjustmentId === null))
    || (["credit", "debit"].includes(value.kind) && value.amountMinor === 0)
    || (value.kind === "void" ? value.externalDocumentId !== null || value.procurementAdjustmentId !== null : value.externalDocumentId === null)
    || (value.kind === "void") !== (value.balanceAfter.lifecycle === "voided")
    || value.procurementAdjustmentId !== null && value.reasonCode !== "PROCUREMENT_APPROVED"
    || value.kind === "credit" && value.balanceAfter.creditMinor < value.amountMinor
    || value.kind === "debit" && value.balanceAfter.debitMinor < value.amountMinor)
    ctx.addIssue({ code: "custom", message: "Adjustment kind, money and original source references disagree" });
});
export const FinancePaymentAdjustmentViewSchema = z.object({
  id: Id, paymentId: Id, supplierId: Id, currency: Currency, kind: z.enum(["refund", "void"]), amountMinor: Positive,
  externalDocumentId: Reference.nullable(), ...EvidenceInput, evidenceStatus: z.literal("operator_recorded"),
  balanceAfter: FinancePaymentBalanceSchema, recordedAt: DateTime,
}).strict().superRefine((value, ctx) => {
  if ((value.kind === "void") !== (value.externalDocumentId === null)
    || (value.kind === "void") !== (value.balanceAfter.lifecycle === "voided")
    || value.kind === "refund" && value.balanceAfter.refundedMinor < value.amountMinor)
    ctx.addIssue({ code: "custom", message: "A refund requires its actual document reference" });
});
export const FinanceProcurementAdjustmentOptionSchema = z.object({
  billId: Id, procurementAdjustmentId: Id, procurementReviewId: Id, kind: z.enum(["credit", "debit"]),
  amountMinor: Balance, externalDocumentId: Reference, evidenceReference: Evidence, occurredAt: DateTime, mappedEventId: Id.nullable(),
}).strict();
export const FinanceProcurementAdjustmentDiagnosticSchema = z.object({
  billId: Id, procurementAdjustmentId: Id, procurementReviewId: Id, code: z.literal("source_format_not_supported"),
}).strict();

/** New command identity is separate from unchanged v1 bill/payment/allocation keys. */
export function canonicalFinancePayableAdjustmentRequest(operation: "bill-adjustment" | "payment-adjustment", targetId: string, input: unknown) {
  const parsed = operation === "bill-adjustment" ? RecordFinanceBillAdjustmentInputSchema.parse(input) : RecordFinancePaymentAdjustmentInputSchema.parse(input);
  return canonicalJson({ version: 1, operation, targetId: Id.parse(targetId), input: parsed });
}
export type RecordFinanceBillAdjustmentInput = z.infer<typeof RecordFinanceBillAdjustmentInputSchema>;
export type RecordFinancePaymentAdjustmentInput = z.infer<typeof RecordFinancePaymentAdjustmentInputSchema>;
export type FinanceBillAdjustmentView = z.infer<typeof FinanceBillAdjustmentViewSchema>;
export type FinancePaymentAdjustmentView = z.infer<typeof FinancePaymentAdjustmentViewSchema>;
export type FinanceProcurementAdjustmentOption = z.infer<typeof FinanceProcurementAdjustmentOptionSchema>;
