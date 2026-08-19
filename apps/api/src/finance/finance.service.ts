import { createHash } from "node:crypto";

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  CalculateFinanceProfitInputSchema,
  FinanceFxRateViewSchema,
  FinanceProfitMetricViewSchema,
  FinanceProfitRunViewSchema,
  FinanceStatementViewSchema,
  FinanceWorkspaceViewSchema,
  RecordFinanceFxRateInputSchema,
  RecordFinanceStatementInputSchema,
  UpsertFinanceProfitMetricInputSchema,
  type CalculateFinanceProfitInput,
  type FinanceFactInput,
  type FinanceFxRateView,
  type FinanceProfitBreakdownView,
  type FinanceProfitBucket,
  type FinanceProfitDiagnosticView,
  type FinanceProfitMetricView,
  type FinanceProfitRunView,
  type FinanceStatementView,
  type FinanceWorkspaceView,
  type RecordFinanceFxRateInput,
  type RecordFinanceStatementInput,
  type UpsertFinanceProfitMetricInput,
} from "@yummyai/contracts/finance";
import {
  financeFacts,
  financeFxRates,
  financeProfitContributions,
  financeProfitMetrics,
  financeProfitMetricVersions,
  financeProfitRuns,
  financeStatements,
  fulfillmentSuppliers,
  listings,
  marketplaceAccounts,
  orderLines,
  orders,
  skus,
  type DatabaseConnection,
  type TenantTransaction,
  withTenant,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

type StatementRow = typeof financeStatements.$inferSelect;
type FactRow = typeof financeFacts.$inferSelect;
type FxRateRow = typeof financeFxRates.$inferSelect;
type MetricRow = typeof financeProfitMetrics.$inferSelect;
type MetricVersionRow = typeof financeProfitMetricVersions.$inferSelect;
type RunRow = typeof financeProfitRuns.$inferSelect;

interface CalculatedContribution {
  bucket: FinanceProfitBucket;
  effectSign: -1 | 1;
  fact: FactRow;
  fxRateId: string | null;
  reportingAmountMinor: number | null;
  statement: StatementRow;
}

@Injectable()
export class FinanceService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async recordStatement(
    context: TenantContext,
    rawInput: RecordFinanceStatementInput,
  ): Promise<FinanceStatementView> {
    const input = RecordFinanceStatementInputSchema.parse(rawInput);
    const lines = [...input.lines].sort((left, right) => left.lineKey.localeCompare(right.lineKey));
    const scopeKey = input.accountId ?? input.provider;
    const statementChecksum = checksum({
      accountId: input.accountId,
      provider: input.provider,
      statementKind: input.statementKind,
      externalStatementId: input.externalStatementId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      sourceCurrency: input.sourceCurrency,
      observedAt: input.observedAt,
      lines,
    });
    const statement = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `finance-statement:${context.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(financeStatements)
        .where(eq(financeStatements.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        if (replayed.checksum !== statementChecksum) {
          throw new ConflictException("Finance statement idempotency key was reused with different evidence");
        }
        return replayed;
      }
      const [sameExternal] = await tx.select().from(financeStatements).where(and(
        eq(financeStatements.provider, input.provider),
        eq(financeStatements.scopeKey, scopeKey),
        eq(financeStatements.externalStatementId, input.externalStatementId),
      )).limit(1);
      if (sameExternal) {
        if (sameExternal.checksum !== statementChecksum) {
          throw new ConflictException("Provider statement identity was reused with different evidence");
        }
        return sameExternal;
      }
      await validateStatementReferences(tx, input);
      await validateCorrections(tx, lines);
      const [created] = await tx.insert(financeStatements).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        accountId: input.accountId,
        provider: input.provider,
        statementKind: input.statementKind,
        externalStatementId: input.externalStatementId,
        scopeKey,
        periodStart: new Date(input.periodStart),
        periodEnd: new Date(input.periodEnd),
        sourceCurrency: input.sourceCurrency,
        observedAt: new Date(input.observedAt),
        checksum: statementChecksum,
        idempotencyKey: input.idempotencyKey,
        recordedBy: context.userId,
      }).returning();
      await tx.insert(financeFacts).values(lines.map((line) => ({
        id: createEntityId(),
        tenantId: context.tenantId,
        statementId: created!.id,
        accountId: input.accountId,
        lineKey: line.lineKey,
        factType: line.factType,
        direction: line.direction,
        amountMinor: line.amountMinor,
        currency: line.currency,
        occurredAt: new Date(line.occurredAt),
        externalReference: line.externalReference,
        orderId: line.orderId,
        orderLineId: line.orderLineId,
        skuId: line.skuId,
        listingId: line.listingId,
        supplierId: line.supplierId,
        correctionKind: line.correctionKind,
        correctsFactId: line.correctsFactId,
      })));
      return created!;
    });
    const view = await this.getStatement(context, statement.id);
    await this.audit.record(context, {
      action: "finance.statement.record",
      resourceType: "finance_statement",
      resourceId: view.id,
      result: "success",
      metadata: {
        provider: view.provider,
        statementKind: view.statementKind,
        lineCount: view.lines.length,
      },
    });
    return view;
  }

  async getStatement(context: TenantContext, statementId: string): Promise<FinanceStatementView> {
    return withTenant(this.database.db, context, async (tx) => {
      const [statement] = await tx.select().from(financeStatements)
        .where(eq(financeStatements.id, statementId)).limit(1);
      if (!statement) throw new NotFoundException("Finance statement not found");
      return statementView(tx, statement);
    });
  }

  async recordFxRate(
    context: TenantContext,
    rawInput: RecordFinanceFxRateInput,
  ): Promise<FinanceFxRateView> {
    const input = RecordFinanceFxRateInputSchema.parse(rawInput);
    const rateChecksum = checksum({
      source: input.source,
      baseCurrency: input.baseCurrency,
      quoteCurrency: input.quoteCurrency,
      rateNumerator: input.rateNumerator,
      rateDenominator: input.rateDenominator,
      effectiveAt: input.effectiveAt,
      retrievedAt: input.retrievedAt,
    });
    const rate = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `finance-fx-rate:${context.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(financeFxRates)
        .where(eq(financeFxRates.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        if (replayed.checksum !== rateChecksum) {
          throw new ConflictException("FX rate idempotency key was reused with different evidence");
        }
        return replayed;
      }
      const [sameRate] = await tx.select().from(financeFxRates).where(and(
        eq(financeFxRates.source, input.source),
        eq(financeFxRates.baseCurrency, input.baseCurrency),
        eq(financeFxRates.quoteCurrency, input.quoteCurrency),
        eq(financeFxRates.effectiveAt, new Date(input.effectiveAt)),
        eq(financeFxRates.retrievedAt, new Date(input.retrievedAt)),
      )).limit(1);
      if (sameRate) {
        if (sameRate.checksum !== rateChecksum) {
          throw new ConflictException("FX rate identity was reused with different evidence");
        }
        return sameRate;
      }
      const [created] = await tx.insert(financeFxRates).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        source: input.source,
        baseCurrency: input.baseCurrency,
        quoteCurrency: input.quoteCurrency,
        rateNumerator: input.rateNumerator,
        rateDenominator: input.rateDenominator,
        effectiveAt: new Date(input.effectiveAt),
        retrievedAt: new Date(input.retrievedAt),
        checksum: rateChecksum,
        idempotencyKey: input.idempotencyKey,
        recordedBy: context.userId,
      }).returning();
      return created!;
    });
    const view = fxRateView(rate);
    await this.audit.record(context, {
      action: "finance.fx_rate.record",
      resourceType: "finance_fx_rate",
      resourceId: view.id,
      result: "success",
      metadata: {
        source: view.source,
        pair: `${view.baseCurrency}/${view.quoteCurrency}`,
        effectiveAt: view.effectiveAt,
      },
    });
    return view;
  }

  async upsertProfitMetric(
    context: TenantContext,
    rawInput: UpsertFinanceProfitMetricInput,
  ): Promise<FinanceProfitMetricView> {
    const input = UpsertFinanceProfitMetricInputSchema.parse(rawInput);
    const versionChecksum = checksum({
      name: input.name,
      reportingCurrency: input.reportingCurrency,
      revenueFactTypes: [...input.revenueFactTypes].sort(),
      costFactTypes: [...input.costFactTypes].sort(),
      requiredFactTypes: [...input.requiredFactTypes].sort(),
      reasonCode: input.reasonCode,
    });
    const metric = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `finance-profit-metric:${context.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(financeProfitMetricVersions)
        .where(eq(financeProfitMetricVersions.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        if (replayed.checksum !== versionChecksum) {
          throw new ConflictException("Profit metric idempotency key was reused with different rules");
        }
        const [existing] = await tx.select().from(financeProfitMetrics)
          .where(eq(financeProfitMetrics.id, replayed.metricId)).limit(1);
        if (!existing) throw new ConflictException("Profit metric projection is missing");
        return existing;
      }
      let existing: MetricRow | undefined;
      if (input.metricId) {
        [existing] = await tx.select().from(financeProfitMetrics)
          .where(eq(financeProfitMetrics.id, input.metricId)).limit(1);
        if (!existing) throw new NotFoundException("Profit metric not found");
      } else {
        [existing] = await tx.select().from(financeProfitMetrics)
          .where(eq(financeProfitMetrics.name, input.name)).limit(1);
        if (existing) throw new ConflictException("A profit metric with this name already exists");
      }
      const nextVersion = (existing?.currentVersion ?? 0) + 1;
      const metricId = existing?.id ?? createEntityId();
      if (!existing) {
        [existing] = await tx.insert(financeProfitMetrics).values({
          id: metricId,
          tenantId: context.tenantId,
          name: input.name,
          currentVersion: nextVersion,
          createdBy: context.userId,
        }).returning();
      }
      await tx.insert(financeProfitMetricVersions).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        metricId,
        versionNumber: nextVersion,
        reportingCurrency: input.reportingCurrency,
        revenueFactTypes: [...input.revenueFactTypes].sort(),
        costFactTypes: [...input.costFactTypes].sort(),
        requiredFactTypes: [...input.requiredFactTypes].sort(),
        reasonCode: input.reasonCode,
        checksum: versionChecksum,
        idempotencyKey: input.idempotencyKey,
        createdBy: context.userId,
      });
      if (existing.currentVersion !== nextVersion || existing.name !== input.name) {
        [existing] = await tx.update(financeProfitMetrics).set({
          name: input.name,
          currentVersion: nextVersion,
          updatedAt: new Date(),
        }).where(eq(financeProfitMetrics.id, metricId)).returning();
      }
      return existing!;
    });
    const view = await this.getProfitMetric(context, metric.id);
    await this.audit.record(context, {
      action: "finance.profit_metric.version",
      resourceType: "finance_profit_metric",
      resourceId: view.id,
      result: "success",
      metadata: { version: view.currentVersion, reportingCurrency: view.version.reportingCurrency },
    });
    return view;
  }

  async getProfitMetric(context: TenantContext, metricId: string): Promise<FinanceProfitMetricView> {
    return withTenant(this.database.db, context, async (tx) => {
      const [metric] = await tx.select().from(financeProfitMetrics)
        .where(eq(financeProfitMetrics.id, metricId)).limit(1);
      if (!metric) throw new NotFoundException("Profit metric not found");
      return metricView(tx, metric);
    });
  }

  async calculateProfit(
    context: TenantContext,
    rawInput: CalculateFinanceProfitInput,
  ): Promise<FinanceProfitRunView> {
    const input = CalculateFinanceProfitInputSchema.parse(rawInput);
    const run = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `finance-profit-run:${context.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(financeProfitRuns)
        .where(eq(financeProfitRuns.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        const replayChecksum = await profitInputChecksum(tx, input);
        if (replayed.inputChecksum !== replayChecksum) {
          throw new ConflictException("Profit run idempotency key was reused with different inputs");
        }
        return replayed;
      }
      const [metric] = await tx.select().from(financeProfitMetrics)
        .where(eq(financeProfitMetrics.id, input.metricId)).limit(1);
      if (!metric) throw new NotFoundException("Profit metric not found");
      if (metric.status !== "active") throw new ConflictException("Profit metric is inactive");
      if (metric.currentVersion !== input.expectedMetricVersion) {
        throw new ConflictException("Profit metric version changed");
      }
      const [version] = await tx.select().from(financeProfitMetricVersions).where(and(
        eq(financeProfitMetricVersions.metricId, metric.id),
        eq(financeProfitMetricVersions.versionNumber, input.expectedMetricVersion),
      )).limit(1);
      if (!version) throw new ConflictException("Profit metric version is missing");
      const statements = await tx.select().from(financeStatements)
        .where(inArray(financeStatements.id, input.statementIds));
      if (statements.length !== input.statementIds.length) {
        throw new NotFoundException("One or more finance statements were not found");
      }
      const rates = input.fxRateIds.length
        ? await tx.select().from(financeFxRates).where(inArray(financeFxRates.id, input.fxRateIds))
        : [];
      if (rates.length !== input.fxRateIds.length) {
        throw new NotFoundException("One or more FX rates were not found");
      }
      const facts = await tx.select().from(financeFacts)
        .where(inArray(financeFacts.statementId, input.statementIds))
        .orderBy(asc(financeFacts.occurredAt), asc(financeFacts.id));
      const statementById = new Map(statements.map((statement) => [statement.id, statement]));
      const contributions = facts.map((fact) =>
        calculateContribution(fact, statementById.get(fact.statementId)!, version, rates));
      const diagnostics = profitDiagnostics(facts, contributions, version);
      const complete = diagnostics.missingFactTypes.length === 0
        && diagnostics.missingFxPairs.length === 0
        && diagnostics.unclassifiedFactTypes.length === 0;
      const revenueMinor = complete ? sumBucket(contributions, "revenue") : null;
      const costMinor = complete ? sumBucket(contributions, "cost") : null;
      const profitMinor = complete ? revenueMinor! - costMinor! : null;
      const marginBps = complete && revenueMinor !== 0
        ? safeNumber(roundRatio(BigInt(profitMinor!) * 10_000n, BigInt(revenueMinor!)))
        : null;
      const inputChecksum = checksum({
        metricVersionId: version.id,
        metricVersionChecksum: version.checksum,
        statements: statements
          .map((statement) => ({ id: statement.id, checksum: statement.checksum }))
          .sort(compareId),
        fxRates: rates
          .map((rate) => ({ id: rate.id, checksum: rate.checksum }))
          .sort(compareId),
      });
      const [created] = await tx.insert(financeProfitRuns).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        metricId: metric.id,
        metricVersionId: version.id,
        reportingCurrency: version.reportingCurrency,
        status: complete ? "complete" : "incomplete",
        revenueMinor,
        costMinor,
        profitMinor,
        marginBps,
        statementIds: [...input.statementIds].sort(),
        fxRateIds: [...input.fxRateIds].sort(),
        diagnostics,
        inputChecksum,
        idempotencyKey: input.idempotencyKey,
        calculatedBy: context.userId,
      }).returning();
      if (contributions.length) {
        await tx.insert(financeProfitContributions).values(contributions.map((contribution) => ({
          id: createEntityId(),
          tenantId: context.tenantId,
          runId: created!.id,
          factId: contribution.fact.id,
          fxRateId: contribution.fxRateId,
          bucket: contribution.bucket,
          sourceAmountMinor: contribution.fact.amountMinor,
          sourceCurrency: contribution.fact.currency,
          reportingAmountMinor: contribution.reportingAmountMinor,
          reportingCurrency: version.reportingCurrency,
          effectSign: contribution.effectSign,
        })));
      }
      return created!;
    });
    const view = await this.getProfitRun(context, run.id);
    await this.audit.record(context, {
      action: "finance.profit.calculate",
      resourceType: "finance_profit_run",
      resourceId: view.id,
      result: "success",
      metadata: {
        metricId: view.metricId,
        metricVersion: view.metricVersion,
        status: view.status,
        statementCount: view.statementIds.length,
        diagnosticCounts: {
          missingFactTypes: view.diagnostics.missingFactTypes.length,
          missingFxPairs: view.diagnostics.missingFxPairs.length,
          unclassifiedFactTypes: view.diagnostics.unclassifiedFactTypes.length,
        },
      },
    });
    return view;
  }

  async getProfitRun(context: TenantContext, runId: string): Promise<FinanceProfitRunView> {
    return withTenant(this.database.db, context, async (tx) => {
      const [run] = await tx.select().from(financeProfitRuns)
        .where(eq(financeProfitRuns.id, runId)).limit(1);
      if (!run) throw new NotFoundException("Profit run not found");
      return profitRunView(tx, run);
    });
  }

  async workspace(context: TenantContext): Promise<FinanceWorkspaceView> {
    return withTenant(this.database.db, context, async (tx) => {
      const [statementRows, rateRows, metricRows, runRows] = await Promise.all([
        tx.select().from(financeStatements).orderBy(desc(financeStatements.recordedAt)).limit(100),
        tx.select().from(financeFxRates).orderBy(desc(financeFxRates.effectiveAt)).limit(100),
        tx.select().from(financeProfitMetrics).orderBy(asc(financeProfitMetrics.name)).limit(100),
        tx.select().from(financeProfitRuns).orderBy(desc(financeProfitRuns.calculatedAt)).limit(100),
      ]);
      return FinanceWorkspaceViewSchema.parse({
        statements: await Promise.all(statementRows.map((row) => statementView(tx, row))),
        fxRates: rateRows.map(fxRateView),
        metrics: await Promise.all(metricRows.map((row) => metricView(tx, row))),
        runs: await Promise.all(runRows.map((row) => profitRunView(tx, row))),
      });
    });
  }
}

async function validateStatementReferences(
  tx: TenantTransaction,
  input: RecordFinanceStatementInput,
) {
  if (input.accountId) {
    const [account] = await tx.select().from(marketplaceAccounts)
      .where(eq(marketplaceAccounts.id, input.accountId)).limit(1);
    if (!account) throw new NotFoundException("Marketplace account not found");
    if ((input.provider === "amazon" || input.provider === "etsy") && account.platform !== input.provider) {
      throw new UnprocessableEntityException("Statement provider does not match marketplace account");
    }
  } else if (input.provider === "amazon" || input.provider === "etsy") {
    throw new UnprocessableEntityException("Marketplace statements require an authorized account");
  }
  await requireReferences(tx, orders, input.lines.map((line) => line.orderId), "Order");
  await requireReferences(tx, orderLines, input.lines.map((line) => line.orderLineId), "Order line");
  await requireReferences(tx, skus, input.lines.map((line) => line.skuId), "SKU");
  await requireReferences(tx, listings, input.lines.map((line) => line.listingId), "Listing");
  await requireReferences(tx, fulfillmentSuppliers, input.lines.map((line) => line.supplierId), "Supplier");
}

async function requireReferences(
  tx: TenantTransaction,
  table: typeof orders | typeof orderLines | typeof skus | typeof listings | typeof fulfillmentSuppliers,
  rawIds: Array<string | null>,
  label: string,
) {
  const ids = [...new Set(rawIds.filter((id): id is string => Boolean(id)))];
  if (!ids.length) return;
  const rows = await tx.select({ id: table.id }).from(table).where(inArray(table.id, ids));
  if (rows.length !== ids.length) throw new NotFoundException(`${label} reference was not found`);
}

async function validateCorrections(tx: TenantTransaction, lines: FinanceFactInput[]) {
  const corrections = lines.filter((line) => line.correctsFactId !== null);
  if (!corrections.length) return;
  const correctedIds = [...new Set(corrections.map((line) => line.correctsFactId!))];
  const corrected = await tx.select().from(financeFacts).where(inArray(financeFacts.id, correctedIds));
  if (corrected.length !== correctedIds.length) {
    throw new NotFoundException("Corrected finance fact was not found");
  }
  const byId = new Map(corrected.map((fact) => [fact.id, fact]));
  for (const line of corrections) {
    const original = byId.get(line.correctsFactId!)!;
    if (
      line.factType !== original.factType
      || line.currency !== original.currency
      || line.direction !== original.direction
      || !sameDimensions(line, original)
    ) {
      throw new UnprocessableEntityException(
        "Finance corrections must retain fact type, currency, direction, and dimensions",
      );
    }
    if (line.correctionKind === "reversal" && line.amountMinor !== original.amountMinor) {
      throw new UnprocessableEntityException("Finance reversal amount must exactly match its fact");
    }
    if (line.correctionKind === "replacement") {
      const [reversal] = await tx.select({ id: financeFacts.id }).from(financeFacts).where(and(
        eq(financeFacts.correctsFactId, original.id),
        eq(financeFacts.correctionKind, "reversal"),
      )).limit(1);
      if (!reversal) {
        throw new UnprocessableEntityException("Finance replacement requires a recorded reversal");
      }
    }
  }
}

function sameDimensions(left: FinanceFactInput, right: FactRow) {
  return left.orderId === right.orderId
    && left.orderLineId === right.orderLineId
    && left.skuId === right.skuId
    && left.listingId === right.listingId
    && left.supplierId === right.supplierId;
}

function calculateContribution(
  fact: FactRow,
  statement: StatementRow,
  version: MetricVersionRow,
  rates: FxRateRow[],
): CalculatedContribution {
  const bucket: FinanceProfitBucket = version.revenueFactTypes.includes(fact.factType)
    ? "revenue"
    : version.costFactTypes.includes(fact.factType)
      ? "cost"
      : "unclassified";
  const normalSign = bucket === "revenue"
    ? (fact.direction === "credit" ? 1 : -1)
    : (fact.direction === "debit" ? 1 : -1);
  const effectSign = (fact.correctionKind === "reversal" ? -normalSign : normalSign) as -1 | 1;
  if (fact.currency === version.reportingCurrency) {
    return {
      fact,
      statement,
      bucket,
      effectSign,
      fxRateId: null,
      reportingAmountMinor: fact.amountMinor,
    };
  }
  const fxRate = rates
    .filter((rate) =>
      rate.baseCurrency === fact.currency
      && rate.quoteCurrency === version.reportingCurrency
      && rate.effectiveAt <= fact.occurredAt)
    .sort((left, right) =>
      right.effectiveAt.getTime() - left.effectiveAt.getTime()
      || right.retrievedAt.getTime() - left.retrievedAt.getTime())[0];
  return {
    fact,
    statement,
    bucket,
    effectSign,
    fxRateId: fxRate?.id ?? null,
    reportingAmountMinor: fxRate
      ? safeNumber(roundRatio(
        BigInt(fact.amountMinor) * BigInt(fxRate.rateNumerator),
        BigInt(fxRate.rateDenominator),
      ))
      : null,
  };
}

function profitDiagnostics(
  facts: FactRow[],
  contributions: CalculatedContribution[],
  version: MetricVersionRow,
): FinanceProfitDiagnosticView {
  const presentTypes = new Set(facts.map((fact) => fact.factType));
  return {
    missingFactTypes: version.requiredFactTypes.filter((type) => !presentTypes.has(type)).sort(),
    missingFxPairs: [...new Set(contributions
      .filter((contribution) => contribution.reportingAmountMinor === null)
      .map((contribution) =>
        `${contribution.fact.currency}/${version.reportingCurrency}`))].sort(),
    unclassifiedFactTypes: [...new Set(contributions
      .filter((contribution) => contribution.bucket === "unclassified")
      .map((contribution) => contribution.fact.factType))].sort(),
  };
}

function sumBucket(contributions: CalculatedContribution[], bucket: FinanceProfitBucket): number {
  const total = contributions
    .filter((contribution) => contribution.bucket === bucket)
    .reduce((sum, contribution) =>
      sum + BigInt(contribution.reportingAmountMinor!) * BigInt(contribution.effectSign), 0n);
  return safeNumber(total);
}

async function statementView(
  tx: TenantTransaction,
  statement: StatementRow,
): Promise<FinanceStatementView> {
  const facts = await tx.select().from(financeFacts)
    .where(eq(financeFacts.statementId, statement.id))
    .orderBy(asc(financeFacts.lineKey));
  return FinanceStatementViewSchema.parse({
    id: statement.id,
    accountId: statement.accountId,
    provider: statement.provider,
    statementKind: statement.statementKind,
    externalStatementId: statement.externalStatementId,
    periodStart: statement.periodStart.toISOString(),
    periodEnd: statement.periodEnd.toISOString(),
    sourceCurrency: statement.sourceCurrency,
    observedAt: statement.observedAt.toISOString(),
    recordedAt: statement.recordedAt.toISOString(),
    checksum: statement.checksum,
    lines: facts.map((fact) => ({
      id: fact.id,
      statementId: fact.statementId,
      accountId: fact.accountId,
      lineKey: fact.lineKey,
      factType: fact.factType,
      direction: fact.direction,
      amountMinor: fact.amountMinor,
      currency: fact.currency,
      occurredAt: fact.occurredAt.toISOString(),
      externalReference: fact.externalReference,
      orderId: fact.orderId,
      orderLineId: fact.orderLineId,
      skuId: fact.skuId,
      listingId: fact.listingId,
      supplierId: fact.supplierId,
      correctionKind: fact.correctionKind,
      correctsFactId: fact.correctsFactId,
      recordedAt: fact.recordedAt.toISOString(),
    })),
  });
}

function fxRateView(rate: FxRateRow): FinanceFxRateView {
  return FinanceFxRateViewSchema.parse({
    id: rate.id,
    source: rate.source,
    baseCurrency: rate.baseCurrency,
    quoteCurrency: rate.quoteCurrency,
    rateNumerator: rate.rateNumerator,
    rateDenominator: rate.rateDenominator,
    effectiveAt: rate.effectiveAt.toISOString(),
    retrievedAt: rate.retrievedAt.toISOString(),
    recordedAt: rate.recordedAt.toISOString(),
    checksum: rate.checksum,
  });
}

async function metricView(
  tx: TenantTransaction,
  metric: MetricRow,
): Promise<FinanceProfitMetricView> {
  const [version] = await tx.select().from(financeProfitMetricVersions).where(and(
    eq(financeProfitMetricVersions.metricId, metric.id),
    eq(financeProfitMetricVersions.versionNumber, metric.currentVersion),
  )).limit(1);
  if (!version) throw new ConflictException("Profit metric version is missing");
  return FinanceProfitMetricViewSchema.parse({
    id: metric.id,
    name: metric.name,
    currentVersion: metric.currentVersion,
    status: metric.status,
    version: {
      id: version.id,
      metricId: version.metricId,
      versionNumber: version.versionNumber,
      reportingCurrency: version.reportingCurrency,
      revenueFactTypes: version.revenueFactTypes,
      costFactTypes: version.costFactTypes,
      requiredFactTypes: version.requiredFactTypes,
      reasonCode: version.reasonCode,
      checksum: version.checksum,
      createdAt: version.createdAt.toISOString(),
    },
    createdAt: metric.createdAt.toISOString(),
    updatedAt: metric.updatedAt.toISOString(),
  });
}

async function profitRunView(
  tx: TenantTransaction,
  run: RunRow,
): Promise<FinanceProfitRunView> {
  const [version] = await tx.select().from(financeProfitMetricVersions)
    .where(eq(financeProfitMetricVersions.id, run.metricVersionId)).limit(1);
  if (!version) throw new ConflictException("Profit run metric version is missing");
  const contributionRows = await tx.select({
    contribution: financeProfitContributions,
    fact: financeFacts,
    statement: financeStatements,
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
  }));
  return FinanceProfitRunViewSchema.parse({
    id: run.id,
    metricId: run.metricId,
    metricVersionId: run.metricVersionId,
    metricVersion: version.versionNumber,
    reportingCurrency: run.reportingCurrency,
    status: run.status,
    revenueMinor: run.revenueMinor,
    costMinor: run.costMinor,
    profitMinor: run.profitMinor,
    marginBps: run.marginBps,
    statementIds: run.statementIds,
    fxRateIds: run.fxRateIds,
    diagnostics: run.diagnostics,
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
      effectSign: contribution.effectSign,
      factType: fact.factType,
      occurredAt: fact.occurredAt.toISOString(),
      orderId: fact.orderId,
      orderLineId: fact.orderLineId,
      skuId: fact.skuId,
      listingId: fact.listingId,
      accountId: fact.accountId,
      supplierId: fact.supplierId,
    })),
    breakdowns: run.status === "complete" ? buildBreakdowns(calculated) : [],
  });
}

function buildBreakdowns(
  contributions: CalculatedContribution[],
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
        profitMinor: revenueMinor - costMinor,
        factCount: entries.length,
      });
    }
  }
  return result.sort((left, right) =>
    left.dimension.localeCompare(right.dimension) || left.key.localeCompare(right.key));
}

async function profitInputChecksum(
  tx: TenantTransaction,
  input: CalculateFinanceProfitInput,
): Promise<string> {
  const [version] = await tx.select().from(financeProfitMetricVersions).where(and(
    eq(financeProfitMetricVersions.metricId, input.metricId),
    eq(financeProfitMetricVersions.versionNumber, input.expectedMetricVersion),
  )).limit(1);
  const statements = await tx.select().from(financeStatements)
    .where(inArray(financeStatements.id, input.statementIds));
  const rates = input.fxRateIds.length
    ? await tx.select().from(financeFxRates).where(inArray(financeFxRates.id, input.fxRateIds))
    : [];
  return checksum({
    metricVersionId: version?.id ?? null,
    metricVersionChecksum: version?.checksum ?? null,
    statements: statements
      .map((statement) => ({ id: statement.id, checksum: statement.checksum }))
      .sort(compareId),
    fxRates: rates.map((rate) => ({ id: rate.id, checksum: rate.checksum })).sort(compareId),
  });
}

function compareId(left: { id: string }, right: { id: string }) {
  return left.id.localeCompare(right.id);
}

function roundRatio(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new UnprocessableEntityException("Ratio denominator must be positive");
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  return sign * ((absolute + denominator / 2n) / denominator);
}

function safeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new UnprocessableEntityException("Calculated finance amount exceeds safe integer range");
  }
  return result;
}

async function lock(tx: TenantTransaction, key: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

function checksum(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
