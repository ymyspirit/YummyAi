import type { PrepareFinanceCommand } from "@yummyai/contracts/finance/finance-command";
import { FinanceProfitReadOwner,readRecentFinanceProfitRunRows,buildBreakdowns as sharedBuildBreakdowns,currentFinanceAuthority as sharedCurrentFinanceAuthority,identifiedFinanceFact as sharedIdentifiedFinanceFact,monetaryExact as sharedMonetaryExact,moneyOverflow as sharedMoneyOverflow,profitRunView as sharedProfitRunView,safeNumber as sharedSafeNumber,sameReference as sharedSameReference,sumBucket as sharedSumBucket } from "@yummyai/finance-core";
import { createHash } from "node:crypto";
import { originalOwnerOperation,rethrowOriginalOwnerError } from "../shared/original-owner-error.js";
import { financeCommandOwnerLock } from "./finance-command-lock.js";

import {
ConflictException,
Inject,
Injectable,
NotFoundException,
UnprocessableEntityException,
} from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { createEntityId,type TenantContext } from "@yummyai/contracts";
import {
CalculateFinanceProfitInputSchema,
evaluateFinanceCoverage,
FinanceCorrectionKindSchema,
FinanceFactViewSchema,
FinanceFxRateViewSchema,
FinanceProfitMetricVersionViewSchema,
FinanceProfitMetricViewSchema,
FinanceStatementViewSchema,
FinanceWorkspaceViewSchema,
RecordFinanceFxRateInputSchema,
RecordFinanceStatementInputSchema,
UpsertFinanceProfitMetricInputSchema,
type CalculateFinanceProfitInput,
type FinanceFactInput,
type FinanceFactView,
type FinanceFxRateView,
type FinanceProfitBucket,
type FinanceProfitCoverageDimension,
type FinanceProfitDiagnosticView,
type FinanceProfitMetricView,
type FinanceProfitRunView,
type FinanceStatementView,
type FinanceWorkspaceView,
type RecordFinanceFxRateInput,
type RecordFinanceStatementInput,
type UpsertFinanceProfitMetricInput
} from "@yummyai/contracts/finance";
import type { FinanceAllocatedProfitRun,FinanceAllocatedProfitSlice } from "@yummyai/contracts/finance/cost-allocation";
import {
buildFinanceCalculationBasis,convertFinanceMinorAmount,pinFinanceFxBasis,
type FinanceCalculationMonetaryBasis,
} from "@yummyai/contracts/finance/monetary";
import {
FinanceSourceEntryIdSchema,
financeSourceScopeKey
} from "@yummyai/contracts/finance/source-identity";
import {
financeAllocatedProfitRuns,
financeAllocatedProfitSlices,
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
orderLineCatalogLinks,
orderLines,
orders,
skus,
withTenant,
type DatabaseConnection,
type TenantTransaction
} from "@yummyai/database";
import { and,asc,desc,eq,inArray,sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { allocatedProfitRunView,allocatedProfitSliceView } from "./finance-cost-allocation.read.js";
import { type FinanceStatementEvidenceRow } from "./finance-statement-evidence.js";

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
  statement: FinanceStatementEvidenceRow;
  monetaryProblem: "currency_precision_unknown" | "fx_rate_unit_unknown" | null;
}

export interface OrderFinanceEvidence {
  facts: FinanceFactView[];
  calculations: Array<{ run: FinanceProfitRunView; metric: FinanceProfitMetricView["version"] }>;
  allocationCalculations?: Array<{ run: FinanceAllocatedProfitRun; baseRun: FinanceProfitRunView;
    metric: FinanceProfitMetricView["version"]; slices: FinanceAllocatedProfitSlice[]; sourceFacts: FinanceFactView[] }>;
  truncated: boolean;
}

@Injectable()
export class FinanceService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Scoped evidence, independent of the workspace's most recent 100 statements. */
  async orderEvidence(context: TenantContext, orderIds: string[]): Promise<OrderFinanceEvidence> {
    return withTenant(this.database.db, context, async tx => {
      await currentFinanceAuthority(tx, context, Permission.FinanceRead);
      if (orderIds.length > 50) throw new UnprocessableEntityException("订单复盘每次最多读取 50 单");
      if (!orderIds.length) return { facts: [], calculations: [], allocationCalculations: [], truncated: false };
      const facts = await tx.select().from(financeFacts).where(inArray(financeFacts.orderId, orderIds))
        .orderBy(asc(financeFacts.recordedAt), asc(financeFacts.id)).limit(2001);
      const rows = await tx.selectDistinct({ run: financeProfitRuns }).from(financeProfitRuns)
        .innerJoin(financeProfitContributions, eq(financeProfitContributions.runId, financeProfitRuns.id))
        .innerJoin(financeFacts, eq(financeFacts.id, financeProfitContributions.factId))
        .where(inArray(financeFacts.orderId, orderIds))
        .orderBy(desc(financeProfitRuns.calculatedAt), desc(financeProfitRuns.id)).limit(101);
      const calculations: OrderFinanceEvidence["calculations"] = [];
      for (const { run } of rows.slice(0, 100)) {
        const [version] = await tx.select().from(financeProfitMetricVersions).where(eq(financeProfitMetricVersions.id, run.metricVersionId));
        if (!version) throw new ConflictException("利润口径版本缺失");
        calculations.push({ run: await profitRunView(tx, run), metric: {
          ...version, createdAt: version.createdAt.toISOString(),
        } });
      }
      // Shared expenses have no original orderId. Discover the immutable
      // projection through its actual tenant-resolved target, not the source fee.
      const allocatedRows = await tx.selectDistinct({ run: financeAllocatedProfitRuns }).from(financeAllocatedProfitRuns)
        .innerJoin(financeAllocatedProfitSlices, and(eq(financeAllocatedProfitSlices.tenantId, financeAllocatedProfitRuns.tenantId),
          eq(financeAllocatedProfitSlices.runId, financeAllocatedProfitRuns.id)))
        .where(inArray(sql<string>`${financeAllocatedProfitSlices.target}->>'orderId'`, orderIds))
        .orderBy(desc(financeAllocatedProfitRuns.createdAt), desc(financeAllocatedProfitRuns.id)).limit(101);
      const allocationCalculations: NonNullable<OrderFinanceEvidence["allocationCalculations"]> = [];
      let remainingSlices = 5000, remainingSources = 5000, allocationTruncated = allocatedRows.length > 100;
      const baseCache = new Map(calculations.map(entry => [entry.run.id, entry]));
      for (const { run } of allocatedRows.slice(0, 100)) {
        if (remainingSlices <= 0 || remainingSources <= 0) { allocationTruncated = true; break; }
        let base = baseCache.get(run.baseRunId);
        if (!base) {
          const [original] = await tx.select().from(financeProfitRuns).where(eq(financeProfitRuns.id, run.baseRunId)).limit(1);
          const [version] = original ? await tx.select().from(financeProfitMetricVersions).where(eq(financeProfitMetricVersions.id, original.metricVersionId)).limit(1) : [];
          if (!original || !version) throw new ConflictException("分摊的原利润依据缺失");
          base = { run: await profitRunView(tx, original), metric: { ...version, createdAt: version.createdAt.toISOString() } };
          baseCache.set(original.id, base);
        }
        const sliceRows = await tx.select().from(financeAllocatedProfitSlices).where(eq(financeAllocatedProfitSlices.runId, run.id))
          .orderBy(asc(financeAllocatedProfitSlices.id)).limit(remainingSlices + 1);
        const sourceIds = [...new Set(base.run.contributions.map(entry => entry.factId))];
        if (sliceRows.length > remainingSlices || sourceIds.length > remainingSources) allocationTruncated = true;
        const sourceRows = sourceIds.length ? await tx.select().from(financeFacts).where(inArray(financeFacts.id, sourceIds.slice(0, remainingSources))) : [];
        const slices = sliceRows.slice(0, remainingSlices).map(allocatedProfitSliceView);
        remainingSlices -= slices.length; remainingSources -= sourceRows.length;
        allocationCalculations.push({ run: await allocatedProfitRunView(tx, run), baseRun: base.run, metric: base.metric,
          slices, sourceFacts: sourceRows.map(factView) });
      }
      return {
        facts: facts.slice(0, 2000).map(fact => FinanceFactViewSchema.parse({
          id: fact.id, statementId: fact.statementId, accountId: fact.accountId, lineKey: fact.lineKey,
          factType: fact.factType, direction: fact.direction, amountMinor: fact.amountMinor, currency: fact.currency,
          occurredAt: fact.occurredAt.toISOString(), recordedAt: fact.recordedAt.toISOString(), externalReference: fact.externalReference,
          orderId: fact.orderId, orderLineId: fact.orderLineId, skuId: fact.skuId, listingId: fact.listingId,
          supplierId: fact.supplierId, correctionKind: fact.correctionKind, correctsFactId: fact.correctsFactId,
          sourceEntryId: fact.sourceEntryId ?? null,
        })),
        calculations, allocationCalculations, truncated: facts.length > 2000 || rows.length > 100 || allocationTruncated,
      };
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
  }

  async recordStatement(
    context: TenantContext,
    rawInput: RecordFinanceStatementInput,
  ): Promise<FinanceStatementView> {
    return withTenant(this.database.db, context, tx => this.recordStatementInTransaction(tx, context, rawInput));
  }

  async recordStatementInTransaction(tx: TenantTransaction, 
    context: TenantContext,
    rawInput: RecordFinanceStatementInput,
  ): Promise<FinanceStatementView> {
    const input = RecordFinanceStatementInputSchema.parse(rawInput);
    const lines = input.lines.map(line => {
      if (line.sourceEntryId !== undefined) return line;
      const legacy = { ...line };
      delete legacy.sourceEntryId;
      return legacy;
    }).sort((left, right) => left.lineKey.localeCompare(right.lineKey));
    const scopeKey = input.sourceIdentity ? financeSourceScopeKey({ ...input, sourceIdentity: input.sourceIdentity }) : input.accountId ?? input.provider;
    const statementEvidence = {
      accountId: input.accountId,
      provider: input.provider,
      statementKind: input.statementKind,
      externalStatementId: input.externalStatementId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      sourceCurrency: input.sourceCurrency,
      observedAt: input.observedAt,
      lines,
      ...(input.sourceIdentity === undefined ? {} : { sourceIdentity: input.sourceIdentity }),
    };
    const statementChecksum = checksum(statementEvidence);
      const current = await currentFinanceAuthority(tx, context, Permission.FinanceWrite);
      await financeCommandOwnerLock(tx, current, "statement_record", input.idempotencyKey);
      await lock(tx, `finance-statement:${current.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(financeStatements)
        .where(eq(financeStatements.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        if (replayed.checksum !== statementChecksum || replayed.recordedBy !== current.userId) {
          throw new ConflictException("Finance statement idempotency key was reused with different evidence or actor");
        }
        return statementView(tx, replayed);
      }
      await lock(tx, `finance-statement-source:${current.tenantId}:${input.provider}:${scopeKey}`);
      const [sameExternal] = await tx.select().from(financeStatements).where(and(
        eq(financeStatements.provider, input.provider),
        eq(financeStatements.scopeKey, scopeKey),
        eq(financeStatements.externalStatementId, input.externalStatementId),
      )).limit(1);
      if (sameExternal) {
        if (sameExternal.checksum !== statementChecksum) {
          throw new ConflictException("Provider statement identity was reused with different evidence");
        }
        return statementView(tx, sameExternal);
      }
      await validateNewStatementInTransaction(tx, input, lines, scopeKey);
      const [created] = await tx.insert(financeStatements).values({
        id: createEntityId(),
        tenantId: current.tenantId,
        accountId: input.accountId,
        provider: input.provider,
        statementKind: input.statementKind,
        externalStatementId: input.externalStatementId,
        scopeKey,
        sourceIdentity: input.sourceIdentity,
        sourceInput: statementEvidence,
        periodStart: new Date(input.periodStart),
        periodEnd: new Date(input.periodEnd),
        sourceCurrency: input.sourceCurrency,
        observedAt: new Date(input.observedAt),
        checksum: statementChecksum,
        idempotencyKey: input.idempotencyKey,
        recordedBy: current.userId,
      }).returning();
      const facts = lines.map((line) => ({
        id: createEntityId(),
        tenantId: current.tenantId,
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
        sourceEntryId: line.sourceEntryId!, sourceScopeKey: scopeKey, sourceProvider: input.provider,
      }));
      for (let offset = 0; offset < facts.length; offset += 500) await tx.insert(financeFacts).values(facts.slice(offset, offset + 500));
      const view = await statementView(tx, created!);
      await this.audit.recordInTransaction(tx, current, {
        action: "finance.statement.record", resourceType: "finance_statement", resourceId: view.id, result: "success",
        metadata: { provider: view.provider, statementKind: view.statementKind, lineCount: view.lines.length },
      });
      return view;
  }

  async validateCommandInTransaction(tx: TenantTransaction, context: TenantContext, original: PrepareFinanceCommand) {
    const current = await currentFinanceAuthority(tx, context, original.kind === "statement_record" || original.kind === "fx_rate_record" ? Permission.FinanceWrite : Permission.FinanceReview);
    if (original.kind === "statement_record") {
      const input = original.input;
      if (!input.sourceIdentity) throw new ConflictException("新财务凭据必须保留真实来源身份");
      await validateNewStatementInTransaction(tx, input, input.lines, financeSourceScopeKey({...input,sourceIdentity:input.sourceIdentity}), false);
    } else if (original.kind === "fx_rate_record") {
      if (original.input.rateUnit === "major_to_major") monetaryExact(() => pinFinanceFxBasis(original.input.baseCurrency, original.input.quoteCurrency));
    } else if (original.kind === "metric_upsert") await planNewMetricInTransaction(tx, current, original.input, false);
    else if (original.kind === "profit_calculate") await planNewProfitInTransaction(tx, current, original.input, false);
    else throw new ConflictException("原财务操作不属于此服务");
  }

  async getStatement(context: TenantContext, statementId: string): Promise<FinanceStatementView> {
    return withTenant(this.database.db, context, async (tx) => {
      await currentFinanceAuthority(tx, context, Permission.FinanceRead);
      const [statement] = await tx.select().from(financeStatements)
        .where(eq(financeStatements.id, statementId)).limit(1);
      if (!statement) throw new NotFoundException("Finance statement not found");
      return statementView(tx, statement);
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
  }

  async recordFxRate(
    context: TenantContext,
    rawInput: RecordFinanceFxRateInput,
  ): Promise<FinanceFxRateView> {
    return withTenant(this.database.db, context, tx => this.recordFxRateInTransaction(tx, context, rawInput));
  }

  async recordFxRateInTransaction(tx: TenantTransaction, 
    context: TenantContext,
    rawInput: RecordFinanceFxRateInput,
  ): Promise<FinanceFxRateView> {
    const input = RecordFinanceFxRateInputSchema.parse(rawInput);
    const monetaryBasis = input.rateUnit === "major_to_major"
      ? monetaryExact(() => pinFinanceFxBasis(input.baseCurrency, input.quoteCurrency)) : null;
    const rateChecksum = checksum({
      source: input.source,
      baseCurrency: input.baseCurrency,
      quoteCurrency: input.quoteCurrency,
      rateNumerator: input.rateNumerator,
      rateDenominator: input.rateDenominator,
      effectiveAt: input.effectiveAt,
      retrievedAt: input.retrievedAt,
      ...(monetaryBasis === null ? {} : { monetaryBasis }),
    });
      const current = await currentFinanceAuthority(tx, context, Permission.FinanceWrite);
      await financeCommandOwnerLock(tx, current, "fx_rate_record", input.idempotencyKey);
      await lock(tx, `finance-fx-rate:${current.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(financeFxRates)
        .where(eq(financeFxRates.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        if (replayed.checksum !== rateChecksum || replayed.recordedBy !== current.userId) {
          throw new ConflictException("FX rate idempotency key was reused with different evidence or actor");
        }
        return fxRateView(replayed);
      }
      await lock(tx, `finance-fx-identity:${current.tenantId}:${input.source}:${input.baseCurrency}:${input.quoteCurrency}:${new Date(input.effectiveAt).toISOString()}:${new Date(input.retrievedAt).toISOString()}`);
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
        return fxRateView(sameRate);
      }
      const [created] = await tx.insert(financeFxRates).values({
        id: createEntityId(),
        tenantId: current.tenantId,
        source: input.source,
        baseCurrency: input.baseCurrency,
        quoteCurrency: input.quoteCurrency,
        rateNumerator: input.rateNumerator,
        rateDenominator: input.rateDenominator,
        monetaryBasis,
        effectiveAt: new Date(input.effectiveAt),
        retrievedAt: new Date(input.retrievedAt),
        checksum: rateChecksum,
        idempotencyKey: input.idempotencyKey,
        recordedBy: current.userId,
      }).returning();
      const view = fxRateView(created!);
      await this.audit.recordInTransaction(tx, current, {
        action: "finance.fx_rate.record", resourceType: "finance_fx_rate", resourceId: view.id, result: "success",
        metadata: { source: view.source, pair: `${view.baseCurrency}/${view.quoteCurrency}`, effectiveAt: view.effectiveAt },
      });
      return view;
  }

  async upsertProfitMetric(
    context: TenantContext,
    rawInput: UpsertFinanceProfitMetricInput,
  ): Promise<FinanceProfitMetricView> {
    return withTenant(this.database.db, context, tx => this.upsertProfitMetricInTransaction(tx, context, rawInput));
  }

  async upsertProfitMetricInTransaction(tx: TenantTransaction, 
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
    const requestIdentity = { metricId: input.metricId?.toLowerCase() ?? null, name: input.name,
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }) };
      const current = await currentFinanceAuthority(tx, context, Permission.FinanceReview);
      await financeCommandOwnerLock(tx, current, "metric_upsert", input.idempotencyKey);
      await lock(tx, `finance-profit-metric:${current.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(financeProfitMetricVersions)
        .where(eq(financeProfitMetricVersions.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        if (replayed.checksum !== versionChecksum || replayed.createdBy !== current.userId) {
          throw new ConflictException({ code: "finance_profit_metric_request_mismatch", message: "利润口径请求键已绑定原填写与原操作者 请恢复原始提交" });
        }
        if (replayed.requestIdentity ? stableStringify(replayed.requestIdentity) !== stableStringify(requestIdentity)
          : input.expectedVersion !== undefined || (input.metricId ? input.metricId.toLowerCase() !== replayed.metricId : replayed.versionNumber !== 1))
          throw new ConflictException({ code: "finance_profit_metric_request_mismatch", message: "利润口径请求键已绑定原口径与原版本预期 请恢复原始提交" });
        await lock(tx, `finance-profit-metric-id:${current.tenantId}:${replayed.metricId}`);
        const [existing] = await tx.select().from(financeProfitMetrics)
          .where(eq(financeProfitMetrics.id, replayed.metricId)).limit(1);
        if (!existing) throw new ConflictException("Profit metric projection is missing");
        return metricView(tx, existing, { versionNumber: replayed.versionNumber, name: input.name });
      }
      let existing = await planNewMetricInTransaction(tx, current, input);
      const nextVersion = (existing?.currentVersion ?? 0) + 1;
      const metricId = existing?.id ?? createEntityId();
      if (!existing) {
        [existing] = await tx.insert(financeProfitMetrics).values({
          id: metricId,
          tenantId: current.tenantId,
          name: input.name,
          currentVersion: nextVersion,
          createdBy: current.userId,
        }).returning();
      }
      const [createdVersion] = await tx.insert(financeProfitMetricVersions).values({
        id: createEntityId(),
        tenantId: current.tenantId,
        metricId,
        versionNumber: nextVersion,
        reportingCurrency: input.reportingCurrency,
        revenueFactTypes: [...input.revenueFactTypes].sort(),
        costFactTypes: [...input.costFactTypes].sort(),
        requiredFactTypes: [...input.requiredFactTypes].sort(),
        reasonCode: input.reasonCode,
        checksum: versionChecksum,
        idempotencyKey: input.idempotencyKey,
        createdBy: current.userId,
        requestIdentity,
      }).returning();
      if (existing.currentVersion !== nextVersion || existing.name !== input.name) {
        [existing] = await tx.update(financeProfitMetrics).set({
          name: input.name,
          currentVersion: nextVersion,
          updatedAt: sql`clock_timestamp()`,
        }).where(and(eq(financeProfitMetrics.id, metricId), eq(financeProfitMetrics.currentVersion, input.expectedVersion!))).returning();
        if (!existing) throw new ConflictException({ code: "finance_profit_metric_version_changed", message: "利润口径版本已变化 请重新核对后提交" });
      }
      if (!createdVersion) throw new ConflictException("Profit metric version is missing");
      const view = await metricView(tx, existing!, { versionNumber: createdVersion.versionNumber, name: input.name });
      await this.audit.recordInTransaction(tx, current, {
        action: "finance.profit_metric.version", resourceType: "finance_profit_metric", resourceId: view.id, result: "success",
        metadata: { version: view.currentVersion, reportingCurrency: view.version.reportingCurrency },
      });
      return view;
  }

  async getProfitMetric(context: TenantContext, metricId: string): Promise<FinanceProfitMetricView> {
    return withTenant(this.database.db, context, async (tx) => {
      await currentFinanceAuthority(tx, context, Permission.FinanceRead);
      const [metric] = await tx.select().from(financeProfitMetrics)
        .where(eq(financeProfitMetrics.id, metricId)).limit(1);
      if (!metric) throw new NotFoundException("Profit metric not found");
      return metricView(tx, metric);
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
  }

  async calculateProfit(
    context: TenantContext,
    rawInput: CalculateFinanceProfitInput,
  ): Promise<FinanceProfitRunView> {
    return withTenant(this.database.db, context, tx => this.calculateProfitInTransaction(tx, context, rawInput));
  }

  async calculateProfitInTransaction(tx: TenantTransaction, 
    context: TenantContext,
    rawInput: CalculateFinanceProfitInput,
  ): Promise<FinanceProfitRunView> {
    const input = CalculateFinanceProfitInputSchema.parse(rawInput);
      const current = await currentFinanceAuthority(tx, context, Permission.FinanceReview);
      await financeCommandOwnerLock(tx, current, "profit_calculate", input.idempotencyKey);
      await lock(tx, `finance-profit-run:${current.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(financeProfitRuns)
        .where(eq(financeProfitRuns.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        if (replayed.calculatedBy !== current.userId) throw new ConflictException("Profit run idempotency key was reused by a different actor");
        const replayChecksum = await profitInputChecksum(tx, input, replayed.monetaryBasis ?? null, replayed.sourceIdentityVersion ?? null);
        if (replayed.inputChecksum !== replayChecksum) {
          throw new ConflictException("Profit run idempotency key was reused with different inputs");
        }
        return profitRunView(tx, replayed);
      }
      const {metric,version,monetaryBasis,complete,revenueMinor,costMinor,profitMinor,marginBps,diagnostics,inputChecksum,contributions} = await planNewProfitInTransaction(tx, current, input);
      const [created] = await tx.insert(financeProfitRuns).values({
        id: createEntityId(),
        tenantId: current.tenantId,
        metricId: metric.id,
        metricVersionId: version.id,
        reportingCurrency: version.reportingCurrency,
        monetaryBasis,
        sourceIdentityVersion: 1,
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
        calculatedBy: current.userId,
      }).returning();
      if (contributions.length) {
        const rows = contributions.map((contribution) => ({
          id: createEntityId(),
          tenantId: current.tenantId,
          runId: created!.id,
          factId: contribution.fact.id,
          fxRateId: contribution.fxRateId,
          bucket: contribution.bucket,
          sourceAmountMinor: contribution.fact.amountMinor,
          sourceCurrency: contribution.fact.currency,
          reportingAmountMinor: contribution.reportingAmountMinor,
          reportingCurrency: version.reportingCurrency,
          effectSign: contribution.effectSign,
        }));
        for (let offset = 0; offset < rows.length; offset += 500) await tx.insert(financeProfitContributions).values(rows.slice(offset, offset + 500));
      }
      const view = await profitRunView(tx, created!);
      await this.audit.recordInTransaction(tx, current, {
        action: "finance.profit.calculate", resourceType: "finance_profit_run", resourceId: view.id, result: "success",
        metadata: { metricId: view.metricId, metricVersion: view.metricVersion, status: view.status, statementCount: view.statementIds.length,
          diagnosticCounts: { missingFactTypes: view.diagnostics.missingFactTypes.length, missingFxPairs: view.diagnostics.missingFxPairs.length,
            unclassifiedFactTypes: view.diagnostics.unclassifiedFactTypes.length, unidentifiedFacts: view.diagnostics.sourceIdentity!.unidentifiedFactIds.length } },
      });
      return view;
  }

  async getProfitRun(context:TenantContext,runId:string):Promise<FinanceProfitRunView>{return originalOwnerOperation(()=>new FinanceProfitReadOwner(this.database).getProfitRun(context,runId));}

  async workspace(context: TenantContext): Promise<FinanceWorkspaceView> {
    return withTenant(this.database.db, context, async (tx) => {
      await currentFinanceAuthority(tx, context, Permission.FinanceRead);
      const [statementRows, rateRows, metricRows, runRows] = await Promise.all([
        tx.select().from(financeStatements).orderBy(desc(financeStatements.recordedAt)).limit(100),
        tx.select().from(financeFxRates).orderBy(desc(financeFxRates.effectiveAt)).limit(100),
        tx.select().from(financeProfitMetrics).orderBy(asc(financeProfitMetrics.name)).limit(100),
        readRecentFinanceProfitRunRows(tx),
      ]);
      return FinanceWorkspaceViewSchema.parse({
        statements: await Promise.all(statementRows.map((row) => statementView(tx, row))),
        fxRates: rateRows.map(fxRateView),
        metrics: await Promise.all(metricRows.map((row) => metricView(tx, row))),
        runs: await Promise.all(runRows.map((row) => profitRunView(tx, row))),
      });
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
  }
}

export async function currentFinanceAuthority(tx: TenantTransaction, base: TenantContext, permission: Permission) {try{return await sharedCurrentFinanceAuthority(tx,base,permission);}catch(error){rethrowOriginalOwnerError(error);}}

async function validateStatementReferences(
  tx: TenantTransaction,
  input: RecordFinanceStatementInput,
) {
  let accountPlatform: string | null = null;
  if (input.accountId) {
    const [account] = await tx.select().from(marketplaceAccounts)
      .where(eq(marketplaceAccounts.id, input.accountId)).limit(1);
    if (!account || account.deletedAt) throw new NotFoundException("Marketplace account not found");
    accountPlatform = account.platform;
    if ((input.provider === "amazon" || input.provider === "etsy") && account.platform !== input.provider) {
      throw new UnprocessableEntityException("Statement provider does not match marketplace account");
    }
  } else if (input.provider === "amazon" || input.provider === "etsy") {
    throw new UnprocessableEntityException("Marketplace statements require an authorized account");
  }
  const orderIds = referenceIds(input.lines.map(line => line.orderId)), lineIds = referenceIds(input.lines.map(line => line.orderLineId));
  const skuIds = referenceIds(input.lines.map(line => line.skuId)), listingIds = referenceIds(input.lines.map(line => line.listingId));
  const orderRows = orderIds.length ? await tx.select().from(orders).where(inArray(orders.id, orderIds)) : [];
  const lineRows = lineIds.length ? await tx.select().from(orderLines).where(inArray(orderLines.id, lineIds)) : [];
  const catalogRows = lineIds.length ? await tx.select().from(orderLineCatalogLinks).where(inArray(orderLineCatalogLinks.orderLineId, lineIds)) : [];
  const allSkuIds = referenceIds([...skuIds, ...catalogRows.map(link => link.skuId)]);
  const allListingIds = referenceIds([...listingIds, ...catalogRows.map(link => link.listingId)]);
  const skuRows = allSkuIds.length ? await tx.select().from(skus).where(inArray(skus.id, allSkuIds)) : [];
  const listingRows = allListingIds.length ? await tx.select().from(listings).where(inArray(listings.id, allListingIds)) : [];
  const presentSkuIds = new Set(skuRows.map(sku => sku.id)), presentListingIds = new Set(listingRows.map(listing => listing.id));
  if (orderRows.length !== orderIds.length || lineRows.length !== lineIds.length || listingIds.some(id => !presentListingIds.has(id))
    || skuIds.some(id => !presentSkuIds.has(id))) throw new NotFoundException("Finance dimension reference was not found");
  await requireReferences(tx, fulfillmentSuppliers, input.lines.map((line) => line.supplierId), "Supplier");
  const orderById = new Map(orderRows.map(order => [order.id, order])), lineById = new Map(lineRows.map(line => [line.id, line]));
  const skuById = new Map(skuRows.map(sku => [sku.id, sku])), listingById = new Map(listingRows.map(listing => [listing.id, listing]));
  const catalogByLine = new Map(catalogRows.map(link => [link.orderLineId, link]));
  const codes = [...new Set(lineRows.flatMap(line => line.skuCode ? [line.skuCode] : []))];
  const knownCodes = codes.length ? await tx.select({ id: skus.id, code: skus.code }).from(skus).where(inArray(skus.code, codes)) : [];
  const skuByCode = new Map(knownCodes.map(sku => [sku.code, sku.id]));
  for (const fact of input.lines) {
    const order = fact.orderId ? orderById.get(fact.orderId.toLowerCase()) : undefined;
    const line = fact.orderLineId ? lineById.get(fact.orderLineId.toLowerCase()) : undefined;
    if (line && !sameReference(line.orderId, fact.orderId)) referenceMismatch();
    if (order && input.accountId !== null && !sameReference(order.accountId, input.accountId)) referenceMismatch();
    if (order && accountPlatform !== null && order.platform !== accountPlatform) referenceMismatch();
    // An exact reversal retains its original immutable dimensions. A later
    // catalog remap cannot prevent correcting the original economic fact.
    if (fact.correctionKind !== "original") continue;
    const catalog = line ? catalogByLine.get(line.id) : undefined;
    const sku = fact.skuId ? skuById.get(fact.skuId.toLowerCase()) : undefined;
    const listing = fact.listingId ? listingById.get(fact.listingId.toLowerCase()) : undefined;
    if (sku && catalog?.skuId && sku.id !== catalog.skuId) referenceMismatch();
    if (sku && !catalog?.skuId && line?.skuCode && skuByCode.has(line.skuCode) && skuByCode.get(line.skuCode) !== sku.id) referenceMismatch();
    if (listing && catalog?.listingId && listing.id !== catalog.listingId) referenceMismatch();
    const linkedSku = sku ?? (catalog?.skuId ? skuById.get(catalog.skuId) : undefined);
    const linkedListing = listing ?? (catalog?.listingId ? listingById.get(catalog.listingId) : undefined);
    if (listing && linkedSku && listing.spuId !== linkedSku.spuId) referenceMismatch();
    if (sku && linkedListing && sku.spuId !== linkedListing.spuId) referenceMismatch();
    if (listing && (accountPlatform !== null && listing.platform !== accountPlatform || order && listing.platform !== order.platform)) referenceMismatch();
  }
}

function referenceIds(ids: Array<string | null>) {
  return [...new Set(ids.filter((id): id is string => id !== null).map(id => id.toLowerCase()))];
}

function sameReference(left: string | null, right: string | null) {try{return sharedSameReference(left,right);}catch(error){rethrowOriginalOwnerError(error);}}

function referenceMismatch(): never {
  throw new UnprocessableEntityException({ code: "finance_reference_mismatch", message: "财务分录的订单 行 商品或渠道引用不属于同一真实业务依据" });
}

async function requireReferences(
  tx: TenantTransaction,
  table: typeof orders | typeof orderLines | typeof skus | typeof listings | typeof fulfillmentSuppliers,
  rawIds: Array<string | null>,
  label: string,
) {
  const ids = referenceIds(rawIds);
  if (!ids.length) return;
  const rows = await tx.select({ id: table.id }).from(table).where(inArray(table.id, ids));
  if (rows.length !== ids.length) throw new NotFoundException(`${label} reference was not found`);
}

async function validateCorrections(tx: TenantTransaction, input: RecordFinanceStatementInput, lines: FinanceFactInput[], lockBasis = true) {
  const corrections = lines.filter((line) => line.correctsFactId !== null);
  if (!corrections.length) return;
  const correctedIds = referenceIds(corrections.map(line => line.correctsFactId));
  const corrected = await tx.select({ fact: financeFacts, statement: financeStatements }).from(financeFacts)
    .innerJoin(financeStatements, eq(financeStatements.id, financeFacts.statementId)).where(inArray(financeFacts.id, correctedIds));
  if (corrected.length !== correctedIds.length) {
    throw new NotFoundException("Corrected finance fact was not found");
  }
  const byId = new Map(corrected.map(row => [row.fact.id, row]));
  for (const id of [...correctedIds].sort()) {
    const original = byId.get(id)!.fact;
    if (lockBasis) await lock(tx, `finance-correction:${original.tenantId}:${id}`);
  }
  const existing = await tx.select({ correctsFactId: financeFacts.correctsFactId, correctionKind: financeFacts.correctionKind })
    .from(financeFacts).where(inArray(financeFacts.correctsFactId, correctedIds));
  const existingKinds = new Set(existing.map(row => `${row.correctionKind}:${row.correctsFactId}`));
  const seen = new Set<string>();
  const scopeKey = input.sourceIdentity ? financeSourceScopeKey({ ...input, sourceIdentity: input.sourceIdentity }) : null;
  for (const line of corrections) {
    const { fact: original, statement } = byId.get(line.correctsFactId!.toLowerCase())!;
    if (original.correctionKind !== "original" || original.correctsFactId !== null)
      throw new UnprocessableEntityException({ code: "finance_correction_root_required", message: "纠正必须指向最初的原始分录 不可再次冲销冲销项或替换项" });
    if (!identifiedFinanceFact(original, statement) || statement.provider !== input.provider || statement.scopeKey !== scopeKey
      || !sameReference(statement.accountId, input.accountId) || !sameReference(original.accountId, input.accountId))
      throw new UnprocessableEntityException({ code: "finance_correction_source_mismatch", message: "纠正必须保留原分录的真实来源 账户与供应商范围 未知旧依据不可推定补齐" });
    const signature = `${line.correctionKind}:${original.id}`;
    if (seen.has(signature) || existingKinds.has(signature))
      throw new ConflictException({ code: "finance_correction_already_recorded", message: "该原始分录的同类纠正已有真实凭据 不可重复记账" });
    seen.add(signature);
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
      if (!existingKinds.has(`reversal:${original.id}`)) {
        throw new UnprocessableEntityException("Finance replacement requires a recorded reversal");
      }
    }
  }
}

function sameDimensions(left: FinanceFactInput, right: FactRow) {
  return sameReference(left.orderId, right.orderId)
    && sameReference(left.orderLineId, right.orderLineId)
    && sameReference(left.skuId, right.skuId)
    && sameReference(left.listingId, right.listingId)
    && sameReference(left.supplierId, right.supplierId);
}

function identifiedFinanceFact(fact: FactRow, statement: FinanceStatementEvidenceRow): boolean {try{return sharedIdentifiedFinanceFact(fact,statement);}catch(error){rethrowOriginalOwnerError(error);}}

function calculateContribution(
  fact: FactRow,
  statement: StatementRow,
  version: MetricVersionRow,
  rates: FxRateRow[],
  monetaryBasis: FinanceCalculationMonetaryBasis,
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
  const fxRate = fact.currency === version.reportingCurrency ? undefined : rates
    .filter((rate) =>
      rate.baseCurrency === fact.currency
      && rate.quoteCurrency === version.reportingCurrency
      && rate.effectiveAt <= fact.occurredAt)
    .sort((left, right) =>
      right.effectiveAt.getTime() - left.effectiveAt.getTime()
      || right.retrievedAt.getTime() - left.retrievedAt.getTime()
      || compareId(left, right))[0];
  const converted = monetaryExact(() => convertFinanceMinorAmount({ amountMinor: fact.amountMinor,
    sourceCurrency: fact.currency, targetCurrency: version.reportingCurrency,
    rateNumerator: fxRate?.rateNumerator, rateDenominator: fxRate?.rateDenominator,
    rateBasis: fxRate?.monetaryBasis ?? null, calculationBasis: monetaryBasis }));
  return {
    fact,
    statement,
    bucket,
    effectSign,
    fxRateId: fxRate?.id ?? null,
    reportingAmountMinor: converted.amountMinor,
    monetaryProblem: converted.problem,
  };
}

function profitDiagnostics(
  facts: FactRow[],
  contributions: CalculatedContribution[],
  version: MetricVersionRow,
  coverageDimension: FinanceProfitCoverageDimension,
  monetaryBasis: FinanceCalculationMonetaryBasis,
): FinanceProfitDiagnosticView {
  const presentTypes = new Set(facts.map((fact) => fact.factType));
  return {
    sourceIdentity: { schemaVersion: 1, unidentifiedFactIds: contributions.filter(entry => !identifiedFinanceFact(entry.fact, entry.statement))
      .map(entry => entry.fact.id).sort() },
    monetary: { unknownCurrencies: monetaryBasis.currencies.filter(entry => entry.minorDigits === null).map(entry => entry.currency).sort(),
      ambiguousFxRateIds: [...new Set(contributions.filter(entry => entry.monetaryProblem === "fx_rate_unit_unknown" && entry.fxRateId)
        .map(entry => entry.fxRateId!))].sort() },
    coverage: evaluateFinanceCoverage(facts.map((fact) => ({ ...fact, correctionKind: FinanceCorrectionKindSchema.parse(fact.correctionKind) })), version.requiredFactTypes, coverageDimension),
    missingFactTypes: version.requiredFactTypes.filter((type) => !presentTypes.has(type)).sort(),
    missingFxPairs: [...new Set(contributions
      .filter((contribution) => contribution.fact.currency !== version.reportingCurrency && contribution.fxRateId === null)
      .map((contribution) =>
        `${contribution.fact.currency}/${version.reportingCurrency}`))].sort(),
    unclassifiedFactTypes: [...new Set(contributions
      .filter((contribution) => contribution.bucket === "unclassified")
      .map((contribution) => contribution.fact.factType))].sort(),
  };
}

function sumBucket(contributions: CalculatedContribution[], bucket: FinanceProfitBucket): number {try{return sharedSumBucket(contributions,bucket);}catch(error){rethrowOriginalOwnerError(error);}}

export async function statementView(
  tx: TenantTransaction,
  statement: StatementRow,
): Promise<FinanceStatementView> {
  const facts = await tx.select().from(financeFacts)
    .where(eq(financeFacts.statementId, statement.id))
    .orderBy(asc(financeFacts.lineKey));
  return FinanceStatementViewSchema.parse({
    sourceIdentity: statement.sourceIdentity ?? null,
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
    lines: facts.map(factView),
  });
}

export function statementHeaderView(statement: Pick<StatementRow,"sourceIdentity"|"id"|"accountId"|"provider"|"statementKind"|"externalStatementId"|
  "periodStart"|"periodEnd"|"sourceCurrency"|"observedAt"|"recordedAt"|"checksum">) {
  return FinanceStatementViewSchema.omit({lines:true}).parse({
    sourceIdentity:statement.sourceIdentity??null,id:statement.id,accountId:statement.accountId,provider:statement.provider,
    statementKind:statement.statementKind,externalStatementId:statement.externalStatementId,periodStart:statement.periodStart.toISOString(),
    periodEnd:statement.periodEnd.toISOString(),sourceCurrency:statement.sourceCurrency,observedAt:statement.observedAt.toISOString(),
    recordedAt:statement.recordedAt.toISOString(),checksum:statement.checksum,
  });
}

export function factView(fact: FactRow): FinanceFactView {
  return FinanceFactViewSchema.parse({
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
      sourceEntryId: fact.sourceEntryId ?? null,
      recordedAt: fact.recordedAt.toISOString(),
  });
}

export function fxRateView(rate: FxRateRow): FinanceFxRateView {
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
    monetaryBasis: rate.monetaryBasis ?? null,
  });
}

export async function metricView(
  tx: TenantTransaction,
  metric: MetricRow,
  pin?: { versionNumber: number; name: string },
): Promise<FinanceProfitMetricView> {
  const [version] = await tx.select().from(financeProfitMetricVersions).where(and(
    eq(financeProfitMetricVersions.metricId, metric.id),
    eq(financeProfitMetricVersions.versionNumber, pin?.versionNumber ?? metric.currentVersion),
  )).limit(1);
  if (!version) throw new ConflictException("Profit metric version is missing");
  return FinanceProfitMetricViewSchema.parse({
    id: metric.id,
    name: pin?.name ?? metric.name,
    currentVersion: version.versionNumber,
    status: metric.status,
    version: metricVersionView(version),
    createdAt: metric.createdAt.toISOString(),
    updatedAt: metric.updatedAt.toISOString(),
  });
}

export function metricVersionView(version: MetricVersionRow) {
  return FinanceProfitMetricVersionViewSchema.parse({id:version.id,metricId:version.metricId,versionNumber:version.versionNumber,
    reportingCurrency:version.reportingCurrency,revenueFactTypes:version.revenueFactTypes,costFactTypes:version.costFactTypes,
    requiredFactTypes:version.requiredFactTypes,reasonCode:version.reasonCode,checksum:version.checksum,createdAt:version.createdAt.toISOString()});
}

export async function profitRunView(
  tx: TenantTransaction,
  run: RunRow,
): Promise<FinanceProfitRunView> {try{return await sharedProfitRunView(tx,run);}catch(error){rethrowOriginalOwnerError(error);}}







function buildBreakdowns(contributions:CalculatedContribution[],onlyDimension?:FinanceProfitCoverageDimension){
  try{return sharedBuildBreakdowns(contributions,onlyDimension);}catch(error){rethrowOriginalOwnerError(error);}
}

async function profitInputChecksum(
  tx: TenantTransaction,
  input: CalculateFinanceProfitInput,
  monetaryBasis: FinanceCalculationMonetaryBasis | null,
  sourceIdentityVersion: 1 | null,
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
    ...(sourceIdentityVersion === null ? {} : { sourceIdentityVersion }),
    ...(monetaryBasis === null ? {} : { monetaryBasis }),
    coverageDimension: input.coverageDimension ?? "order",
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
  if (denominator === 0n) throw new UnprocessableEntityException("Ratio denominator must be nonzero");
  const sign = (numerator < 0n) !== (denominator < 0n) ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  const divisor = denominator < 0n ? -denominator : denominator;
  return sign * ((absolute + divisor / 2n) / divisor);
}

function safeNumber(value: bigint): number {try{return sharedSafeNumber(value);}catch(error){rethrowOriginalOwnerError(error);}}

function marginNumber(value: bigint): number {
  if (value < -2_147_483_648n || value > 2_147_483_647n) moneyOverflow();
  return safeNumber(value);
}

function moneyOverflow(): never {try{return sharedMoneyOverflow();}catch(error){rethrowOriginalOwnerError(error);}}

function monetaryExact<T>(operation: () => T): T {try{return sharedMonetaryExact(operation);}catch(error){rethrowOriginalOwnerError(error);}}

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

async function validateNewStatementInTransaction(tx: TenantTransaction, input: RecordFinanceStatementInput, lines: RecordFinanceStatementInput["lines"], scopeKey: string, lockBasis = true) {
      if (!input.sourceIdentity) throw new ConflictException({ code: "finance_source_identity_required", message: "新财务凭据必须明确真实来源身份 旧格式仅支持原始提交的精确重放" });
      const entries = lines.map(line => FinanceSourceEntryIdSchema.safeParse(line.sourceEntryId));
      if (entries.some(entry => !entry.success) || new Set(lines.map(line => line.sourceEntryId)).size !== lines.length)
        throw new ConflictException({ code: "finance_source_entry_required", message: "每个财务分录必须填写同来源内唯一且稳定的真实外部分录编号" });
      await validateStatementReferences(tx, input);
      await validateCorrections(tx, input, lines, lockBasis);
      const [duplicateEntry] = await tx.select({ id: financeFacts.id }).from(financeFacts).where(and(
        eq(financeFacts.sourceProvider, input.provider), eq(financeFacts.sourceScopeKey, scopeKey),
        inArray(financeFacts.sourceEntryId, lines.map(line => line.sourceEntryId!)),
      )).limit(1);
      if (duplicateEntry) throw new ConflictException({ code: "finance_source_entry_already_recorded", message: "原始来源分录已经记账 换报表或行号不能再次确认同一费用" });

  return undefined;
}

async function planNewMetricInTransaction(tx: TenantTransaction, current: TenantContext, input: UpsertFinanceProfitMetricInput, lockBasis = true) {
      let existing: MetricRow | undefined;
      if (input.metricId) {
        if (lockBasis) await lock(tx, `finance-profit-metric-id:${current.tenantId}:${input.metricId.toLowerCase()}`);
        const query = tx.select().from(financeProfitMetrics).where(eq(financeProfitMetrics.id, input.metricId)).limit(1);
        [existing] = lockBasis ? await query.for("update") : await query;
        if (!existing) throw new NotFoundException("Profit metric not found");
        if (input.expectedVersion === undefined || input.expectedVersion !== existing.currentVersion)
          throw new ConflictException({ code: "finance_profit_metric_version_changed", message: "更新利润口径需要填写其当前版本 请重新核对后提交" });
      } else if (input.expectedVersion !== undefined) {
        throw new UnprocessableEntityException("A new profit metric cannot have an expected version");
      }
      if (lockBasis) await lock(tx, `finance-profit-metric-name:${current.tenantId}:${input.name}`);
      const [sameName] = await tx.select({ id: financeProfitMetrics.id }).from(financeProfitMetrics)
        .where(eq(financeProfitMetrics.name, input.name)).limit(1);
      if (sameName && sameName.id !== existing?.id) throw new ConflictException("A profit metric with this name already exists");

  return existing;
}

async function planNewProfitInTransaction(tx: TenantTransaction, current: TenantContext, input: CalculateFinanceProfitInput, lockBasis = true) {
      if (lockBasis) await lock(tx, `finance-profit-metric-id:${current.tenantId}:${input.metricId.toLowerCase()}`);
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
      const monetaryBasis = monetaryExact(() => buildFinanceCalculationBasis([version.reportingCurrency, ...facts.map(fact => fact.currency)]));
      const statementById = new Map(statements.map((statement) => [statement.id, statement]));
      const contributions = facts.map((fact) =>
        calculateContribution(fact, statementById.get(fact.statementId)!, version, rates, monetaryBasis));
      const coverageDimension = input.coverageDimension ?? "order";
      const diagnostics = profitDiagnostics(facts, contributions, version, coverageDimension, monetaryBasis);
      const complete = diagnostics.missingFactTypes.length === 0
        && diagnostics.missingFxPairs.length === 0
        && diagnostics.unclassifiedFactTypes.length === 0
        && diagnostics.coverage!.checkedEntityCount > 0
        && diagnostics.coverage!.missingByEntity.length === 0
        && diagnostics.coverage!.unattributedFactIds.length === 0
        && diagnostics.monetary!.unknownCurrencies.length === 0
        && diagnostics.monetary!.ambiguousFxRateIds.length === 0
        && diagnostics.sourceIdentity!.unidentifiedFactIds.length === 0;
      const revenueMinor = complete ? sumBucket(contributions, "revenue") : null;
      const costMinor = complete ? sumBucket(contributions, "cost") : null;
      const profitMinor = complete ? safeNumber(BigInt(revenueMinor!) - BigInt(costMinor!)) : null;
      const marginBps = complete && revenueMinor !== 0
        ? marginNumber(roundRatio(BigInt(profitMinor!) * 10_000n, BigInt(revenueMinor!)))
        : null;
      // Reject an unrepresentable requested subtotal before committing a run
      // whose first authoritative read would otherwise fail after persistence.
      if (complete && coverageDimension !== "aggregate") buildBreakdowns(contributions, coverageDimension);
      const inputChecksum = checksum({
        sourceIdentityVersion: 1,
        monetaryBasis,
        coverageDimension,
        metricVersionId: version.id,
        metricVersionChecksum: version.checksum,
        statements: statements
          .map((statement) => ({ id: statement.id, checksum: statement.checksum }))
          .sort(compareId),
        fxRates: rates
          .map((rate) => ({ id: rate.id, checksum: rate.checksum }))
          .sort(compareId),
      });

  return {metric,version,monetaryBasis,complete,revenueMinor,costMinor,profitMinor,marginBps,diagnostics,inputChecksum,contributions};
}
