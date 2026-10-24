import type { PrepareFinanceCommand } from "@yummyai/contracts/finance/finance-command";
import type { FinanceCostAllocationVersionInput, CalculateFinanceAllocatedProfitInput } from "@yummyai/contracts/finance/cost-allocation";
import { financeCommandOwnerLock } from "./finance-command-lock.js";
import { Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { authorize, ForbiddenError, intersectPermissionContexts, Permission, permissionScope } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import {
  CalculateFinanceAllocatedProfitInputSchema, FINANCE_COST_ALLOCATION_ALGORITHM, FinanceCostAllocationBaseViewSchema,
  FinanceCostAllocationListInputSchema, FinanceCostAllocationPreviewInputSchema, FinanceCostAllocationPreviewViewSchema,
  FinanceCostAllocationSourceListInputSchema, FinanceCostAllocationTargetListInputSchema, FinanceCostAllocationVersionInputSchema,
  financeAllocatedProfitInputIdentity, financeCostPreviewChecksumIdentity, financeCostRunRequestIdentity,
  financeCostVersionChecksumIdentity, financeCostVersionRequestIdentity, normalizeFinanceCostAllocationPreviewInput, splitFinanceCostMinor,
  type FinanceAllocatedProfitBreakdown, type FinanceAllocatedProfitDiagnostics, type FinanceCostAllocationDimension,
  type FinanceCostAllocationPreview, type FinanceCostAllocationPreviewInput, type FinanceCostAllocationSource,
  type FinanceCostAllocationTarget,
} from "@yummyai/contracts/finance/cost-allocation";
import {
  financeAllocatedProfitRuns, financeAllocatedProfitSlices, financeCostAllocationVersions,
  loadCurrentMembershipContext, withTenant, type DatabaseConnection, type TenantTransaction,
} from "@yummyai/database";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import {
  allocatedProfitRunView, costAllocationParse, costAllocationVersionView, directlyAttributed,
  readAllocatedProfitRun, readAllocatedProfitRuns, readAllocatedProfitSlices, readCostAllocationBase, readCostAllocationSources,
  readCostAllocationTargets, readCostAllocationVersion, readCostAllocationVersions, readCostSourceFamilies, sourceUnavailable,
  type CostAllocationBase, type CostBaseEntry, type CostSourceFamily, type CostVersionRow,
} from "./finance-cost-allocation.read.js";
import {
  allocationConflict, allocationInputInvalid, allocationMissing, costAllocationHash, lockCostAllocationTargets, resolveCostAllocationTargets,
} from "./finance-cost-allocation.targets.js";

type SliceInsert = typeof financeAllocatedProfitSlices.$inferInsert;
type ProjectedSlice = Omit<SliceInsert, "runId">;

/** Attribution of verified Finance contributions; this owner creates no expenses,
 * supplier balances, payment instructions or replacements for the source ledger. */
@Injectable()
export class FinanceCostAllocationService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService) {}

  async validateCommandInTransaction(tx: TenantTransaction, context: TenantContext, original: PrepareFinanceCommand) {
    const current = await currentAuthority(tx, context, Permission.FinanceReview);
    if (original.kind === "cost_version_approve") await planNewCostVersionInTransaction(tx, current, financeCostVersionRequestIdentity(original.input).input, false);
    else if (original.kind === "allocated_profit_calculate") await planNewAllocatedProfitInTransaction(tx, current, financeCostRunRequestIdentity(original.input).input, false);
    else allocationInputInvalid();
  }

  async base(context: TenantContext, rawId: string) {
    const id = parseId(rawId);
    return this.read(context, async tx => {
      const base = await readCostAllocationBase(tx, id, false);
      const { contributions: ignored, ...header } = base.view; void ignored;
      return FinanceCostAllocationBaseViewSchema.parse(header);
    });
  }

  async sources(context: TenantContext, raw: unknown) {
    const input = costAllocationParse(FinanceCostAllocationSourceListInputSchema, raw);
    return this.read(context, (tx, current) => readCostAllocationSources(tx, current, input));
  }

  async targets(context: TenantContext, raw: unknown) {
    const input = costAllocationParse(FinanceCostAllocationTargetListInputSchema, raw);
    return this.read(context, (tx, current) => readCostAllocationTargets(tx, current, input));
  }

  async preview(context: TenantContext, raw: unknown) {
    const input = normalizeFinanceCostAllocationPreviewInput(costAllocationParse(FinanceCostAllocationPreviewInputSchema, raw));
    return this.read(context, (tx, current) => previewInTransaction(tx, current, input));
  }

  async listVersions(context: TenantContext, raw: unknown) {
    const input = costAllocationParse(FinanceCostAllocationListInputSchema, raw);
    return this.read(context, (tx, current) => readCostAllocationVersions(tx, current, input));
  }

  async version(context: TenantContext, rawId: string) {
    const id = parseId(rawId);
    return this.read(context, tx => readCostAllocationVersion(tx, id));
  }

  async listRuns(context: TenantContext, raw: unknown) {
    const input = costAllocationParse(FinanceCostAllocationListInputSchema, raw);
    return this.read(context, (tx, current) => readAllocatedProfitRuns(tx, current, input));
  }

  async run(context: TenantContext, rawId: string) {
    const id = parseId(rawId);
    return this.read(context, tx => readAllocatedProfitRun(tx, id));
  }

  async slices(context: TenantContext, rawRunId: string, raw: unknown) {
    const id = parseId(rawRunId), input = costAllocationParse(FinanceCostAllocationListInputSchema, raw);
    if (input.baseRunId || input.allocationId) allocationInputInvalid();
    return this.read(context, (tx, current) => readAllocatedProfitSlices(tx, current, id, input));
  }

  async approve(context: TenantContext, raw: unknown) {
    return withTenant(this.database.db, context, tx => this.approveInTransaction(tx, context, raw));
  }

  async approveInTransaction(tx: TenantTransaction, context: TenantContext, raw: unknown) {
    const requestIdentity = financeCostVersionRequestIdentity(costAllocationParse(FinanceCostAllocationVersionInputSchema, raw));
    const input = requestIdentity.input, requestChecksum = costAllocationHash(requestIdentity);
      const current = await currentAuthority(tx, context, Permission.FinanceReview);
      await financeCommandOwnerLock(tx, current, "cost_version_approve", input.idempotencyKey);
      await lock(tx, `finance-cost-version-request:${current.tenantId}:${input.idempotencyKey}`);
      const [existing] = await tx.select().from(financeCostAllocationVersions).where(eq(financeCostAllocationVersions.idempotencyKey, input.idempotencyKey)).limit(1);
      if (existing) {
        if (existing.reviewedBy !== current.userId || existing.requestChecksum !== requestChecksum) requestMismatch();
        return costAllocationVersionView(tx, existing);
      }
      const {preview,previous} = await planNewCostVersionInTransaction(tx, current, input);
      const id = createEntityId(), allocationId = input.allocationId ?? id, versionNumber = previous ? previous.versionNumber + 1 : 1;
      const previousVersionId = previous?.id ?? null;
      const checksum = costAllocationHash(financeCostVersionChecksumIdentity({ allocationId, versionNumber, previousVersionId, preview }));
      const [row] = await tx.insert(financeCostAllocationVersions).values({ id, tenantId: current.tenantId, allocationId, versionNumber,
        previousVersionId, baseRunId: input.baseRunId, baseInputChecksum: input.baseInputChecksum, dimension: input.dimension,
        method: input.method, algorithm: FINANCE_COST_ALLOCATION_ALGORITHM, reasonCode: input.reasonCode, basisDescription: input.basisDescription,
        preview, checksum, requestIdentity, requestChecksum, idempotencyKey: input.idempotencyKey, reviewedBy: current.userId }).returning();
      if (!row) sourceUnavailable();
      await this.audit.recordInTransaction(tx, current, { action: "finance.cost_allocation.version_approved", resourceType: "finance_cost_allocation_version",
        resourceId: row.id, result: "success", metadata: { baseRunId: row.baseRunId, allocationId, versionNumber } });
      return costAllocationVersionView(tx, row);
  }

  async calculate(context: TenantContext, raw: unknown) {
    return withTenant(this.database.db, context, tx => this.calculateInTransaction(tx, context, raw));
  }

  async calculateInTransaction(tx: TenantTransaction, context: TenantContext, raw: unknown) {
    const requestIdentity = financeCostRunRequestIdentity(costAllocationParse(CalculateFinanceAllocatedProfitInputSchema, raw));
    const input = requestIdentity.input, requestChecksum = costAllocationHash(requestIdentity);
      const current = await currentAuthority(tx, context, Permission.FinanceReview);
      await financeCommandOwnerLock(tx, current, "allocated_profit_calculate", input.idempotencyKey);
      await lock(tx, `finance-allocated-profit-request:${current.tenantId}:${input.idempotencyKey}`);
      const [existing] = await tx.select().from(financeAllocatedProfitRuns).where(eq(financeAllocatedProfitRuns.idempotencyKey, input.idempotencyKey)).limit(1);
      if (existing) {
        if (existing.calculatedBy !== current.userId || existing.requestChecksum !== requestChecksum) requestMismatch();
        return allocatedProfitRunView(tx, existing);
      }
      const {base,slices,projection,versionPins,inputChecksum} = await planNewAllocatedProfitInTransaction(tx, current, input);
      const id = createEntityId();
      const [row] = await tx.insert(financeAllocatedProfitRuns).values({ id, tenantId: current.tenantId, baseRunId: input.baseRunId,
        baseInputChecksum: input.baseInputChecksum, dimension: input.dimension, versionPins, algorithm: FINANCE_COST_ALLOCATION_ALGORITHM,
        reportingCurrency: base.view.reportingCurrency, ...projection, inputChecksum, requestIdentity, requestChecksum,
        idempotencyKey: input.idempotencyKey, calculatedBy: current.userId }).returning();
      if (!row) sourceUnavailable();
      for (let offset = 0; offset < slices.length; offset += 500)
        await tx.insert(financeAllocatedProfitSlices).values(slices.slice(offset, offset + 500).map(slice => ({ ...slice, runId: id })));
      await this.audit.recordInTransaction(tx, current, { action: "finance.cost_allocation.profit_calculated", resourceType: "finance_allocated_profit_run",
        resourceId: id, result: "success", metadata: { baseRunId: row.baseRunId, dimension: row.dimension, versionCount: versionPins.length, sliceCount: slices.length } });
      return allocatedProfitRunView(tx, row);
  }

  private read<T>(context: TenantContext, action: (tx: TenantTransaction, current: TenantContext) => Promise<T>): Promise<T> {
    return withTenant(this.database.db, context, async tx => action(tx, await currentAuthority(tx, context, Permission.FinanceRead)),
      { isolationLevel: "repeatable read", accessMode: "read write" });
  }
}

async function currentAuthority(tx: TenantTransaction, base: TenantContext, permission: Permission) {
  const current = intersectPermissionContexts(base, await loadCurrentMembershipContext(tx, base, { lock: true }));
  authorize(current, permission);
  if (permissionScope(current, permission) !== "tenant") throw new ForbiddenError(permission, "outside_data_scope");
  return current;
}

async function previewInTransaction(tx: TenantTransaction, current: TenantContext, raw: FinanceCostAllocationPreviewInput,
  options: { base?: CostAllocationBase; families?: Map<string, CostSourceFamily>; checkVersion?: boolean } = {}): Promise<FinanceCostAllocationPreview> {
  const input = normalizeFinanceCostAllocationPreviewInput(raw), base = options.base ?? await readCostAllocationBase(tx, input.baseRunId);
  if (base.row.id !== input.baseRunId || base.row.inputChecksum !== input.baseInputChecksum) baseChanged();
  if (options.checkVersion !== false && input.allocationId) {
    const previous = await currentVersion(tx, input.allocationId);
    if (previous.versionNumber !== input.expectedVersion || previous.dimension !== input.dimension) versionChanged();
  }
  const families = options.families ?? await readCostSourceFamilies(tx, base);
  const targets = await resolveCostAllocationTargets(tx, current.tenantId, input.dimension, input.sources.flatMap(source => source.targets.map(target => target.key)));
  const sources: FinanceCostAllocationSource[] = [];
  for (const selected of input.sources) {
    const family = families.get(selected.rootFactId);
    if (!family?.root) sourceUnavailable();
    if (!family.complete)
      allocationConflict("finance_cost_allocation_correction_chain_changed", "原汇总未包含费用完整纠正链 请先明确计算包含完整来源的新汇总");
    if (family.entries.some(entry => entry.contribution.bucket !== "cost"))
      allocationConflict("finance_cost_allocation_not_cost", "只能对原口径中真实分类为成本的费用进行分摊");
    if (input.dimension !== "period" && family.entries.some(entry => directlyAttributed(entry, input.dimension)))
      allocationConflict("finance_cost_allocation_already_attributed", "费用在所选对象维度已有直接归属 不能再重复分摊");
    for (const entry of family.entries) {
      if (entry.contribution.reportingAmountMinor === null) sourceUnavailable();
      const shares = splitFinanceCostMinor(entry.contribution.reportingAmountMinor, selected.targets).map(({ key, ...share }) => {
        const target = targets.get(key); if (!target) allocationMissing();
        assertTargetCompatible(entry, target);
        return { ...share, target };
      });
      sources.push({ rootFactId: family.rootFactId, contributionId: entry.contribution.id, factId: entry.fact.id,
        statementId: entry.statement.id, statementChecksum: entry.statement.checksum, sourceEntryId: entry.fact.sourceEntryId ?? null,
        factType: entry.fact.factType, effectSign: entry.contribution.effectSign as 1 | -1, sourceCurrency: entry.contribution.sourceCurrency,
        sourceAmountMinor: entry.contribution.sourceAmountMinor, reportingCurrency: base.view.reportingCurrency,
        reportingAmountMinor: entry.contribution.reportingAmountMinor, fxRateId: entry.contribution.fxRateId,
        sourceChainChecksum: family.sourceChainChecksum, shares });
    }
  }
  sources.sort((a, b) => a.contributionId < b.contributionId ? -1 : a.contributionId > b.contributionId ? 1 : 0);
  if (sources.reduce((sum, source) => sum + source.shares.length, 0) > 5000)
    allocationConflict("finance_cost_allocation_scope_too_large", "展开完整纠正链后超过五千条分片 请拆分明确的分摊范围");
  const preview = { baseRunId: input.baseRunId, baseInputChecksum: input.baseInputChecksum, allocationId: input.allocationId,
    expectedVersion: input.expectedVersion, dimension: input.dimension, method: input.method, algorithm: FINANCE_COST_ALLOCATION_ALGORITHM,
    reportingCurrency: base.view.reportingCurrency, reasonCode: input.reasonCode, basisDescription: input.basisDescription, sources };
  return FinanceCostAllocationPreviewViewSchema.parse({ ...preview, previewChecksum: costAllocationHash(financeCostPreviewChecksumIdentity(preview)) });
}

async function currentVersion(tx: TenantTransaction, allocationId: string): Promise<CostVersionRow> {
  const [row] = await tx.select().from(financeCostAllocationVersions).where(eq(financeCostAllocationVersions.allocationId, allocationId))
    .orderBy(desc(financeCostAllocationVersions.versionNumber)).limit(1);
  if (!row) allocationMissing(); return row;
}

async function projectSlices(tx: TenantTransaction, current: TenantContext, base: CostAllocationBase, families: Map<string, CostSourceFamily>,
  versions: CostVersionRow[], dimension: FinanceCostAllocationDimension): Promise<ProjectedSlice[]> {
  const allocated = new Map<string, { versionId: string; source: FinanceCostAllocationSource }>();
  for (const version of versions) for (const source of version.preview.sources) {
    if (allocated.has(source.contributionId))
      allocationConflict("finance_cost_allocation_version_overlap", "同一原费用不能被本次选择的多个规则重复分摊");
    allocated.set(source.contributionId, { versionId: version.id, source });
  }
  const directKeys = base.entries.filter(entry => !allocated.has(entry.contribution.id)).flatMap(entry => {
    const family = families.get(entry.fact.correctsFactId ?? entry.fact.id), key = directlyAttributed(entry, dimension);
    return family?.complete && key ? [key] : [];
  });
  const directTargets = await resolveCostAllocationTargets(tx, current.tenantId, dimension, directKeys);
  const slices: ProjectedSlice[] = [];
  for (const entry of base.entries) {
    const rootFactId = entry.fact.correctsFactId ?? entry.fact.id, decision = allocated.get(entry.contribution.id);
    const amount = entry.contribution.reportingAmountMinor; if (amount === null) sourceUnavailable();
    const original = { tenantId: current.tenantId, baseContributionId: entry.contribution.id,
      sourceFactId: entry.fact.id, rootFactId, originalReportingAmountMinor: amount, bucket: entry.contribution.bucket,
      effectSign: entry.contribution.effectSign as 1 | -1, factType: entry.fact.factType };
    if (decision) {
      if (decision.source.factId !== entry.fact.id || decision.source.reportingAmountMinor !== amount) sourceUnavailable();
      for (const share of decision.source.shares) slices.push({ ...original, id: createEntityId(), allocationVersionId: decision.versionId,
        target: share.target, amountMinor: share.amountMinor, weight: share.weight, floorMinor: share.floorMinor,
        remainderNumerator: share.remainderNumerator, remainderDenominator: share.remainderDenominator, receivesRemainder: share.receivesRemainder });
    } else {
      const key = directlyAttributed(entry, dimension), target = families.get(rootFactId)?.complete && key ? directTargets.get(key) ?? null : null;
      if (key && families.get(rootFactId)?.complete && !target) sourceUnavailable();
      if (target) assertTargetCompatible(entry, target);
      slices.push({ ...original, id: createEntityId(), allocationVersionId: null, target, amountMinor: amount, weight: null,
        floorMinor: null, remainderNumerator: null, remainderDenominator: null, receivesRemainder: false });
    }
  }
  const baseIds = new Set(base.entries.map(entry => entry.contribution.id));
  if ([...allocated.keys()].some(id => !baseIds.has(id))) sourceUnavailable();
  const sums = new Map<string, bigint>();
  for (const slice of slices) sums.set(slice.baseContributionId, (sums.get(slice.baseContributionId) ?? 0n) + BigInt(slice.amountMinor));
  if (base.entries.some(entry => sums.get(entry.contribution.id) !== BigInt(entry.contribution.reportingAmountMinor!))) sourceUnavailable();
  return slices;
}

function projectCoverage(base: CostAllocationBase, slices: ProjectedSlice[]) {
  const reversed = new Set(base.entries.filter(entry => entry.fact.correctionKind === "reversal").map(entry => entry.fact.correctsFactId));
  const effective = new Set(base.entries.filter(entry => entry.fact.correctionKind !== "reversal" && !reversed.has(entry.fact.id)).map(entry => entry.fact.id));
  const groups = new Map<string, { target: FinanceCostAllocationTarget; entries: ProjectedSlice[] }>();
  for (const slice of slices) if (slice.target) {
    const group = groups.get(slice.target.key) ?? { target: slice.target, entries: [] };
    if (group.target.basisChecksum !== slice.target.basisChecksum) sourceUnavailable();
    group.entries.push(slice); groups.set(slice.target.key, group);
  }
  const missingByTarget: FinanceAllocatedProfitDiagnostics["missingByTarget"] = [];
  for (const [key, group] of groups) {
    const present = new Set(group.entries.filter(entry => effective.has(entry.sourceFactId)).map(entry => entry.factType));
    const missingFactTypes = base.requiredFactTypes.filter(type => !present.has(type)).sort();
    if (missingFactTypes.length) missingByTarget.push({ key, missingFactTypes });
  }
  missingByTarget.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const diagnostics: FinanceAllocatedProfitDiagnostics = { unallocatedContributionIds: [...new Set(slices.filter(slice => !slice.target).map(slice => slice.baseContributionId))].sort(),
    checkedTargetCount: groups.size, missingByTarget };
  const complete = diagnostics.unallocatedContributionIds.length === 0 && groups.size > 0 && missingByTarget.length === 0;
  const sum = (entries: ProjectedSlice[], bucket: "revenue" | "cost") => safeMinor(entries.filter(slice => slice.bucket === bucket)
    .reduce((total, slice) => total + BigInt(slice.amountMinor) * BigInt(slice.effectSign), 0n));
  const rawRevenue = sum(slices, "revenue"), rawCost = sum(slices, "cost");
  if (rawRevenue !== base.view.revenueMinor || rawCost !== base.view.costMinor || safeMinor(BigInt(rawRevenue) - BigInt(rawCost)) !== base.view.profitMinor) sourceUnavailable();
  const breakdowns: FinanceAllocatedProfitBreakdown[] = complete ? [...groups.values()].map(group => {
    const revenueMinor = sum(group.entries, "revenue"), costMinor = sum(group.entries, "cost");
    return { target: group.target, revenueMinor, costMinor, profitMinor: safeMinor(BigInt(revenueMinor) - BigInt(costMinor)),
      factCount: new Set(group.entries.map(entry => entry.sourceFactId)).size };
  }).sort((a, b) => a.target.key < b.target.key ? -1 : a.target.key > b.target.key ? 1 : 0) : [];
  return { status: complete ? "complete" as const : "incomplete" as const, revenueMinor: complete ? rawRevenue : null,
    costMinor: complete ? rawCost : null, profitMinor: complete ? base.view.profitMinor : null,
    marginBps: complete ? base.view.marginBps : null, diagnostics, breakdowns };
}

function assertTargetCompatible(entry: CostBaseEntry, target: FinanceCostAllocationTarget) {
  if (target.dimension === "period") return;
  if (entry.fact.accountId && target.accountId && entry.fact.accountId !== target.accountId)
    allocationConflict("finance_cost_allocation_target_changed", "原费用账户与目标订单的真实店铺不一致");
  for (const field of ["orderId", "orderLineId", "skuId", "listingId"] as const)
    if (entry.fact[field] && target[field] && entry.fact[field] !== target[field])
      allocationConflict("finance_cost_allocation_target_changed", "目标与原费用已知的对象关系不一致 请核对明确的分摊范围");
}

function safeMinor(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER))
    throw new UnprocessableEntityException({ code: "finance_money_overflow", message: "归属计算超过可精确记录的金额范围" });
  return Number(value);
}

function parseId(raw: string) { return costAllocationParse(EntityIdSchema, raw).toLowerCase(); }
function requestMismatch(): never { allocationConflict("finance_cost_allocation_request_mismatch", "原请求键已绑定另一操作者或另一份明确正文"); }
function versionChanged(): never { allocationConflict("finance_cost_allocation_version_changed", "规则版本已变化 请读取当前版本后重新预览"); }
function baseChanged(): never { allocationConflict("finance_cost_allocation_base_changed", "本次明确选择的原汇总摘要与真实计算不一致"); }
async function lock(tx: TenantTransaction, key: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`); }

async function planNewCostVersionInTransaction(tx: TenantTransaction, current: TenantContext, input: FinanceCostAllocationVersionInput, lockBasis = true) {
      if (lockBasis) {
        if (input.allocationId) await lock(tx, `finance-cost-allocation:${current.tenantId}:${input.allocationId}`);
        for (const root of input.sources.map(source => source.rootFactId).sort()) await lock(tx, `finance-correction:${current.tenantId}:${root}`);
        await lockCostAllocationTargets(tx, current.tenantId, input.dimension, input.sources.flatMap(source => source.targets.map(target => target.key)));
      }
      const { previewChecksum: ignoredChecksum, idempotencyKey: ignoredKey, ...previewInput } = input; void ignoredChecksum; void ignoredKey;
      const preview = await previewInTransaction(tx, current, previewInput);
      if (preview.previewChecksum !== input.previewChecksum)
        allocationConflict("finance_cost_allocation_preview_changed", "原来源链或目标关系已变化 请重新预览后明确批准");
      const previous = input.allocationId ? await currentVersion(tx, input.allocationId) : null;

  return {preview,previous};
}

async function planNewAllocatedProfitInTransaction(tx: TenantTransaction, current: TenantContext, input: CalculateFinanceAllocatedProfitInput, lockBasis = true) {
      const versions = input.versionIds.length ? await tx.select().from(financeCostAllocationVersions).where(inArray(financeCostAllocationVersions.id, input.versionIds)) : [];
      if (versions.length !== input.versionIds.length) allocationMissing();
      if (new Set(versions.map(version => version.allocationId)).size !== versions.length)
        allocationConflict("finance_cost_allocation_version_overlap", "一次归属计算不能同时选择同一规则的多个版本");
      if (lockBasis) for (const root of versions.map(version => version.allocationId).sort()) await lock(tx, `finance-cost-allocation:${current.tenantId}:${root}`);
      const base = await readCostAllocationBase(tx, input.baseRunId);
      if (base.row.inputChecksum !== input.baseInputChecksum) baseChanged();
      const rootIds = [...new Set(base.entries.map(entry => entry.fact.correctsFactId ?? entry.fact.id))].sort();
      if (lockBasis) for (const root of rootIds) await lock(tx, `finance-correction:${current.tenantId}:${root}`);
      const families = await readCostSourceFamilies(tx, base);
      for (const version of versions) {
        if (version.baseRunId !== input.baseRunId || version.baseInputChecksum !== input.baseInputChecksum || version.dimension !== input.dimension)
          allocationConflict("finance_cost_allocation_version_mismatch", "已批准规则必须属于本次明确选择的原汇总与归属维度");
        if (version.checksum !== costAllocationHash(financeCostVersionChecksumIdentity(version))) sourceUnavailable();
      }
      if (lockBasis) await lockCostAllocationTargets(tx, current.tenantId, input.dimension, [
        ...versions.flatMap(version => version.preview.sources.flatMap(source => source.shares.map(share => share.target.key))),
        ...base.entries.flatMap(entry => { const key = directlyAttributed(entry, input.dimension); return key ? [key] : []; }),
      ]);
      for (const version of versions) {
        const { previewChecksum: ignoredChecksum, idempotencyKey: ignoredKey, ...versionInput } = version.requestIdentity.input;
        void ignoredChecksum; void ignoredKey;
        const expected = await previewInTransaction(tx, current, versionInput, { base, families, checkVersion: false });
        if (expected.previewChecksum !== version.preview.previewChecksum)
          allocationConflict("finance_cost_allocation_target_changed", "已批准规则的目标关系或来源依据已变化 请建立明确的新版本");
      }
      const slices = await projectSlices(tx, current, base, families, versions, input.dimension);
      const projection = projectCoverage(base, slices);
      const versionPins = versions.map(version => ({ id: version.id, allocationId: version.allocationId,
        versionNumber: version.versionNumber, checksum: version.checksum })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const inputChecksum = costAllocationHash(financeAllocatedProfitInputIdentity({ ...input, versionPins }));

  return {versions,base,slices,projection,versionPins,inputChecksum};
}
