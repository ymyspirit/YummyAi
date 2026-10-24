import { authorize,ForbiddenError,intersectPermissionContexts,Permission,permissionScope } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import { FinanceProfitRunViewSchema,isFinanceProfitVerified,type FinanceProfitBreakdownView,type FinanceProfitBucket,type FinanceProfitCoverageDimension,type FinanceProfitDiagnosticView,type FinanceProfitRunView } from "@yummyai/contracts/finance";
import { buildFinanceCalculationBasis,convertFinanceMinorAmount } from "@yummyai/contracts/finance/monetary";
import { FinanceSourceEntryIdSchema,FinanceSourceIdentitySchema,financeSourceScopeKey,hasFinanceSourceIdentityEvidence } from "@yummyai/contracts/finance/source-identity";
import { financeFacts,financeFxRates,financeProfitContributions,financeProfitMetricVersions,financeProfitRuns,financeStatements,loadCurrentMembershipContext,withTenant,type DatabaseConnection,type TenantTransaction } from "@yummyai/database";
import { asc,desc,eq,getTableColumns,inArray } from "drizzle-orm";
const {sourceInput:omittedSourceInput,...columns}=getTableColumns(financeStatements);
void omittedSourceInput;
export const financeStatementEvidenceColumns=columns;
export type FinanceStatementEvidenceRow=Omit<typeof financeStatements.$inferSelect,"sourceInput">;

type FactRow = typeof financeFacts.$inferSelect;
type RunRow = typeof financeProfitRuns.$inferSelect;
interface CalculatedContribution {
  bucket: FinanceProfitBucket;
  effectSign: -1 | 1;
  fact: FactRow;
  fxRateId: string | null;
  reportingAmountMinor: number | null;
  statement: FinanceStatementEvidenceRow;
  monetaryProblem: "currency_precision_unknown" | "fx_rate_unit_unknown" | null;
}
export async function readRecentFinanceProfitRunRows(tx:TenantTransaction){return tx.select().from(financeProfitRuns).orderBy(desc(financeProfitRuns.calculatedAt)).limit(100);}
export class FinanceProfitReadOwner{
constructor(private readonly database:DatabaseConnection){}
async getProfitRun(context: TenantContext, runId: string): Promise<FinanceProfitRunView> {
    return withTenant(this.database.db, context, async (tx) => {
      await currentFinanceAuthority(tx, context, Permission.FinanceRead);
      const [run] = await tx.select().from(financeProfitRuns)
        .where(eq(financeProfitRuns.id, runId)).limit(1);
      if (!run) throw new OriginalOwnerError(404, "Profit run not found");
      return profitRunView(tx, run);
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
  }
async recent(context:TenantContext):Promise<FinanceProfitRunView[]>{return withTenant(this.database.db,context,async tx=>{await currentFinanceAuthority(tx,context,Permission.FinanceRead);const rows=await readRecentFinanceProfitRunRows(tx);return Promise.all(rows.map(row=>profitRunView(tx,row)));},{isolationLevel:"repeatable read",accessMode:"read write"});}
}
export async function currentFinanceAuthority(tx: TenantTransaction, base: TenantContext, permission: Permission) {
  const current = intersectPermissionContexts(base, await loadCurrentMembershipContext(tx, base, { lock: true }));
  authorize(current, permission);
  if (permissionScope(current, permission) !== "tenant") throw new ForbiddenError(permission, "outside_data_scope");
  return current;
}
export function sameReference(left: string | null, right: string | null) {
  return left?.toLowerCase() === right?.toLowerCase();
}
export function identifiedFinanceFact(fact: FactRow, statement: FinanceStatementEvidenceRow): boolean {
  const source = FinanceSourceIdentitySchema.safeParse(statement.sourceIdentity), entry = FinanceSourceEntryIdSchema.safeParse(fact.sourceEntryId);
  if (!source.success || !entry.success || entry.data !== fact.sourceEntryId || !sameReference(fact.accountId, statement.accountId)) return false;
  try {
    const scope = financeSourceScopeKey({ accountId: statement.accountId, provider: statement.provider, sourceIdentity: source.data });
    return statement.scopeKey === scope && fact.sourceScopeKey === scope && fact.sourceProvider === statement.provider
      && (source.data.kind !== "supplier" || sameReference(fact.supplierId, source.data.supplierId));
  } catch { return false; }
}
export function sumBucket(contributions: CalculatedContribution[], bucket: FinanceProfitBucket): number {
  const total = contributions
    .filter((contribution) => contribution.bucket === bucket)
    .reduce((sum, contribution) =>
      sum + BigInt(contribution.reportingAmountMinor!) * BigInt(contribution.effectSign), 0n);
  return safeNumber(total);
}
export async function profitRunView(
  tx: TenantTransaction,
  run: RunRow,
): Promise<FinanceProfitRunView> {
  const [version] = await tx.select().from(financeProfitMetricVersions)
    .where(eq(financeProfitMetricVersions.id, run.metricVersionId)).limit(1);
  if (!version) throw new OriginalOwnerError(409, "Profit run metric version is missing");
  const contributionRows = await tx.select({
    contribution: financeProfitContributions,
    fact: financeFacts,
    statement: financeStatementEvidenceColumns,
  }).from(financeProfitContributions)
    .innerJoin(financeFacts, eq(financeFacts.id, financeProfitContributions.factId))
    .innerJoin(financeStatements, eq(financeStatements.id, financeFacts.statementId))
    .where(eq(financeProfitContributions.runId, run.id))
    .orderBy(asc(financeFacts.occurredAt), asc(financeFacts.id));
  const calculated: CalculatedContribution[] = contributionRows.map(({ contribution, fact, statement }) => ({
    bucket: contribution.bucket,
    effectSign: contribution.effectSign as -1 | 1,
    fact,
    fxRateId: contribution.fxRateId,
    reportingAmountMinor: contribution.reportingAmountMinor,
    statement,
    monetaryProblem: null,
  }));
  const monetary = await readRunMonetaryDiagnostics(tx, run, contributionRows);
  const sourceIdentity = await readRunSourceDiagnostics(tx, run);
  const diagnostics: FinanceProfitDiagnosticView = { ...run.diagnostics,
    missingFxPairs: monetary.missingFxPairs, monetary: monetary.diagnostics, sourceIdentity };
  // A legacy conversion remains its original evidence, never a newly computed
  // amount. Verification can withdraw the aggregate claim without rewriting it.
  const saved = {
    id: run.id,
    metricId: run.metricId,
    metricVersionId: run.metricVersionId,
    metricVersion: version.versionNumber,
    reportingCurrency: run.reportingCurrency,
    status: run.status as FinanceProfitRunView["status"],
    revenueMinor: run.revenueMinor,
    costMinor: run.costMinor,
    profitMinor: run.profitMinor,
    marginBps: run.marginBps,
    statementIds: run.statementIds,
    fxRateIds: run.fxRateIds,
    diagnostics,
    monetaryBasis: run.monetaryBasis ?? null,
    sourceIdentityVersion: run.sourceIdentityVersion ?? null,
    inputChecksum: run.inputChecksum,
    calculatedAt: run.calculatedAt.toISOString(),
    contributions: contributionRows.map(({ contribution, fact }) => ({
      id: contribution.id,
      factId: fact.id,
      fxRateId: contribution.fxRateId,
      bucket: contribution.bucket,
      sourceAmountMinor: contribution.sourceAmountMinor,
      sourceCurrency: contribution.sourceCurrency,
      reportingAmountMinor: contribution.reportingAmountMinor,
      reportingCurrency: contribution.reportingCurrency,
      effectSign: contribution.effectSign as -1 | 1,
      factType: fact.factType,
      occurredAt: fact.occurredAt.toISOString(),
      orderId: fact.orderId,
      orderLineId: fact.orderLineId,
      skuId: fact.skuId,
      listingId: fact.listingId,
      accountId: fact.accountId,
      supplierId: fact.supplierId,
    })),
    breakdowns: [],
  };
  const verified = isFinanceProfitVerified(saved) && hasFinanceSourceIdentityEvidence(saved);
  return FinanceProfitRunViewSchema.parse({ ...saved, status: verified ? "complete" : "incomplete",
    revenueMinor: verified ? run.revenueMinor : null, costMinor: verified ? run.costMinor : null,
    profitMinor: verified ? run.profitMinor : null, marginBps: verified ? run.marginBps : null,
    breakdowns: verified && diagnostics.coverage?.dimension !== "aggregate"
      ? buildBreakdowns(calculated, diagnostics.coverage?.dimension)
      : [],
  });
}
export async function readRunSourceDiagnostics(tx: TenantTransaction, run: RunRow): Promise<NonNullable<FinanceProfitDiagnosticView["sourceIdentity"]>> {
  const selected = run.statementIds.length ? await tx.select({ fact: financeFacts, statement: financeStatementEvidenceColumns }).from(financeFacts)
    .innerJoin(financeStatements, eq(financeStatements.id, financeFacts.statementId)).where(inArray(financeFacts.statementId, run.statementIds)) : [];
  return { schemaVersion: 1, unidentifiedFactIds: [...new Set([...(run.diagnostics.sourceIdentity?.unidentifiedFactIds ?? []),
    ...selected.filter(row => !identifiedFinanceFact(row.fact, row.statement)).map(row => row.fact.id)])].sort() };
}
export async function readRunMonetaryDiagnostics(tx: TenantTransaction, run: RunRow,
  rows: Array<{ contribution: typeof financeProfitContributions.$inferSelect }>) {
  const currencies = [...new Set([run.reportingCurrency, ...rows.flatMap(({ contribution }) => [contribution.sourceCurrency, contribution.reportingCurrency])])];
  const basis = run.monetaryBasis ?? monetaryExact(() => buildFinanceCalculationBasis(currencies));
  const precision = new Map(basis.currencies.map(entry => [entry.currency, entry.minorDigits]));
  const unknown = new Set([...(run.diagnostics.monetary?.unknownCurrencies ?? []), ...currencies.filter(currency => precision.get(currency) == null)]);
  const ambiguous = new Set(run.diagnostics.monetary?.ambiguousFxRateIds ?? []);
  const missing = new Set(run.diagnostics.missingFxPairs);
  const ids = [...new Set(rows.map(({ contribution }) => contribution.fxRateId).filter((id): id is string => id !== null))];
  const rates = ids.length ? await tx.select().from(financeFxRates).where(inArray(financeFxRates.id, ids)) : [];
  const ratesById = new Map(rates.map(rate => [rate.id, rate]));
  for (const { contribution } of rows) {
    if (contribution.sourceCurrency === contribution.reportingCurrency) continue;
    const rate = contribution.fxRateId ? ratesById.get(contribution.fxRateId) : undefined;
    if (!rate) {
      missing.add(`${contribution.sourceCurrency}/${contribution.reportingCurrency}`);
      continue;
    }
    if (rate.baseCurrency !== contribution.sourceCurrency || rate.quoteCurrency !== contribution.reportingCurrency) {
      ambiguous.add(rate.id);
      continue;
    }
    if (!run.monetaryBasis) {
      // The historical algorithm multiplied minor units directly. It is only
      // numerically unambiguous when both known exponents are equal.
      const sourceDigits = precision.get(contribution.sourceCurrency), targetDigits = precision.get(contribution.reportingCurrency);
      if (sourceDigits != null && targetDigits != null && sourceDigits !== targetDigits) ambiguous.add(rate.id);
      continue;
    }
    const converted = monetaryExact(() => convertFinanceMinorAmount({ amountMinor: contribution.sourceAmountMinor,
      sourceCurrency: contribution.sourceCurrency, targetCurrency: contribution.reportingCurrency,
      rateNumerator: rate.rateNumerator, rateDenominator: rate.rateDenominator, rateBasis: rate.monetaryBasis ?? null,
      calculationBasis: basis }));
    if (converted.problem === "fx_rate_unit_unknown") ambiguous.add(rate.id);
  }
  return { diagnostics: { unknownCurrencies: [...unknown].sort(), ambiguousFxRateIds: [...ambiguous].sort() }, missingFxPairs: [...missing].sort() };
}
export function buildBreakdowns(
  contributions: CalculatedContribution[],
  onlyDimension?: FinanceProfitCoverageDimension,
): FinanceProfitBreakdownView[] {
  const dimensions = [
    ["order", (entry: CalculatedContribution) => entry.fact.orderId],
    ["order_line", (entry: CalculatedContribution) => entry.fact.orderLineId],
    ["sku", (entry: CalculatedContribution) => entry.fact.skuId],
    ["listing", (entry: CalculatedContribution) => entry.fact.listingId],
    ["store", (entry: CalculatedContribution) => entry.fact.accountId],
    ["platform", (entry: CalculatedContribution) => entry.statement.provider],
    ["supplier", (entry: CalculatedContribution) => entry.fact.supplierId],
    ["period", (entry: CalculatedContribution) => entry.fact.occurredAt.toISOString().slice(0, 7)],
  ] as const;
  const result: FinanceProfitBreakdownView[] = [];
  for (const [dimension, keyOf] of dimensions) {
    if (onlyDimension && dimension !== onlyDimension) continue;
    const groups = new Map<string, CalculatedContribution[]>();
    for (const contribution of contributions) {
      const key = keyOf(contribution);
      if (!key || contribution.bucket === "unclassified") continue;
      groups.set(key, [...(groups.get(key) ?? []), contribution]);
    }
    for (const [key, entries] of groups) {
      const revenueMinor = sumBucket(entries, "revenue");
      const costMinor = sumBucket(entries, "cost");
      result.push({
        dimension,
        key,
        revenueMinor,
        costMinor,
        profitMinor: safeNumber(BigInt(revenueMinor) - BigInt(costMinor)),
        factCount: entries.length,
      });
    }
  }
  return result.sort((left, right) =>
    left.dimension.localeCompare(right.dimension) || left.key.localeCompare(right.key));
}
export function safeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    moneyOverflow();
  }
  return result;
}
export function moneyOverflow(): never {
  throw new OriginalOwnerError(422, { code: "finance_money_overflow", message: "财务计算超出支持的精确整数范围 请核对金额或拆分计算范围" });
}
export function monetaryExact<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    if (error.message === "finance_money_overflow") moneyOverflow();
    throw new OriginalOwnerError(422, { code: ["finance_currency_precision_unknown", "finance_fx_ratio_invalid"].includes(error.message)
      ? error.message : "finance_monetary_basis_invalid",
      message: "币种精度或汇率计算依据不完整 请核对原始币种及明确的汇率单位" });
  }
}
