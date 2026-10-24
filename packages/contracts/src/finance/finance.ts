import { z } from "zod";

import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { FinanceSourceIdentitySchema, FinanceSourceEntryIdSchema, FinanceSourceDiagnosticSchema,
  financeSourceScopeKey, hasFinanceSourceIdentityEvidence } from "@yummyai/contracts/finance/source-identity";
import { FinanceCurrencySchema, FinanceFxMonetaryBasisSchema, FinanceCalculationMonetaryBasisSchema, FinanceMonetaryDiagnosticSchema,
  hasFinanceMonetaryEvidence } from "@yummyai/contracts/finance/monetary";

const CurrencySchema = FinanceCurrencySchema;
const IdempotencyKeySchema = z.string().trim().min(8).max(200);
const MoneyMinorSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const CodeSchema = z.string().trim().min(1).max(100).regex(/^[A-Z0-9][A-Z0-9._-]*$/);

export const FinanceStatementProviderSchema = z.enum([
  "amazon",
  "etsy",
  "advertising",
  "carrier",
  "supplier",
  "tax_authority",
  "manual",
]);

export const FinanceStatementKindSchema = z.enum([
  "marketplace_settlement",
  "advertising_invoice",
  "fulfillment_invoice",
  "carrier_invoice",
  "supplier_invoice",
  "tax_statement",
  "operational_cost",
  "manual_adjustment",
]);

export const FinanceFactTypeSchema = z.enum([
  "sale_revenue",
  "shipping_revenue",
  "marketplace_commission",
  "advertising_spend",
  "fulfillment_fee",
  "storage_fee",
  "refund",
  "chargeback",
  "procurement_cost",
  "production_cost",
  "freight_cost",
  "carrier_cost",
  "tax",
  "other_fee",
]);

export const FinanceFactDirectionSchema = z.enum(["credit", "debit"]);
export const FinanceCorrectionKindSchema = z.enum(["original", "reversal", "replacement"]);
export const FinanceProfitStatusSchema = z.enum(["complete", "incomplete"]);
export const FinanceProfitBucketSchema = z.enum(["revenue", "cost", "unclassified"]);
export const FinanceProfitCoverageDimensionSchema = z.enum(["aggregate", "order", "order_line", "sku", "listing"]);
export const FinanceProfitDimensionSchema = z.enum([
  "order",
  "order_line",
  "sku",
  "listing",
  "store",
  "platform",
  "supplier",
  "period",
]);

const FinanceFactFieldsSchema = z.object({
  sourceEntryId: FinanceSourceEntryIdSchema.optional(),
  lineKey: z.string().trim().min(1).max(300),
  factType: FinanceFactTypeSchema,
  direction: FinanceFactDirectionSchema,
  amountMinor: MoneyMinorSchema,
  currency: CurrencySchema,
  occurredAt: z.iso.datetime(),
  externalReference: z.string().trim().min(1).max(300).nullable(),
  orderId: EntityIdSchema.nullable(),
  orderLineId: EntityIdSchema.nullable(),
  skuId: EntityIdSchema.nullable(),
  listingId: EntityIdSchema.nullable(),
  supplierId: EntityIdSchema.nullable(),
  correctionKind: FinanceCorrectionKindSchema.default("original"),
  correctsFactId: EntityIdSchema.nullable().default(null),
}).strict();

function refineFinanceFact(value: { correctionKind: string; correctsFactId: string | null; orderId: string | null; orderLineId: string | null }, context: z.RefinementCtx) {
  if ((value.correctionKind === "original") !== (value.correctsFactId === null)) {
    context.addIssue({
      code: "custom",
      path: ["correctsFactId"],
      message: "Only reversal or replacement facts may reference a corrected fact",
    });
  }
  if (value.orderLineId && !value.orderId) {
    context.addIssue({
      code: "custom",
      path: ["orderId"],
      message: "Order-line finance facts require the parent order",
    });
  }
}

export const FinanceFactInputSchema = FinanceFactFieldsSchema.superRefine(refineFinanceFact);

export const RecordFinanceStatementInputSchema = z.object({
  sourceIdentity: FinanceSourceIdentitySchema.optional(),
  accountId: EntityIdSchema.nullable(),
  provider: FinanceStatementProviderSchema,
  statementKind: FinanceStatementKindSchema,
  externalStatementId: z.string().trim().min(1).max(300),
  periodStart: z.iso.datetime(),
  periodEnd: z.iso.datetime(),
  sourceCurrency: CurrencySchema,
  observedAt: z.iso.datetime(),
  idempotencyKey: IdempotencyKeySchema,
  lines: z.array(FinanceFactInputSchema).min(1).max(20_000),
}).strict().superRefine((value, context) => {
  if (value.sourceIdentity) {
    const dates = [value.periodStart, value.periodEnd, value.observedAt, ...value.lines.map(line => line.occurredAt)];
    if (dates.some(date => new Date(date).getUTCFullYear() < 1 || /\.(\d{3}\d*[1-9]\d*)Z$/.test(date))) {
      context.addIssue({ code: "custom", path: ["observedAt"], message: "Source evidence dates must retain exact millisecond precision and supported calendar years" });
    }
    try { financeSourceScopeKey({ ...value, sourceIdentity: value.sourceIdentity }); }
    catch { context.addIssue({ code: "custom", path: ["sourceIdentity"], message: "Source identity must match its provider and account" }); }
    if (value.lines.some(line => !line.sourceEntryId)
      || new Set(value.lines.map(line => line.sourceEntryId)).size !== value.lines.length) {
      context.addIssue({ code: "custom", path: ["lines"], message: "Versioned statements require unique stable source entry IDs" });
    }
    const source = value.sourceIdentity;
    if (source.kind === "supplier" && value.lines.some(line => line.supplierId?.toLowerCase() !== source.supplierId.toLowerCase())) {
      context.addIssue({ code: "custom", path: ["lines"], message: "Every supplier entry must retain its source supplier" });
    }
  } else if (value.lines.some(line => line.sourceEntryId !== undefined)) {
    context.addIssue({ code: "custom", path: ["sourceIdentity"], message: "Source entry IDs require versioned source identity" });
  }
  if (new Date(value.periodEnd) < new Date(value.periodStart)) {
    context.addIssue({ code: "custom", path: ["periodEnd"], message: "Statement period end must not precede its start" });
  }
  if (new Set(value.lines.map((line) => line.lineKey)).size !== value.lines.length) {
    context.addIssue({ code: "custom", path: ["lines"], message: "Statement line keys must be unique" });
  }
  value.lines.forEach((line, index) => {
    if (line.currency !== value.sourceCurrency) {
      context.addIssue({
        code: "custom",
        path: ["lines", index, "currency"],
        message: "Every normalized line must retain the statement source currency",
      });
    }
  });
});

export const RecordFinanceFxRateInputSchema = z.object({
  rateUnit: z.literal("major_to_major").optional(),
  source: CodeSchema,
  baseCurrency: CurrencySchema,
  quoteCurrency: CurrencySchema,
  rateNumerator: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  rateDenominator: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  effectiveAt: z.iso.datetime(),
  retrievedAt: z.iso.datetime(),
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => {
  if (value.baseCurrency === value.quoteCurrency) {
    context.addIssue({ code: "custom", path: ["quoteCurrency"], message: "FX currency pair must contain two currencies" });
  }
  if (new Date(value.retrievedAt) < new Date(value.effectiveAt)) {
    context.addIssue({ code: "custom", path: ["retrievedAt"], message: "FX retrieval time must not precede its effective time" });
  }
});

export const UpsertFinanceProfitMetricInputSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
  metricId: EntityIdSchema.nullable().default(null),
  name: z.string().trim().min(1).max(160),
  reportingCurrency: CurrencySchema,
  revenueFactTypes: z.array(FinanceFactTypeSchema).min(1),
  costFactTypes: z.array(FinanceFactTypeSchema).min(1),
  requiredFactTypes: z.array(FinanceFactTypeSchema),
  reasonCode: CodeSchema,
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => {
  const revenue = new Set(value.revenueFactTypes);
  const cost = new Set(value.costFactTypes);
  if (revenue.size !== value.revenueFactTypes.length) {
    context.addIssue({ code: "custom", path: ["revenueFactTypes"], message: "Revenue fact types must be unique" });
  }
  if (cost.size !== value.costFactTypes.length) {
    context.addIssue({ code: "custom", path: ["costFactTypes"], message: "Cost fact types must be unique" });
  }
  const overlap = [...revenue].filter((type) => cost.has(type));
  if (overlap.length) {
    context.addIssue({ code: "custom", path: ["costFactTypes"], message: "A fact type cannot be both revenue and cost" });
  }
  const classified = new Set([...revenue, ...cost]);
  if (new Set(value.requiredFactTypes).size !== value.requiredFactTypes.length) {
    context.addIssue({ code: "custom", path: ["requiredFactTypes"], message: "Required fact types must be unique" });
  }
  if (value.requiredFactTypes.some((type) => !classified.has(type))) {
    context.addIssue({ code: "custom", path: ["requiredFactTypes"], message: "Required fact types must be classified by the metric" });
  }
});

export const CalculateFinanceProfitInputSchema = z.object({
  metricId: EntityIdSchema,
  expectedMetricVersion: z.number().int().positive(),
  statementIds: z.array(EntityIdSchema).min(1).max(500),
  fxRateIds: z.array(EntityIdSchema).max(500),
  // Omission is handled as order coverage by the service, never aggregate coverage.
  coverageDimension: FinanceProfitCoverageDimensionSchema.optional(),
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.statementIds).size !== value.statementIds.length) {
    context.addIssue({ code: "custom", path: ["statementIds"], message: "Statement IDs must be unique" });
  }
  if (new Set(value.fxRateIds).size !== value.fxRateIds.length) {
    context.addIssue({ code: "custom", path: ["fxRateIds"], message: "FX rate IDs must be unique" });
  }
});

export const FinanceFactViewSchema = FinanceFactFieldsSchema.extend({
  sourceEntryId: FinanceSourceEntryIdSchema.nullable().optional(),
  id: EntityIdSchema,
  statementId: EntityIdSchema,
  accountId: EntityIdSchema.nullable(),
  recordedAt: z.iso.datetime(),
}).strict().superRefine(refineFinanceFact);

export const FinanceStatementViewSchema = z.object({
  sourceIdentity: FinanceSourceIdentitySchema.nullable().optional(),
  id: EntityIdSchema,
  accountId: EntityIdSchema.nullable(),
  provider: FinanceStatementProviderSchema,
  statementKind: FinanceStatementKindSchema,
  externalStatementId: z.string(),
  periodStart: z.iso.datetime(),
  periodEnd: z.iso.datetime(),
  sourceCurrency: CurrencySchema,
  observedAt: z.iso.datetime(),
  recordedAt: z.iso.datetime(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  lines: z.array(FinanceFactViewSchema),
}).strict();

export const FinanceFxRateViewSchema = z.object({
  monetaryBasis: FinanceFxMonetaryBasisSchema.nullable().optional(),
  id: EntityIdSchema,
  source: z.string(),
  baseCurrency: CurrencySchema,
  quoteCurrency: CurrencySchema,
  rateNumerator: z.number().int().positive(),
  rateDenominator: z.number().int().positive(),
  effectiveAt: z.iso.datetime(),
  retrievedAt: z.iso.datetime(),
  recordedAt: z.iso.datetime(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const FinanceProfitMetricVersionViewSchema = z.object({
  id: EntityIdSchema,
  metricId: EntityIdSchema,
  versionNumber: z.number().int().positive(),
  reportingCurrency: CurrencySchema,
  revenueFactTypes: z.array(FinanceFactTypeSchema),
  costFactTypes: z.array(FinanceFactTypeSchema),
  requiredFactTypes: z.array(FinanceFactTypeSchema),
  reasonCode: z.string(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
}).strict();

export const FinanceProfitMetricViewSchema = z.object({
  id: EntityIdSchema,
  name: z.string(),
  currentVersion: z.number().int().positive(),
  status: z.enum(["active", "inactive"]),
  version: FinanceProfitMetricVersionViewSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();

export const FinanceProfitDiagnosticViewSchema = z.object({
  sourceIdentity: FinanceSourceDiagnosticSchema.optional(),
  monetary: FinanceMonetaryDiagnosticSchema.optional(),
  missingFactTypes: z.array(FinanceFactTypeSchema),
  missingFxPairs: z.array(z.string()),
  unclassifiedFactTypes: z.array(FinanceFactTypeSchema),
  coverage: z.object({
    dimension: FinanceProfitCoverageDimensionSchema,
    checkedEntityCount: z.number().int().nonnegative(),
    missingByEntity: z.array(z.object({ key: z.string(), missingFactTypes: z.array(FinanceFactTypeSchema) }).strict()),
    unattributedFactIds: z.array(EntityIdSchema),
  }).strict().optional(),
}).strict();

export const FinanceProfitContributionViewSchema = z.object({
  id: EntityIdSchema,
  factId: EntityIdSchema,
  fxRateId: EntityIdSchema.nullable(),
  bucket: FinanceProfitBucketSchema,
  sourceAmountMinor: MoneyMinorSchema,
  sourceCurrency: CurrencySchema,
  reportingAmountMinor: MoneyMinorSchema.nullable(),
  reportingCurrency: CurrencySchema,
  effectSign: z.union([z.literal(-1), z.literal(1)]),
  factType: FinanceFactTypeSchema,
  occurredAt: z.iso.datetime(),
  orderId: EntityIdSchema.nullable(),
  orderLineId: EntityIdSchema.nullable(),
  skuId: EntityIdSchema.nullable(),
  listingId: EntityIdSchema.nullable(),
  accountId: EntityIdSchema.nullable(),
  supplierId: EntityIdSchema.nullable(),
}).strict();

export const FinanceProfitBreakdownViewSchema = z.object({
  dimension: FinanceProfitDimensionSchema,
  key: z.string(),
  revenueMinor: z.number().int().safe(),
  costMinor: z.number().int().safe(),
  profitMinor: z.number().int().safe(),
  factCount: z.number().int().positive(),
}).strict();

export const FinanceProfitRunViewSchema = z.object({
  sourceIdentityVersion: z.literal(1).nullable().optional(),
  monetaryBasis: FinanceCalculationMonetaryBasisSchema.nullable().optional(),
  id: EntityIdSchema,
  metricId: EntityIdSchema,
  metricVersionId: EntityIdSchema,
  metricVersion: z.number().int().positive(),
  reportingCurrency: CurrencySchema,
  status: FinanceProfitStatusSchema,
  revenueMinor: z.number().int().safe().nullable(),
  costMinor: z.number().int().safe().nullable(),
  profitMinor: z.number().int().safe().nullable(),
  marginBps: z.number().int().nullable(),
  statementIds: z.array(EntityIdSchema),
  fxRateIds: z.array(EntityIdSchema),
  diagnostics: FinanceProfitDiagnosticViewSchema,
  inputChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  calculatedAt: z.iso.datetime(),
  contributions: z.array(FinanceProfitContributionViewSchema),
  breakdowns: z.array(FinanceProfitBreakdownViewSchema),
}).strict();

export const FinanceWorkspaceViewSchema = z.object({
  statements: z.array(FinanceStatementViewSchema),
  fxRates: z.array(FinanceFxRateViewSchema),
  metrics: z.array(FinanceProfitMetricViewSchema),
  runs: z.array(FinanceProfitRunViewSchema),
}).strict();

export type FinanceStatementProvider = z.infer<typeof FinanceStatementProviderSchema>;
export type FinanceStatementKind = z.infer<typeof FinanceStatementKindSchema>;
export type FinanceFactType = z.infer<typeof FinanceFactTypeSchema>;
export type FinanceFactDirection = z.infer<typeof FinanceFactDirectionSchema>;
export type FinanceCorrectionKind = z.infer<typeof FinanceCorrectionKindSchema>;
export type FinanceProfitStatus = z.infer<typeof FinanceProfitStatusSchema>;
export type FinanceProfitBucket = z.infer<typeof FinanceProfitBucketSchema>;
export type FinanceProfitDimension = z.infer<typeof FinanceProfitDimensionSchema>;
export type FinanceProfitCoverageDimension = z.infer<typeof FinanceProfitCoverageDimensionSchema>;
export type FinanceFactInput = z.infer<typeof FinanceFactInputSchema>;
export type RecordFinanceStatementInput = z.infer<typeof RecordFinanceStatementInputSchema>;
export type RecordFinanceFxRateInput = z.infer<typeof RecordFinanceFxRateInputSchema>;
export type UpsertFinanceProfitMetricInput = z.infer<typeof UpsertFinanceProfitMetricInputSchema>;
export type CalculateFinanceProfitInput = z.infer<typeof CalculateFinanceProfitInputSchema>;
export type FinanceFactView = z.infer<typeof FinanceFactViewSchema>;
export type FinanceStatementView = z.infer<typeof FinanceStatementViewSchema>;
export type FinanceFxRateView = z.infer<typeof FinanceFxRateViewSchema>;
export type FinanceProfitMetricVersionView = z.infer<typeof FinanceProfitMetricVersionViewSchema>;
export type FinanceProfitMetricView = z.infer<typeof FinanceProfitMetricViewSchema>;
export type FinanceProfitDiagnosticView = z.infer<typeof FinanceProfitDiagnosticViewSchema>;
export type FinanceProfitContributionView = z.infer<typeof FinanceProfitContributionViewSchema>;
export type FinanceProfitBreakdownView = z.infer<typeof FinanceProfitBreakdownViewSchema>;
export type FinanceProfitRunView = z.infer<typeof FinanceProfitRunViewSchema>;
export type FinanceWorkspaceView = z.infer<typeof FinanceWorkspaceViewSchema>;

/** Only selected, unreversed evidence can satisfy a required fact type. */
export function evaluateFinanceCoverage(
  facts: Array<Pick<FinanceFactView, "id" | "factType" | "orderId" | "orderLineId" | "skuId" | "listingId" | "correctionKind" | "correctsFactId">>,
  requiredFactTypes: FinanceFactType[],
  dimension: FinanceProfitCoverageDimension,
): NonNullable<FinanceProfitDiagnosticView["coverage"]> {
  const reversed = new Set(facts.filter((fact) => fact.correctionKind === "reversal").map((fact) => fact.correctsFactId));
  const effective = facts.filter((fact) => fact.correctionKind !== "reversal" && !reversed.has(fact.id));
  if (dimension === "aggregate") {
    const present = new Set(effective.map((fact) => fact.factType));
    const missingFactTypes = requiredFactTypes.filter((type) => !present.has(type)).sort();
    return { dimension, checkedEntityCount: 1, missingByEntity: missingFactTypes.length ? [{ key: "aggregate", missingFactTypes }] : [], unattributedFactIds: [] };
  }
  const field = ({ order: "orderId", order_line: "orderLineId", sku: "skuId", listing: "listingId" } as const)[dimension];
  const groups = new Map<string, Set<FinanceFactType>>();
  // Retain every represented object, including one whose cost was completely reversed.
  for (const fact of facts) if (fact[field]) groups.set(fact[field], new Set());
  for (const fact of effective) if (fact[field]) groups.get(fact[field])!.add(fact.factType);
  return {
    dimension,
    checkedEntityCount: groups.size,
    missingByEntity: [...groups].sort(([left], [right]) => left.localeCompare(right)).flatMap(([key, types]) => {
      const missingFactTypes = requiredFactTypes.filter((type) => !types.has(type)).sort();
      return missingFactTypes.length ? [{ key, missingFactTypes }] : [];
    }),
    unattributedFactIds: facts.filter((fact) => !fact[field]).map((fact) => fact.id).sort(),
  };
}

export function isFinanceProfitVerified(run: Pick<FinanceProfitRunView, "status" | "diagnostics"> & Partial<Pick<FinanceProfitRunView, "monetaryBasis" | "contributions" | "reportingCurrency" | "sourceIdentityVersion">>): boolean {
  const coverage = run.diagnostics?.coverage;
  return run.status === "complete" && !!coverage && coverage.checkedEntityCount > 0
    && !coverage.missingByEntity.length && !coverage.unattributedFactIds.length
    && !run.diagnostics.missingFactTypes.length && !run.diagnostics.missingFxPairs.length
    && !run.diagnostics.unclassifiedFactTypes.length
    && !run.diagnostics.monetary?.unknownCurrencies.length && !run.diagnostics.monetary?.ambiguousFxRateIds.length
    && hasFinanceMonetaryEvidence(run) && hasFinanceSourceIdentityEvidence(run);
}

export function financeCoverageLabel(dimension?: FinanceProfitCoverageDimension): string {
  return dimension ? ({ aggregate: "账单汇总（未验证逐单成本）", order: "逐订单", order_line: "逐订单行", sku: "逐 SKU", listing: "逐 Listing" })[dimension] : "旧计算未验证归属，请重算";
}
