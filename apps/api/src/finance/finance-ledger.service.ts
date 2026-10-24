import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, ForbiddenError, intersectPermissionContexts, Permission, permissionScope } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import {
  FinanceLedgerDetailInputSchema, FinanceLedgerDetailViewSchema, FinanceLedgerListInputSchema,
  FinanceLedgerPageViewSchema, FinanceLedgerSummarySchema,
  financeLedgerParentKinds,
  type FinanceLedgerDetailInput, type FinanceLedgerDetailView, type FinanceLedgerKind,
  type FinanceLedgerListInput, type FinanceLedgerPageView, type FinanceLedgerSummary,
} from "@yummyai/contracts/finance/ledger";
import {
  financeAllocationReleases, financeBillAdjustments, financeFacts, financeFxRates, financePayableBills,
  financePayablePayments, financePaymentAllocationBatches, financePaymentAllocations, financePaymentAdjustments,
  financeProfitContributions, financeProfitMetrics, financeProfitMetricVersions, financeProfitRuns, financeStatements,
  fulfillmentSuppliers, loadCurrentMembershipContext, withTenant, type DatabaseConnection, type TenantTransaction,
} from "@yummyai/database";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";

import { DATABASE_CONNECTION } from "../platform.tokens.js";
import {
  factView, fxRateView, metricVersionView, metricView, profitRunView, statementHeaderView,
} from "./finance.service.js";
import {
  allocationView, readBatchView, readBillView, readPaymentView, readProcurementAdjustmentOptions,
  releasedIds, releaseView,
} from "./finance-payables.service.js";
import {
  billAdjustmentView, paymentAdjustmentView, readBillStates, readPaymentBalances,
} from "./finance-payables-ledger.js";

type RegularKind = Exclude<FinanceLedgerKind, "procurement_adjustments">;
type Expression = AnyPgColumn | SQL;
type LedgerTable = AnyPgTable & { id: AnyPgColumn; tenantId: AnyPgColumn };
type Binding = {
  table: LedgerTable; recordedAt: AnyPgColumn; reference: Expression;
  parent?: AnyPgColumn; amount?: Expression; currency?: Expression; status?: Expression; supplier?: Expression; net?: Expression;
};
type Cursor = { v: 1; scope: string; upperId: string; id: string };
type RawSummary = { id: string; reference: string; recordedAt: string; currency: string | null;
  amountMinor: unknown; netAmountMinor: unknown; status: string | null; supplierId: string | null; parentId: string | null };

// Columns and expressions are fixed here. Request text never selects a table,
// column or SQL fragment. Number ordering deliberately uses original UUID IDs.
const bindings: Record<RegularKind, Binding> = {
  statements: { table: financeStatements, recordedAt: financeStatements.recordedAt, reference: financeStatements.externalStatementId,
    currency: financeStatements.sourceCurrency },
  facts: { table: financeFacts, recordedAt: financeFacts.recordedAt, reference: sql`coalesce(${financeFacts.externalReference},${financeFacts.lineKey})`,
    parent: financeFacts.statementId, amount: financeFacts.amountMinor, currency: financeFacts.currency,
    status: financeFacts.correctionKind, supplier: financeFacts.supplierId },
  fx_rates: { table: financeFxRates, recordedAt: financeFxRates.recordedAt,
    reference: sql`concat(${financeFxRates.source},' / ',${financeFxRates.baseCurrency},'/',${financeFxRates.quoteCurrency})`, currency: financeFxRates.quoteCurrency },
  metrics: { table: financeProfitMetrics, recordedAt: financeProfitMetrics.createdAt, reference: financeProfitMetrics.name, status: financeProfitMetrics.status },
  metric_versions: { table: financeProfitMetricVersions, recordedAt: financeProfitMetricVersions.createdAt,
    reference: sql`concat(${financeProfitMetricVersions.metricId}::text,' / v',${financeProfitMetricVersions.versionNumber}::text)`,
    parent: financeProfitMetricVersions.metricId, currency: financeProfitMetricVersions.reportingCurrency },
  profit_runs: { table: financeProfitRuns, recordedAt: financeProfitRuns.calculatedAt,
    reference: sql`concat(${financeProfitRuns.metricId}::text,' / v',(select ${financeProfitMetricVersions.versionNumber}::text
      from ${financeProfitMetricVersions} where ${financeProfitMetricVersions.tenantId}=${financeProfitRuns.tenantId}
        and ${financeProfitMetricVersions.id}=${financeProfitRuns.metricVersionId}))`,
    parent: financeProfitRuns.metricId, currency: financeProfitRuns.reportingCurrency },
  contributions: { table: financeProfitContributions, recordedAt: financeProfitContributions.createdAt, reference: financeProfitContributions.factId,
    parent: financeProfitContributions.runId, amount: financeProfitContributions.reportingAmountMinor,
    currency: financeProfitContributions.reportingCurrency, status: financeProfitContributions.bucket,
    supplier: sql`(select ${financeFacts.supplierId} from ${financeFacts} where ${financeFacts.tenantId}=${financeProfitContributions.tenantId}
      and ${financeFacts.id}=${financeProfitContributions.factId})` },
  bills: { table: financePayableBills, recordedAt: financePayableBills.recordedAt, reference: financePayableBills.externalBillId,
    parent: financePayableBills.supplierId, amount: financePayableBills.amountMinor, currency: financePayableBills.currency, supplier: financePayableBills.supplierId },
  payments: { table: financePayablePayments, recordedAt: financePayablePayments.recordedAt, reference: financePayablePayments.externalPaymentId,
    parent: financePayablePayments.supplierId, amount: financePayablePayments.amountMinor, currency: financePayablePayments.currency, supplier: financePayablePayments.supplierId },
  allocation_batches: { table: financePaymentAllocationBatches, recordedAt: financePaymentAllocationBatches.recordedAt, reference: financePaymentAllocationBatches.id,
    parent: financePaymentAllocationBatches.paymentId,
    amount: sql`(select sum(${financePaymentAllocations.amountMinor}::numeric) from ${financePaymentAllocations}
      where ${financePaymentAllocations.tenantId}=${financePaymentAllocationBatches.tenantId} and ${financePaymentAllocations.batchId}=${financePaymentAllocationBatches.id})`,
    currency: sql`(select ${financePayablePayments.currency} from ${financePayablePayments}
      where ${financePayablePayments.tenantId}=${financePaymentAllocationBatches.tenantId} and ${financePayablePayments.id}=${financePaymentAllocationBatches.paymentId})`,
    supplier: sql`(select ${financePayablePayments.supplierId} from ${financePayablePayments}
      where ${financePayablePayments.tenantId}=${financePaymentAllocationBatches.tenantId} and ${financePayablePayments.id}=${financePaymentAllocationBatches.paymentId})` },
  allocations: { table: financePaymentAllocations, recordedAt: financePaymentAllocations.recordedAt, reference: financePaymentAllocations.batchId,
    parent: financePaymentAllocations.billId, amount: financePaymentAllocations.amountMinor,
    currency: financePaymentAllocations.currency, supplier: financePaymentAllocations.supplierId },
  releases: { table: financeAllocationReleases, recordedAt: financeAllocationReleases.recordedAt, reference: financeAllocationReleases.allocationId,
    parent: financeAllocationReleases.allocationId, status: sql`'released'`,
    amount: sql`(select ${financePaymentAllocations.amountMinor} from ${financePaymentAllocations}
      where ${financePaymentAllocations.tenantId}=${financeAllocationReleases.tenantId} and ${financePaymentAllocations.id}=${financeAllocationReleases.allocationId})`,
    currency: sql`(select ${financePaymentAllocations.currency} from ${financePaymentAllocations}
      where ${financePaymentAllocations.tenantId}=${financeAllocationReleases.tenantId} and ${financePaymentAllocations.id}=${financeAllocationReleases.allocationId})`,
    supplier: sql`(select ${financePaymentAllocations.supplierId} from ${financePaymentAllocations}
      where ${financePaymentAllocations.tenantId}=${financeAllocationReleases.tenantId} and ${financePaymentAllocations.id}=${financeAllocationReleases.allocationId})` },
  bill_adjustments: { table: financeBillAdjustments, recordedAt: financeBillAdjustments.recordedAt,
    reference: sql`coalesce(${financeBillAdjustments.externalDocumentId},${financeBillAdjustments.billId}::text)`, parent: financeBillAdjustments.billId,
    amount: financeBillAdjustments.amountMinor, currency: financeBillAdjustments.currency, supplier: financeBillAdjustments.supplierId,
    net: sql`(${financeBillAdjustments.balanceAfter}->>'netAmountMinor')::numeric`, status: sql`${financeBillAdjustments.balanceAfter}->>'lifecycle'` },
  payment_adjustments: { table: financePaymentAdjustments, recordedAt: financePaymentAdjustments.recordedAt,
    reference: sql`coalesce(${financePaymentAdjustments.externalDocumentId},${financePaymentAdjustments.paymentId}::text)`, parent: financePaymentAdjustments.paymentId,
    amount: financePaymentAdjustments.amountMinor, currency: financePaymentAdjustments.currency, supplier: financePaymentAdjustments.supplierId,
    net: sql`(${financePaymentAdjustments.balanceAfter}->>'netAmountMinor')::numeric`, status: sql`${financePaymentAdjustments.balanceAfter}->>'lifecycle'` },
};

const parentTables: Partial<Record<FinanceLedgerKind | "suppliers", LedgerTable>> = {
  statements: financeStatements, metrics: financeProfitMetrics, profit_runs: financeProfitRuns,
  suppliers: fulfillmentSuppliers, payments: financePayablePayments, bills: financePayableBills, allocations: financePaymentAllocations,
};

@Injectable()
export class FinanceLedgerService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}

  async list(context: TenantContext, raw: unknown): Promise<FinanceLedgerPageView> {
    const input = parse(FinanceLedgerListInputSchema, raw);
    return withTenant(this.database.db, context, async tx => {
      const current = await currentAuthority(tx, context);
      await requireParent(tx, current, input);
      const scope = cursorScope(current, input);
      const cursor = input.cursor ? decodeCursor(input.cursor, scope) : null;
      if (cursor) await requireCursorAnchors(tx, current, input, cursor);
      if (input.kind === "procurement_adjustments") return procurementPage(tx, current, input, scope, cursor);
      const binding = bindings[input.kind], where = queryWhere(binding, current, input.parentId);
      const rows = await tx.execute<RawSummary>(sql`select ${binding.table.id} as id,${binding.reference}::text as reference,
        to_char(${binding.recordedAt} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "recordedAt",
        ${binding.currency ?? sql`null`} as currency,${binding.amount ?? sql`null`} as "amountMinor",
        ${binding.net ?? sql`null`} as "netAmountMinor",${binding.status ?? sql`null`} as status,
        ${binding.supplier ?? sql`null`} as "supplierId",${binding.parent ?? sql`null`} as "parentId"
        from ${binding.table} where ${where}
        ${cursor ? sql`and ${binding.table.id}<=${cursor.upperId}::uuid and ${binding.table.id}<${cursor.id}::uuid` : sql``}
        order by ${binding.table.id} desc limit ${input.limit + 1}`);
      const page = rows.slice(0, input.limit), upperId = cursor?.upperId ?? page[0]?.id ?? null;
      const items = page.map(row => FinanceLedgerSummarySchema.parse({ ...row, kind: input.kind,
        amountMinor: summaryMoney(row.amountMinor), netAmountMinor: summaryMoney(row.netAmountMinor) }));
      await enrichCurrentBalances(tx, current, input.kind, items);
      return pageView(input, scope, upperId, items, rows.length > input.limit);
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
  }

  async detail(context: TenantContext, raw: unknown): Promise<FinanceLedgerDetailView> {
    const input = parse(FinanceLedgerDetailInputSchema, raw);
    return withTenant(this.database.db, context, async tx => {
      const current = await currentAuthority(tx, context);
      await requireParent(tx, current, input);
      if (!await anchorExists(tx, current, input.kind, input.id, input.parentId)) missing();
      return readDetail(tx, input);
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
  }
}

async function currentAuthority(tx: TenantTransaction, base: TenantContext) {
  const current = intersectPermissionContexts(base, await loadCurrentMembershipContext(tx, base, { lock: true }));
  authorize(current, Permission.FinanceRead);
  if (permissionScope(current, Permission.FinanceRead) !== "tenant") throw new ForbiddenError(Permission.FinanceRead, "outside_data_scope");
  return current;
}

function queryWhere(binding: Binding, current: TenantContext, parentId?: string) {
  if (parentId && !binding.parent) invalidInput();
  return sql`${binding.table.tenantId}=${current.tenantId}::uuid${parentId ? sql` and ${binding.parent!}=${parentId}::uuid` : sql``}`;
}

function cursorScope(current: TenantContext, input: FinanceLedgerListInput) {
  return createHash("sha256").update(canonicalJson({ tenantId: current.tenantId.toLowerCase(), userId: current.userId.toLowerCase(),
    kind: input.kind, parentId: input.parentId ?? null, limit: input.limit })).digest("hex");
}

function encodeCursor(cursor: Cursor) { return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url"); }

function decodeCursor(raw: string, scope: string): Cursor {
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) invalidCursor();
    const original = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(original);
    if (!value || typeof value !== "object" || Array.isArray(value)) invalidCursor();
    const object = value as Record<string, unknown>;
    if (Object.keys(object).sort().join(",") !== "id,scope,upperId,v" || object.v !== 1 || object.scope !== scope
      || typeof object.scope !== "string" || !/^[a-f0-9]{64}$/.test(object.scope)
      || !lowerId(object.id) || !lowerId(object.upperId) || object.id > object.upperId) invalidCursor();
    const cursor: Cursor = { v: 1, scope, upperId: object.upperId, id: object.id };
    if (original !== JSON.stringify(cursor)) invalidCursor();
    return cursor;
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    invalidCursor();
  }
}

function lowerId(value: unknown): value is string {
  return typeof value === "string" && value === value.toLowerCase() && EntityIdSchema.safeParse(value).success;
}

async function requireParent(tx: TenantTransaction, current: TenantContext, input: { kind: FinanceLedgerKind; parentId?: string }) {
  if (!input.parentId) return;
  const kind = financeLedgerParentKinds[input.kind], table = kind ? parentTables[kind] : undefined;
  if (!table) invalidInput();
  const rows = await tx.execute<{ id: string }>(sql`select ${table.id} as id from ${table}
    where ${table.tenantId}=${current.tenantId}::uuid and ${table.id}=${input.parentId}::uuid limit 1`);
  if (!rows.length) missing();
}

async function requireCursorAnchors(tx: TenantTransaction, current: TenantContext, input: FinanceLedgerListInput, cursor: Cursor) {
  for (const id of new Set([cursor.upperId, cursor.id]))
    if (!await anchorExists(tx, current, input.kind, id, input.parentId)) invalidCursor();
}

async function anchorExists(tx: TenantTransaction, current: TenantContext, kind: FinanceLedgerKind, id: string, parentId?: string) {
  if (kind === "procurement_adjustments") {
    if (!parentId) invalidInput();
    return (await readProcurementAdjustmentOptions(tx, [parentId], { limit: 1, id })).sources.some(row => row.id === id);
  }
  const binding = bindings[kind];
  const rows = await tx.execute<{ id: string }>(sql`select ${binding.table.id} as id from ${binding.table}
    where ${queryWhere(binding, current, parentId)} and ${binding.table.id}=${id}::uuid limit 1`);
  return rows.length === 1;
}

function pageView(input: FinanceLedgerListInput, scope: string, upperId: string | null, items: FinanceLedgerSummary[], hasMore: boolean) {
  return FinanceLedgerPageViewSchema.parse({ kind: input.kind, parentId: input.parentId ?? null, limit: input.limit,
    order: "id_desc", consistency: "live", upperBoundId: upperId, items, hasMore,
    nextCursor: hasMore && upperId ? encodeCursor({ v: 1, scope, upperId, id: items.at(-1)!.id }) : null });
}

async function procurementPage(tx: TenantTransaction, current: TenantContext, input: FinanceLedgerListInput, scope: string, cursor: Cursor | null) {
  if (!input.parentId) invalidInput();
  const page = await readProcurementAdjustmentOptions(tx, [input.parentId], {
    limit: input.limit, beforeId: cursor?.id, upperId: cursor?.upperId,
  });
  const [bill] = await tx.select({ currency: financePayableBills.currency, supplierId: financePayableBills.supplierId })
    .from(financePayableBills).where(and(eq(financePayableBills.tenantId, current.tenantId), eq(financePayableBills.id, input.parentId))).limit(1);
  const options = new Map(page.options.map(row => [row.procurementAdjustmentId, row]));
  const diagnostics = new Map(page.diagnostics.map(row => [row.procurementAdjustmentId, row]));
  const items = page.sources.map(source => {
    const option = options.get(source.id), diagnostic = diagnostics.get(source.id);
    if (!option && !diagnostic) inconsistent();
    return FinanceLedgerSummarySchema.parse({ id: source.id, kind: input.kind, reference: option?.externalDocumentId ?? source.id,
      recordedAt: source.recordedAt, currency: option ? bill?.currency ?? null : null, amountMinor: option?.amountMinor ?? null,
      netAmountMinor: null, status: diagnostic?.code ?? (option!.mappedEventId ? "synced" : "approved"),
      supplierId: bill?.supplierId ?? null, parentId: source.billId });
  });
  return pageView(input, scope, cursor?.upperId ?? items[0]?.id ?? null, items, page.truncated);
}

async function enrichCurrentBalances(tx: TenantTransaction, current: TenantContext, kind: FinanceLedgerKind, items: FinanceLedgerSummary[]) {
  const ids = items.map(row => row.id);
  if (kind === "bills") {
    const states = await readBillStates(tx, current.tenantId, ids);
    for (const item of items) {
      const state = states.get(item.id); if (!state) inconsistent();
      item.netAmountMinor = state.balance.netAmountMinor;
      item.status = state.sourceStatus === "current" ? state.balance.lifecycle : state.sourceStatus;
    }
  } else if (kind === "payments") {
    const states = await readPaymentBalances(tx, current.tenantId, ids);
    for (const item of items) {
      const state = states.get(item.id); if (!state) inconsistent();
      item.netAmountMinor = state.netAmountMinor; item.status = state.lifecycle;
    }
  } else if (kind === "allocations") {
    const released = await releasedIds(tx, ids);
    for (const item of items) item.status = released.has(item.id) ? "released" : "active";
  }
}

async function readDetail(tx: TenantTransaction, input: FinanceLedgerDetailInput): Promise<FinanceLedgerDetailView> {
  const id = input.id;
  switch (input.kind) {
    case "statements": {
      const [row] = await tx.select().from(financeStatements).where(eq(financeStatements.id, id)).limit(1);
      if (!row) missing();
      return detailView(input, statementHeaderView(row), ["facts"]);
    }
    case "facts": {
      const [row] = await tx.select().from(financeFacts).where(eq(financeFacts.id, id)).limit(1);
      if (!row) missing(); return detailView(input, factView(row));
    }
    case "fx_rates": {
      const [row] = await tx.select().from(financeFxRates).where(eq(financeFxRates.id, id)).limit(1);
      if (!row) missing(); return detailView(input, fxRateView(row));
    }
    case "metrics": {
      const [row] = await tx.select().from(financeProfitMetrics).where(eq(financeProfitMetrics.id, id)).limit(1);
      if (!row) missing(); return detailView(input, await metricView(tx, row), ["metric_versions", "profit_runs"]);
    }
    case "metric_versions": {
      const [row] = await tx.select().from(financeProfitMetricVersions).where(eq(financeProfitMetricVersions.id, id)).limit(1);
      if (!row) missing(); return detailView(input, metricVersionView(row));
    }
    case "profit_runs": {
      const [row] = await tx.select().from(financeProfitRuns).where(eq(financeProfitRuns.id, id)).limit(1);
      if (!row) missing();
      const original = await profitRunView(tx, row);
      const { contributions: originalContributions, ...header } = original;
      // Validation above intentionally consumes the complete original evidence.
      // Only the response projection omits its separately paged contributions.
      if (!Array.isArray(originalContributions)) inconsistent();
      return detailView(input, header, ["contributions"]);
    }
    case "contributions": {
      const [row] = await tx.select().from(financeProfitContributions).where(eq(financeProfitContributions.id, id)).limit(1);
      if (!row) missing();
      const [run] = await tx.select().from(financeProfitRuns).where(eq(financeProfitRuns.id, row.runId)).limit(1);
      if (!run) inconsistent();
      const original = await profitRunView(tx, run), contribution = original.contributions.find(entry => entry.id === row.id);
      if (!contribution) inconsistent();
      return detailView(input, { ...contribution, runId: run.id });
    }
    case "bills": {
      const [row] = await tx.select().from(financePayableBills).where(eq(financePayableBills.id, id)).limit(1);
      if (!row) missing();
      return detailView(input, await readBillView(tx, row), row.procurementInvoiceId === null
        ? ["allocations", "bill_adjustments"] : ["allocations", "bill_adjustments", "procurement_adjustments"]);
    }
    case "payments": {
      const [row] = await tx.select().from(financePayablePayments).where(eq(financePayablePayments.id, id)).limit(1);
      if (!row) missing(); return detailView(input, await readPaymentView(tx, row), ["allocation_batches", "payment_adjustments"]);
    }
    case "allocation_batches": {
      const [row] = await tx.select().from(financePaymentAllocationBatches).where(eq(financePaymentAllocationBatches.id, id)).limit(1);
      if (!row) missing(); return detailView(input, await readBatchView(tx, row));
    }
    case "allocations": {
      const [row] = await tx.select().from(financePaymentAllocations).where(eq(financePaymentAllocations.id, id)).limit(1);
      if (!row) missing(); return detailView(input, allocationView(row, (await releasedIds(tx, [id])).has(id)), ["releases"]);
    }
    case "releases": {
      const [row] = await tx.select().from(financeAllocationReleases).where(eq(financeAllocationReleases.id, id)).limit(1);
      if (!row) missing(); return detailView(input, releaseView(row));
    }
    case "bill_adjustments": {
      const [row] = await tx.select().from(financeBillAdjustments).where(eq(financeBillAdjustments.id, id)).limit(1);
      if (!row) missing(); return detailView(input, billAdjustmentView(row));
    }
    case "payment_adjustments": {
      const [row] = await tx.select().from(financePaymentAdjustments).where(eq(financePaymentAdjustments.id, id)).limit(1);
      if (!row) missing(); return detailView(input, paymentAdjustmentView(row));
    }
    case "procurement_adjustments": {
      if (!input.parentId) invalidInput();
      const result = await readProcurementAdjustmentOptions(tx, [input.parentId], { limit: 1, id });
      const record = result.options.find(row => row.procurementAdjustmentId === id)
        ?? result.diagnostics.find(row => row.procurementAdjustmentId === id);
      if (!record) missing();
      const [bill] = await tx.select({ currency: financePayableBills.currency }).from(financePayableBills)
        .where(eq(financePayableBills.id, input.parentId)).limit(1);
      if (!bill) missing();
      return FinanceLedgerDetailViewSchema.parse({ kind: input.kind, id, record, billCurrency: bill.currency, children: [] });
    }
  }
}

function detailView(input: FinanceLedgerDetailInput, record: unknown, children: FinanceLedgerKind[] = []) {
  return FinanceLedgerDetailViewSchema.parse({ kind: input.kind, id: input.id, record,
    children: children.map(kind => ({ kind, parentId: input.id })) });
}

function summaryMoney(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "bigint" && (typeof value !== "string" || !/^-?[0-9]+(?:\.0+)?$/.test(value))) inconsistent();
  // PostgreSQL numeric can retain a zero fractional scale for an integer.
  const exact = typeof value === "bigint" ? value : BigInt(value.replace(/\.0+$/, ""));
  if (exact < -BigInt(Number.MAX_SAFE_INTEGER) || exact > BigInt(Number.MAX_SAFE_INTEGER)) inconsistent();
  return Number(exact);
}

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) invalidInput();
  return parsed.data;
}
function invalidInput(): never { throw new BadRequestException({ code: "finance_ledger_input_invalid", message: "财务台账查询格式不正确" }); }
function invalidCursor(): never { throw new BadRequestException({ code: "finance_ledger_cursor_invalid", message: "分页位置无效或与当前查询不一致 请重新查询" }); }
function missing(): never { throw new NotFoundException({ code: "finance_ledger_record_not_found", message: "财务台账记录不存在" }); }
function inconsistent(): never { throw new ConflictException({ code: "finance_ledger_evidence_unavailable", message: "台账原始依据不完整或无法精确读取 请核对原记录" }); }
