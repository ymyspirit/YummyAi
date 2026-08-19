import {
  RecordFinanceStatementInputSchema,
  type FinanceFactDirection,
  type FinanceFactType,
  type RecordFinanceStatementInput,
} from "@yummyai/contracts/finance";
import { z } from "zod";

const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);

const SettlementTransactionSchema = z.object({
  transactionId: z.string().min(1).max(300),
  amountMinor: z.number().int().nonnegative().safe(),
  currency: CurrencySchema,
  postedAt: z.iso.datetime(),
  externalOrderId: z.string().min(1).max(300).nullable().default(null),
}).strict();

const AmazonSettlementTransactionSchema = SettlementTransactionSchema.extend({
  type: z.enum([
    "product_price",
    "shipping",
    "commission",
    "advertising",
    "fba_fulfillment_fee",
    "storage_fee",
    "refund",
    "chargeback",
    "tax",
    "other_fee",
  ]),
}).strict();

const EtsySettlementTransactionSchema = SettlementTransactionSchema.extend({
  type: z.enum([
    "sale",
    "shipping",
    "transaction_fee",
    "payment_processing_fee",
    "offsite_ads_fee",
    "refund",
    "chargeback",
    "tax",
    "other_fee",
  ]),
}).strict();

export const ProviderFinanceStatementSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("amazon"),
    externalStatementId: z.string().min(1).max(300),
    periodStart: z.iso.datetime(),
    periodEnd: z.iso.datetime(),
    observedAt: z.iso.datetime(),
    currency: CurrencySchema,
    transactions: z.array(AmazonSettlementTransactionSchema).min(1).max(20_000),
  }).strict(),
  z.object({
    provider: z.literal("etsy"),
    externalStatementId: z.string().min(1).max(300),
    periodStart: z.iso.datetime(),
    periodEnd: z.iso.datetime(),
    observedAt: z.iso.datetime(),
    currency: CurrencySchema,
    transactions: z.array(EtsySettlementTransactionSchema).min(1).max(20_000),
  }).strict(),
]);

export const NormalizeProviderFinanceStatementInputSchema = z.object({
  accountId: z.uuidv7(),
  idempotencyKey: z.string().trim().min(8).max(200),
  statement: ProviderFinanceStatementSchema,
}).strict();

export function normalizeProviderFinanceStatement(
  rawInput: z.input<typeof NormalizeProviderFinanceStatementInputSchema>,
): RecordFinanceStatementInput {
  const input = NormalizeProviderFinanceStatementInputSchema.parse(rawInput);
  const lines = input.statement.provider === "amazon"
    ? input.statement.transactions.map((transaction) => {
      const classification = amazonClassification(transaction.type);
      return {
        lineKey: transaction.transactionId,
        factType: classification.factType,
        direction: classification.direction,
        amountMinor: transaction.amountMinor,
        currency: transaction.currency,
        occurredAt: transaction.postedAt,
        externalReference: transaction.externalOrderId,
        orderId: null,
        orderLineId: null,
        skuId: null,
        listingId: null,
        supplierId: null,
        correctionKind: "original" as const,
        correctsFactId: null,
      };
    })
    : input.statement.transactions.map((transaction) => {
      const classification = etsyClassification(transaction.type);
      return {
      lineKey: transaction.transactionId,
      factType: classification.factType,
      direction: classification.direction,
      amountMinor: transaction.amountMinor,
      currency: transaction.currency,
      occurredAt: transaction.postedAt,
      externalReference: transaction.externalOrderId,
      orderId: null,
      orderLineId: null,
      skuId: null,
      listingId: null,
      supplierId: null,
      correctionKind: "original" as const,
      correctsFactId: null,
      };
    });
  return RecordFinanceStatementInputSchema.parse({
    accountId: input.accountId,
    provider: input.statement.provider,
    statementKind: "marketplace_settlement",
    externalStatementId: input.statement.externalStatementId,
    periodStart: input.statement.periodStart,
    periodEnd: input.statement.periodEnd,
    sourceCurrency: input.statement.currency,
    observedAt: input.statement.observedAt,
    idempotencyKey: input.idempotencyKey,
    lines,
  });
}

function amazonClassification(type: z.infer<typeof AmazonSettlementTransactionSchema>["type"]) {
  const mapping: Record<typeof type, [FinanceFactType, FinanceFactDirection]> = {
    product_price: ["sale_revenue", "credit"],
    shipping: ["shipping_revenue", "credit"],
    commission: ["marketplace_commission", "debit"],
    advertising: ["advertising_spend", "debit"],
    fba_fulfillment_fee: ["fulfillment_fee", "debit"],
    storage_fee: ["storage_fee", "debit"],
    refund: ["refund", "debit"],
    chargeback: ["chargeback", "debit"],
    tax: ["tax", "debit"],
    other_fee: ["other_fee", "debit"],
  };
  const [factType, direction] = mapping[type];
  return { factType, direction };
}

function etsyClassification(type: z.infer<typeof EtsySettlementTransactionSchema>["type"]) {
  const mapping: Record<typeof type, [FinanceFactType, FinanceFactDirection]> = {
    sale: ["sale_revenue", "credit"],
    shipping: ["shipping_revenue", "credit"],
    transaction_fee: ["marketplace_commission", "debit"],
    payment_processing_fee: ["other_fee", "debit"],
    offsite_ads_fee: ["advertising_spend", "debit"],
    refund: ["refund", "debit"],
    chargeback: ["chargeback", "debit"],
    tax: ["tax", "debit"],
    other_fee: ["other_fee", "debit"],
  };
  const [factType, direction] = mapping[type];
  return { factType, direction };
}

export type ProviderFinanceStatement = z.infer<typeof ProviderFinanceStatementSchema>;
