import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import type { TenantContext } from "@yummyai/contracts";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { isFinanceProfitVerified, type FinanceProfitRunView } from "@yummyai/contracts/finance";
import {
  FinanceAllocatedProfitRunPageSchema, FinanceAllocatedProfitRunViewSchema, FinanceAllocatedProfitSlicePageSchema,
  FinanceAllocatedProfitSliceSchema, FinanceCostAllocationSourcePageSchema, FinanceCostAllocationTargetPageSchema,
  FinanceCostAllocationVersionPageSchema, FinanceCostAllocationVersionViewSchema,
  financeCostSourceChainIdentity, financeCostVersionChecksumIdentity,
  type FinanceAllocatedProfitRun, type FinanceCostAllocationDimension, type FinanceCostAllocationTarget,
  type FinanceCostAllocationVersion, type FinanceCostSourceOption,
} from "@yummyai/contracts/finance/cost-allocation";
import {
  financeAllocatedProfitRuns, financeAllocatedProfitSlices, financeCostAllocationVersions, financeFacts,
  financeProfitContributions, financeProfitMetricVersions, financeProfitRuns, financeStatements, type TenantTransaction,
} from "@yummyai/database";
import { and, desc, eq, inArray, lt, lte, max, or, sql } from "drizzle-orm";
import { profitRunView } from "./finance.service.js";
import {financeStatementEvidenceColumns,type FinanceStatementEvidenceRow} from "./finance-statement-evidence.js";
import {
  allocationConflict, allocationInputInvalid, allocationMissing, costAllocationHash, costAllocationTargetKeys,
  normalizeTargetKey, resolveCostAllocationTargets,
} from "./finance-cost-allocation.targets.js";

export type CostVersionRow = typeof financeCostAllocationVersions.$inferSelect;
export type AllocatedRunRow = typeof financeAllocatedProfitRuns.$inferSelect;
export type AllocatedSliceRow = typeof financeAllocatedProfitSlices.$inferSelect;
export type CostBaseEntry = { contribution: typeof financeProfitContributions.$inferSelect;
  fact: typeof financeFacts.$inferSelect; statement: FinanceStatementEvidenceRow };
export type CostAllocationBase = { row: typeof financeProfitRuns.$inferSelect; view: FinanceProfitRunView;
  entries: CostBaseEntry[]; requiredFactTypes: FinanceProfitRunView["diagnostics"]["missingFactTypes"] };
export type CostSourceFamily = { rootFactId: string; root: CostBaseEntry | null; entries: CostBaseEntry[];
  sourceChainChecksum: string; complete: boolean };
export type AllocationPageQuery = { limit: number; cursor?: string };
type ListQuery = AllocationPageQuery & { baseRunId?: string; allocationId?: string };
type Cursor = { v: 1; scope: string; upperKey: string; key: string };
type BasisCache = Map<string, Promise<{ base: CostAllocationBase; families: Map<string, CostSourceFamily> }>>;

/** Original owner verification is always completed before any amount is reused. */
export async function readCostAllocationBase(tx: TenantTransaction, id: string, ready = true): Promise<CostAllocationBase> {
  const [row] = await tx.select().from(financeProfitRuns).where(eq(financeProfitRuns.id, id)).limit(1);
  if (!row) allocationMissing();
  const view = await profitRunView(tx, row);
  if (ready && (!isFinanceProfitVerified(view) || view.status !== "complete"))
    allocationConflict("finance_cost_allocation_base_incomplete", "原利润计算的货币或来源依据尚未完整核对");
  if (ready && view.diagnostics.coverage?.dimension !== "aggregate")
    allocationConflict("finance_cost_allocation_base_not_aggregate", "请选择原财务拥有者已核对完整的账单汇总计算");
  const entries = await tx.select({ contribution: financeProfitContributions, fact: financeFacts, statement: financeStatementEvidenceColumns })
    .from(financeProfitContributions).innerJoin(financeFacts, and(eq(financeFacts.tenantId, financeProfitContributions.tenantId), eq(financeFacts.id, financeProfitContributions.factId)))
    .innerJoin(financeStatements, and(eq(financeStatements.tenantId, financeFacts.tenantId), eq(financeStatements.id, financeFacts.statementId)))
    .where(eq(financeProfitContributions.runId, id));
  if (entries.length !== view.contributions.length) sourceUnavailable();
  if (entries.length > 20_000)
    allocationConflict("finance_cost_allocation_scope_too_large", "本次归属计算超过两万条来源 请先缩小原汇总范围");
  const [version] = await tx.select().from(financeProfitMetricVersions).where(eq(financeProfitMetricVersions.id, row.metricVersionId)).limit(1);
  if (!version) sourceUnavailable();
  return { row, view, entries, requiredFactTypes: version.requiredFactTypes };
}

export async function readCostSourceFamilies(tx: TenantTransaction, base: CostAllocationBase): Promise<Map<string, CostSourceFamily>> {
  const families = new Map<string, CostSourceFamily>();
  for (const entry of base.entries) {
    const rootFactId = entry.fact.correctsFactId ?? entry.fact.id;
    const family = families.get(rootFactId) ?? { rootFactId, root: null, entries: [], sourceChainChecksum: "", complete: false };
    family.entries.push(entry);
    if (entry.fact.id === rootFactId && entry.fact.correctionKind === "original") family.root = entry;
    families.set(rootFactId, family);
  }
  const roots = [...families.keys()];
  if (!roots.length) return families;
  const current = await tx.select({ fact: financeFacts, statementChecksum: financeStatements.checksum }).from(financeFacts)
    .innerJoin(financeStatements, and(eq(financeStatements.tenantId, financeFacts.tenantId), eq(financeStatements.id, financeFacts.statementId)))
    .where(or(inArray(financeFacts.id, roots), inArray(financeFacts.correctsFactId, roots)));
  const byRoot = new Map<string, typeof current>();
  for (const row of current) {
    const root = row.fact.correctsFactId ?? row.fact.id;
    const rows = byRoot.get(root) ?? []; rows.push(row); byRoot.set(root, rows);
  }
  for (const family of families.values()) {
    const rows = byRoot.get(family.rootFactId) ?? [], selected = new Set(family.entries.map(entry => entry.fact.id));
    family.complete = family.root !== null && rows.length === selected.size && rows.every(row => selected.has(row.fact.id));
    family.sourceChainChecksum = costAllocationHash(financeCostSourceChainIdentity(family.rootFactId, rows.map(row => ({
      id: row.fact.id, statementId: row.fact.statementId, statementChecksum: row.statementChecksum,
      correctsFactId: row.fact.correctsFactId, correctionKind: row.fact.correctionKind,
    }))));
    family.entries.sort((a, b) => a.contribution.id < b.contribution.id ? -1 : a.contribution.id > b.contribution.id ? 1 : 0);
  }
  return families;
}

export function directlyAttributed(entry: CostBaseEntry, dimension: FinanceCostAllocationDimension): string | null {
  return dimension === "period" ? entry.fact.occurredAt.toISOString().slice(0, 7)
    : dimension === "order" ? entry.fact.orderId : dimension === "order_line" ? entry.fact.orderLineId
      : dimension === "sku" ? entry.fact.skuId : entry.fact.listingId;
}

export async function readCostAllocationSources(tx: TenantTransaction, context: TenantContext,
  input: AllocationPageQuery & { baseRunId: string; dimension: FinanceCostAllocationDimension }) {
  const base = await readCostAllocationBase(tx, input.baseRunId, false), families = await readCostSourceFamilies(tx, base);
  const items: FinanceCostSourceOption[] = [];
  for (const family of families.values()) {
    // A missing root contribution cannot be invented for the source selector.
    if (!family.root) continue;
    const root = family.root, reasons: FinanceCostSourceOption["blockingReasons"] = [];
    if (!isFinanceProfitVerified(base.view)) reasons.push("base_incomplete");
    if (base.view.diagnostics.coverage?.dimension !== "aggregate") reasons.push("base_not_aggregate");
    if (family.entries.some(entry => entry.contribution.bucket !== "cost")) reasons.push("not_cost");
    if (input.dimension !== "period" && family.entries.some(entry => directlyAttributed(entry, input.dimension))) reasons.push("already_attributed");
    if (!family.complete) reasons.push("correction_chain_changed");
    if (!root.fact.sourceEntryId || !root.statement.sourceIdentity || root.contribution.reportingAmountMinor === null) reasons.push("source_unavailable");
    items.push({ rootFactId: family.rootFactId, rootContributionId: root.contribution.id, statementId: root.statement.id,
      statementChecksum: root.statement.checksum, factType: root.fact.factType,
      label: `${root.fact.factType} ${root.fact.sourceEntryId ?? root.fact.id}`, sourceCurrency: root.fact.currency,
      sourceAmountMinor: root.fact.amountMinor, reportingCurrency: base.view.reportingCurrency,
      reportingAmountMinor: root.contribution.reportingAmountMinor, contributionIds: family.entries.map(entry => entry.contribution.id),
      sourceChainChecksum: family.sourceChainChecksum, blockingReasons: reasons });
  }
  const scope = cursorScope(context, "sources", input), cursor = decodeCursor(input.cursor, scope, false);
  return FinanceCostAllocationSourcePageSchema.parse(memoryPage(items, item => item.rootFactId, input, scope, cursor));
}

export async function readCostAllocationTargets(tx: TenantTransaction, context: TenantContext,
  input: AllocationPageQuery & { dimension: FinanceCostAllocationDimension; key?: string }) {
  const scope = cursorScope(context, "targets", input), cursor = decodeCursor(input.cursor, scope, input.dimension === "period");
  if (cursor) for (const key of new Set([cursor.upperKey, cursor.key])) {
    if (input.key && key !== input.key || !(await costAllocationTargetKeys(tx, context.tenantId, input.dimension, { limit: 1, key })).length) invalidCursor();
  }
  const keys = await costAllocationTargetKeys(tx, context.tenantId, input.dimension,
    { limit: input.limit + 1, key: input.key, upper: cursor?.upperKey, before: cursor?.key });
  const selected = keys.slice(0, input.limit), targets = await resolveCostAllocationTargets(tx, context.tenantId, input.dimension, selected);
  const items = selected.map(key => { const item = targets.get(key); if (!item) sourceUnavailable(); return item; });
  return FinanceCostAllocationTargetPageSchema.parse(page(input, scope, cursor?.upperKey ?? keys[0] ?? null, items, item => item.key, keys.length > input.limit));
}

export async function readCostAllocationVersions(tx: TenantTransaction, context: TenantContext, input: ListQuery) {
  await requireListParents(tx, input);
  const filter = and(input.baseRunId ? eq(financeCostAllocationVersions.baseRunId, input.baseRunId) : undefined,
    input.allocationId ? eq(financeCostAllocationVersions.allocationId, input.allocationId) : undefined);
  const scope = cursorScope(context, "versions", input), cursor = decodeCursor(input.cursor, scope, false);
  if (cursor) for (const id of new Set([cursor.upperKey, cursor.key])) {
    const [row] = await tx.select({ id: financeCostAllocationVersions.id }).from(financeCostAllocationVersions)
      .where(and(filter, eq(financeCostAllocationVersions.id, id))).limit(1);
    if (!row) invalidCursor();
  }
  const rows = await tx.select().from(financeCostAllocationVersions).where(and(filter,
    cursor ? lte(financeCostAllocationVersions.id, cursor.upperKey) : undefined,
    cursor ? lt(financeCostAllocationVersions.id, cursor.key) : undefined))
    .orderBy(desc(financeCostAllocationVersions.id)).limit(input.limit + 1);
  const items = rows.slice(0, input.limit).map(row => ({ id: row.id, allocationId: row.allocationId, versionNumber: row.versionNumber,
    baseRunId: row.baseRunId, dimension: row.dimension, reportingCurrency: row.preview.reportingCurrency, sourceCount: row.preview.sources.length,
    checksum: row.checksum, createdAt: row.createdAt.toISOString() }));
  return FinanceCostAllocationVersionPageSchema.parse(page(input, scope, cursor?.upperKey ?? rows[0]?.id ?? null, items, item => item.id, rows.length > input.limit));
}

export async function readCostAllocationVersion(tx: TenantTransaction, id: string): Promise<FinanceCostAllocationVersion> {
  const [row] = await tx.select().from(financeCostAllocationVersions).where(eq(financeCostAllocationVersions.id, id)).limit(1);
  if (!row) allocationMissing();
  return costAllocationVersionView(tx, row);
}

export async function costAllocationVersionView(tx: TenantTransaction, row: CostVersionRow): Promise<FinanceCostAllocationVersion> {
  if (row.checksum !== costAllocationHash(financeCostVersionChecksumIdentity(row))) sourceUnavailable();
  return FinanceCostAllocationVersionViewSchema.parse({ id: row.id, allocationId: row.allocationId, versionNumber: row.versionNumber,
    previousVersionId: row.previousVersionId, status: "approved", preview: row.preview, checksum: row.checksum,
    reviewedBy: row.reviewedBy, createdAt: row.createdAt.toISOString(), basisProblems: await costAllocationBasisProblems(tx, row.baseRunId, [row]) });
}

export async function readAllocatedProfitRuns(tx: TenantTransaction, context: TenantContext, input: ListQuery) {
  await requireListParents(tx, input);
  const filter = and(input.baseRunId ? eq(financeAllocatedProfitRuns.baseRunId, input.baseRunId) : undefined,
    input.allocationId ? sql`${financeAllocatedProfitRuns.versionPins} @> ${JSON.stringify([{ allocationId: input.allocationId }])}::jsonb` : undefined);
  const scope = cursorScope(context, "runs", input), cursor = decodeCursor(input.cursor, scope, false);
  if (cursor) for (const id of new Set([cursor.upperKey, cursor.key])) {
    const [row] = await tx.select({ id: financeAllocatedProfitRuns.id }).from(financeAllocatedProfitRuns).where(and(filter, eq(financeAllocatedProfitRuns.id, id))).limit(1);
    if (!row) invalidCursor();
  }
  const rows = await tx.select().from(financeAllocatedProfitRuns).where(and(filter,
    cursor ? lte(financeAllocatedProfitRuns.id, cursor.upperKey) : undefined, cursor ? lt(financeAllocatedProfitRuns.id, cursor.key) : undefined))
    .orderBy(desc(financeAllocatedProfitRuns.id)).limit(input.limit + 1);
  const items: FinanceAllocatedProfitRun[] = [], cache: BasisCache = new Map();
  for (const row of rows.slice(0, input.limit)) items.push(await allocatedProfitRunView(tx, row, cache));
  return FinanceAllocatedProfitRunPageSchema.parse(page(input, scope, cursor?.upperKey ?? rows[0]?.id ?? null, items, item => item.id, rows.length > input.limit));
}

export async function readAllocatedProfitRun(tx: TenantTransaction, id: string | AllocatedRunRow): Promise<FinanceAllocatedProfitRun> {
  if (typeof id !== "string") return allocatedProfitRunView(tx, id);
  const [row] = await tx.select().from(financeAllocatedProfitRuns).where(eq(financeAllocatedProfitRuns.id, id)).limit(1);
  if (!row) allocationMissing();
  return allocatedProfitRunView(tx, row);
}

export async function allocatedProfitRunView(tx: TenantTransaction, row: AllocatedRunRow, cache?: BasisCache): Promise<FinanceAllocatedProfitRun> {
  const ids = row.versionPins.map(pin => pin.id);
  const versions = ids.length ? await tx.select().from(financeCostAllocationVersions).where(inArray(financeCostAllocationVersions.id, ids)) : [];
  if (versions.length !== ids.length || row.versionPins.some(pin => !versions.some(version => version.id === pin.id && version.checksum === pin.checksum
    && version.allocationId === pin.allocationId && version.versionNumber === pin.versionNumber))) sourceUnavailable();
  const targets = await tx.select({ target: financeAllocatedProfitSlices.target }).from(financeAllocatedProfitSlices).where(eq(financeAllocatedProfitSlices.runId, row.id));
  return FinanceAllocatedProfitRunViewSchema.parse({ id: row.id, baseRunId: row.baseRunId, baseInputChecksum: row.baseInputChecksum,
    dimension: row.dimension, versionPins: row.versionPins, algorithm: row.algorithm, reportingCurrency: row.reportingCurrency,
    status: row.status, revenueMinor: row.revenueMinor, costMinor: row.costMinor, profitMinor: row.profitMinor, marginBps: row.marginBps,
    diagnostics: row.diagnostics, breakdowns: row.breakdowns, inputChecksum: row.inputChecksum, createdAt: row.createdAt.toISOString(),
    basisProblems: await costAllocationBasisProblems(tx, row.baseRunId, versions, targets.flatMap(item => item.target ? [item.target] : []), cache) });
}

export async function readAllocatedProfitSlices(tx: TenantTransaction, context: TenantContext, runId: string, input: AllocationPageQuery) {
  const [run] = await tx.select({ id: financeAllocatedProfitRuns.id }).from(financeAllocatedProfitRuns).where(eq(financeAllocatedProfitRuns.id, runId)).limit(1);
  if (!run) allocationMissing();
  const scope = cursorScope(context, "slices", { ...input, runId }), cursor = decodeCursor(input.cursor, scope, false);
  if (cursor) for (const id of new Set([cursor.upperKey, cursor.key])) {
    const [anchor] = await tx.select({ id: financeAllocatedProfitSlices.id }).from(financeAllocatedProfitSlices)
      .where(and(eq(financeAllocatedProfitSlices.runId, runId), eq(financeAllocatedProfitSlices.id, id))).limit(1);
    if (!anchor) invalidCursor();
  }
  const rows = await tx.select().from(financeAllocatedProfitSlices).where(and(eq(financeAllocatedProfitSlices.runId, runId),
    cursor ? lte(financeAllocatedProfitSlices.id, cursor.upperKey) : undefined, cursor ? lt(financeAllocatedProfitSlices.id, cursor.key) : undefined))
    .orderBy(desc(financeAllocatedProfitSlices.id)).limit(input.limit + 1);
  const items = rows.slice(0, input.limit).map(allocatedProfitSliceView);
  return FinanceAllocatedProfitSlicePageSchema.parse(page(input, scope, cursor?.upperKey ?? rows[0]?.id ?? null, items, item => item.id, rows.length > input.limit));
}

export function allocatedProfitSliceView(row: AllocatedSliceRow) {
  const { tenantId: ignored, ...value } = row; void ignored;
  return FinanceAllocatedProfitSliceSchema.parse({ ...value, createdAt: row.createdAt.toISOString() });
}

export async function costAllocationBasisProblems(tx: TenantTransaction, baseRunId: string, versions: CostVersionRow[], extraTargets: FinanceCostAllocationTarget[] = [], cache?: BasisCache) {
  const problems = new Set<FinanceCostAllocationVersion["basisProblems"][number]>();
  try {
    let pending = cache?.get(baseRunId);
    if (!pending) {
      pending = (async () => { const base = await readCostAllocationBase(tx, baseRunId, false); return { base, families: await readCostSourceFamilies(tx, base) }; })();
      cache?.set(baseRunId, pending);
    }
    const { base, families } = await pending;
    if (!isFinanceProfitVerified(base.view) || base.view.diagnostics.coverage?.dimension !== "aggregate") problems.add("base_unavailable");
    if ([...families.values()].some(family => !family.complete)) problems.add("source_changed");
    for (const version of versions) {
      if (version.baseInputChecksum !== base.row.inputChecksum) problems.add("base_unavailable");
      if (version.preview.sources.some(source => families.get(source.rootFactId)?.sourceChainChecksum !== source.sourceChainChecksum)) problems.add("source_changed");
    }
  } catch (error) {
    if (!(error instanceof NotFoundException) && !(error instanceof ConflictException)) throw error;
    problems.add("base_unavailable");
  }
  const targets = [...extraTargets, ...versions.flatMap(version => version.preview.sources.flatMap(source => source.shares.map(share => share.target)))];
  const groups = new Map<FinanceCostAllocationDimension, FinanceCostAllocationTarget[]>();
  for (const target of targets) { const group = groups.get(target.dimension) ?? []; group.push(target); groups.set(target.dimension, group); }
  for (const [dimension, pinned] of groups) {
    try {
      const current = await resolveCostAllocationTargets(tx, versions[0]?.tenantId ?? (await tenantForBase(tx, baseRunId)), dimension, pinned.map(target => target.key));
      if (pinned.some(target => current.get(target.key)?.basisChecksum !== target.basisChecksum)) problems.add("target_changed");
    } catch (error) {
      if (!(error instanceof NotFoundException) && !(error instanceof ConflictException)) throw error;
      problems.add("target_changed");
    }
  }
  if (versions.length) {
    const latest = await tx.select({ allocationId: financeCostAllocationVersions.allocationId, version: max(financeCostAllocationVersions.versionNumber) })
      .from(financeCostAllocationVersions).where(inArray(financeCostAllocationVersions.allocationId, [...new Set(versions.map(version => version.allocationId))]))
      .groupBy(financeCostAllocationVersions.allocationId);
    const byRoot = new Map(latest.map(row => [row.allocationId, row.version]));
    if (versions.some(version => (byRoot.get(version.allocationId) ?? 0) > version.versionNumber)) problems.add("rule_superseded");
  }
  return [...problems].sort();
}

async function tenantForBase(tx: TenantTransaction, id: string) {
  const [row] = await tx.select({ tenantId: financeProfitRuns.tenantId }).from(financeProfitRuns).where(eq(financeProfitRuns.id, id)).limit(1);
  if (!row) allocationMissing(); return row.tenantId;
}

async function requireListParents(tx: TenantTransaction, input: ListQuery) {
  if (input.baseRunId) {
    const [row] = await tx.select({ id: financeProfitRuns.id }).from(financeProfitRuns).where(eq(financeProfitRuns.id, input.baseRunId)).limit(1);
    if (!row) allocationMissing();
  }
  if (input.allocationId) {
    const [row] = await tx.select({ id: financeCostAllocationVersions.id }).from(financeCostAllocationVersions).where(eq(financeCostAllocationVersions.allocationId, input.allocationId)).limit(1);
    if (!row) allocationMissing();
  }
}

function cursorScope<T extends AllocationPageQuery>(context: TenantContext, endpoint: string, input: T) {
  const { cursor: ignored, ...query } = input; void ignored;
  return costAllocationHash({ tenantId: context.tenantId.toLowerCase(), userId: context.userId.toLowerCase(), endpoint, query });
}

function decodeCursor(raw: string | undefined, scope: string, period: boolean): Cursor | null {
  if (raw === undefined) return null;
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) invalidCursor();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) invalidCursor();
    const item = value as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "key,scope,upperKey,v" || item.v !== 1 || item.scope !== scope
      || typeof item.upperKey !== "string" || typeof item.key !== "string" || item.key > item.upperKey) invalidCursor();
    for (const key of [item.key, item.upperKey]) {
      if (period ? normalizeTargetKey("period", key) !== key : !EntityIdSchema.safeParse(key).success || key !== key.toLowerCase()) invalidCursor();
    }
    const cursor: Cursor = { v: 1, scope, upperKey: item.upperKey, key: item.key };
    if (text !== JSON.stringify(cursor)) invalidCursor();
    return cursor;
  } catch { invalidCursor(); }
}

function memoryPage<T>(rows: T[], keyOf: (item: T) => string, input: AllocationPageQuery, scope: string, cursor: Cursor | null) {
  const sorted = [...rows].sort((a, b) => keyOf(a) > keyOf(b) ? -1 : keyOf(a) < keyOf(b) ? 1 : 0);
  if (cursor && [cursor.key, cursor.upperKey].some(key => !sorted.some(item => keyOf(item) === key))) invalidCursor();
  const selected = cursor ? sorted.filter(item => keyOf(item) <= cursor.upperKey && keyOf(item) < cursor.key) : sorted;
  return page(input, scope, cursor?.upperKey ?? (sorted[0] ? keyOf(sorted[0]) : null), selected.slice(0, input.limit), keyOf, selected.length > input.limit);
}

function page<T>(input: AllocationPageQuery, scope: string, upperKey: string | null, items: T[], keyOf: (item: T) => string, hasMore: boolean) {
  return { items, hasMore, nextCursor: hasMore && upperKey ? Buffer.from(JSON.stringify({ v: 1, scope, upperKey, key: keyOf(items.at(-1)!) }), "utf8").toString("base64url") : null,
    upperBoundKey: upperKey, limit: input.limit, consistency: "live", order: "id_desc" };
}

function invalidCursor(): never {
  throw new BadRequestException({ code: "finance_cost_allocation_cursor_invalid", message: "费用分摊分页位置与当前查询不一致 请重新查询" });
}

export function sourceUnavailable(): never {
  allocationConflict("finance_cost_allocation_source_unavailable", "原财务事实或计算凭据不完整 无法确认费用分摊依据");
}

export function costAllocationParse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, raw: unknown): T {
  const result = schema.safeParse(raw); if (!result.success) allocationInputInvalid(); return result.data;
}
