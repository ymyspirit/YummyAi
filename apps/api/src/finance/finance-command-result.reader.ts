import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Injectable, NotFoundException, PayloadTooLargeException } from "@nestjs/common";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { catalogContextAuthority } from "@yummyai/catalog-core";
import type { TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { isFinanceProfitVerified, FinanceProfitContributionViewSchema } from "@yummyai/contracts/finance";
import { FinanceCommandResultSchema, type FinanceCommandResult } from "@yummyai/contracts/finance/finance-command";
import {
  FINANCE_COMMAND_RESULT_MAX_RESPONSE_BYTES, FINANCE_COMMAND_RESULT_PAGE_MAX_RESPONSE_BYTES,
  FinanceCommandRecordedResultSchema, FinanceCommandResultCursorSchema, FinanceCommandResultPageQuerySchema,
  FinanceCommandResultPageSchema, FinanceCommandResultAllocationSchema, FinanceCommandResultSourceSchema, FinanceCommandResultShareSchema,
  financeCommandResultSections, type FinanceCommandRecordedResult, type FinanceCommandResultPage,
  type FinanceCommandResultPageQuery, type FinanceCommandResultSection,
} from "@yummyai/contracts/finance/finance-command-result";
import {
  financeCommands, financeOriginalWriteProofs, financeStatements, financeFacts, financeFxRates,
  financeProfitMetricVersions, financeProfitRuns, financeProfitContributions, financePayableBills, financePayablePayments,
  financePaymentAllocationBatches, financePaymentAllocations, financeAllocationReleases, financeBillAdjustments,
  financePaymentAdjustments, financeCostAllocationVersions, financeAllocatedProfitRuns, financeAllocatedProfitSlices,
  type TenantTransaction,
} from "@yummyai/database";
import { and, asc, desc, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { z } from "zod";
import {
  currentFinanceAuthority, factView, fxRateView, metricVersionView, profitRunView, statementHeaderView,
} from "./finance.service.js";
import { financeCommandPermission } from "./finance-command-lock.js";
import { allocationView, releaseView } from "./finance-payables.service.js";
import { billAdjustmentView, paymentAdjustmentView } from "./finance-payables-ledger.js";
import { allocatedProfitRunView, allocatedProfitSliceView, costAllocationVersionView } from "./finance-cost-allocation.read.js";

type Command = Pick<typeof financeCommands.$inferSelect, "id" | "tenantId" | "createdBy" | "kind" | "targetId" |
  "requestKey" | "ownerInputChecksum" | "status" | "resultId" | "completedAt">;
type Access = { command: Command; current: TenantContext; result: FinanceCommandResult };
type Recorded = FinanceCommandRecordedResult["recorded"];
type Verification = NonNullable<FinanceCommandRecordedResult["currentVerification"]>;
type Entry = { anchor: string; value: unknown };
type Collection = { total: number; entries(offset: number, limit: number): Promise<Entry[]> };
const Id = EntityIdSchema.transform(value => value.toLowerCase());
const resultTables = {
  statement_record: financeStatements, fx_rate_record: financeFxRates, metric_upsert: financeProfitMetricVersions,
  profit_calculate: financeProfitRuns, bill_record: financePayableBills, payment_record: financePayablePayments,
  payment_allocate: financePaymentAllocationBatches, allocation_release: financeAllocationReleases,
  bill_adjustment_record: financeBillAdjustments, payment_adjustment_record: financePaymentAdjustments,
  cost_version_approve: financeCostAllocationVersions, allocated_profit_calculate: financeAllocatedProfitRuns,
} as const;
const statementHeaderColumns = {
  id: financeStatements.id, accountId: financeStatements.accountId, provider: financeStatements.provider,
  sourceIdentity: financeStatements.sourceIdentity, statementKind: financeStatements.statementKind,
  externalStatementId: financeStatements.externalStatementId, periodStart: financeStatements.periodStart,
  periodEnd: financeStatements.periodEnd, sourceCurrency: financeStatements.sourceCurrency,
  observedAt: financeStatements.observedAt, recordedAt: financeStatements.recordedAt, checksum: financeStatements.checksum,
};

/** A reader of one actor's actual execution. It never loads the private command
 * input or routes a narrow operation permission through the general ledger. */
@Injectable()
export class FinanceCommandResultReader {
  async read(tx: TenantTransaction, context: TenantContext, commandId: string): Promise<FinanceCommandRecordedResult> {
    const access = await authorizeResult(tx, context, commandId);
    const { recorded, currentVerification } = await readRecorded(tx, access);
    const collections = [];
    for (const section of financeCommandResultSections[access.command.kind]) {
      const collection = await readCollection(tx, access, section);
      collections.push({ section, total: collection.total });
    }
    const output = stored(FinanceCommandRecordedResultSchema, { commandId: access.command.id, kind: access.command.kind,
      targetId: access.command.targetId, result: access.result, executedAt: access.command.completedAt!.toISOString(),
      recorded, currentVerification, collections, contextAuthority: catalogContextAuthority(access.current), consistency: "immutable_execution" });
    return bounded(output, FINANCE_COMMAND_RESULT_MAX_RESPONSE_BYTES);
  }

  async page(tx: TenantTransaction, context: TenantContext, commandId: string, rawQuery: FinanceCommandResultPageQuery): Promise<FinanceCommandResultPage> {
    const query = input(FinanceCommandResultPageQuerySchema, rawQuery);
    const access = await authorizeResult(tx, context, commandId);
    if (!(financeCommandResultSections[access.command.kind] as readonly string[]).includes(query.section))
      throw new BadRequestException({ code: "finance_command_result_section_invalid", message: "此原执行结果没有该类明细" });
    const scope = createHash("sha256").update(canonicalJson({ tenantId: access.current.tenantId.toLowerCase(),
      userId: access.current.userId.toLowerCase(), commandId: access.command.id, resultId: access.result.id,
      kind: access.command.kind, section: query.section, limit: query.limit })).digest("hex");
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor, scope);
    const collection = await readCollection(tx, access, query.section), offset = cursor?.offset ?? 0;
    if (cursor) {
      if (offset >= collection.total) invalidCursor();
      const [anchor] = await collection.entries(offset - 1, 1);
      if (!anchor || anchor.anchor !== cursor.anchor) invalidCursor();
    }
    const entries = await collection.entries(offset, query.limit);
    if (entries.length !== Math.min(query.limit, collection.total - offset)) unavailable();
    const hasMore = offset + entries.length < collection.total;
    const nextCursor = hasMore ? encodeCursor({ v: 1, scope, offset: offset + entries.length, anchor: entries.at(-1)!.anchor }) : null;
    const output = stored(FinanceCommandResultPageSchema, { commandId: access.command.id, result: access.result, section: query.section,
      limit: query.limit, offset, total: collection.total, items: entries.map(entry => entry.value), hasMore, nextCursor,
      contextAuthority: catalogContextAuthority(access.current), consistency: "immutable_execution" });
    return bounded(output, FINANCE_COMMAND_RESULT_PAGE_MAX_RESPONSE_BYTES);
  }
}

async function authorizeResult(tx: TenantTransaction, context: TenantContext, rawId: string): Promise<Access> {
  const id = input(Id, rawId);
  // Deliberately exclude ciphertext and authority_snapshot from every read.
  const [command] = await tx.select({ id: financeCommands.id, tenantId: financeCommands.tenantId, createdBy: financeCommands.createdBy,
    kind: financeCommands.kind, targetId: financeCommands.targetId, requestKey: financeCommands.requestKey,
    ownerInputChecksum: financeCommands.ownerInputChecksum, status: financeCommands.status, resultId: financeCommands.resultId,
    completedAt: financeCommands.completedAt }).from(financeCommands).where(and(eq(financeCommands.id, id),
    eq(financeCommands.tenantId, context.tenantId), eq(financeCommands.createdBy, context.userId))).limit(1);
  if (!command) throw new NotFoundException({ code: "finance_command_result_not_found", message: "本人的财务原执行结果不存在或不可读取" });
  let current: TenantContext;
  try { current = await currentFinanceAuthority(tx, context, Permission.FinanceRead); }
  catch (error) {
    if (!(error instanceof ForbiddenError)) throw error;
    current = await currentFinanceAuthority(tx, context, financeCommandPermission(command.kind));
  }
  if (command.status !== "succeeded" || !command.resultId || !command.completedAt)
    throw new ConflictException({ code: "finance_command_result_not_available", message: "此原提交没有已提交的实际结果" });
  const [proof] = await tx.select().from(financeOriginalWriteProofs).where(and(eq(financeOriginalWriteProofs.tenantId, current.tenantId),
    eq(financeOriginalWriteProofs.kind, command.kind), eq(financeOriginalWriteProofs.resultId, command.resultId),
    eq(financeOriginalWriteProofs.commandId, command.id))).limit(1);
  if (!proof || proof.actorId !== command.createdBy || proof.requestKey !== command.requestKey || proof.targetId !== command.targetId
    || proof.ownerInputChecksum !== command.ownerInputChecksum || !/^[1-9][0-9]*$/.test(proof.creationTransactionId))
    throw new ConflictException({ code: "finance_command_result_proof_unavailable", message: "原执行凭据暂不可完整核对 不会补造历史结果" });
  const result = stored(FinanceCommandResultSchema, { kind: proof.kind, id: proof.resultId, parentId: proof.parentId, version: proof.version });
  return { command, current, result };
}

async function readRecorded(tx: TenantTransaction, access: Access): Promise<{ recorded: Recorded; currentVerification: Verification | null }> {
  const { command, current, result } = access, predicate = (table: { id: SQLWrapper; tenantId: SQLWrapper }) =>
    sql`${table.id}=${result.id}::uuid and ${table.tenantId}=${current.tenantId}::uuid`;
  switch (command.kind) {
    case "statement_record": {
      const [row] = await tx.select(statementHeaderColumns).from(financeStatements).where(predicate(financeStatements)).limit(1); if (!row) unavailable();
      return { recorded: { kind: command.kind, record: statementHeaderView(row) }, currentVerification: null };
    }
    case "fx_rate_record": {
      const [row] = await tx.select().from(financeFxRates).where(predicate(financeFxRates)).limit(1); if (!row) unavailable();
      return { recorded: { kind: command.kind, record: fxRateView(row) }, currentVerification: null };
    }
    case "metric_upsert": {
      const [row] = await tx.select().from(financeProfitMetricVersions).where(predicate(financeProfitMetricVersions)).limit(1); if (!row) unavailable();
      return { recorded: { kind: command.kind, record: { ...metricVersionView(row), name: row.requestIdentity?.name ?? null } }, currentVerification: null };
    }
    case "profit_calculate": {
      const [row] = await tx.select().from(financeProfitRuns).where(predicate(financeProfitRuns)).limit(1); if (!row) unavailable();
      const [version] = await tx.select({ version: financeProfitMetricVersions.versionNumber }).from(financeProfitMetricVersions)
        .where(and(eq(financeProfitMetricVersions.tenantId, current.tenantId), eq(financeProfitMetricVersions.id, row.metricVersionId))).limit(1);
      if (!version) unavailable();
      const record = { id: row.id, metricId: row.metricId, metricVersionId: row.metricVersionId, metricVersion: version.version,
        reportingCurrency: row.reportingCurrency, status: row.status as "complete" | "incomplete", revenueMinor: row.revenueMinor,
        costMinor: row.costMinor, profitMinor: row.profitMinor, marginBps: row.marginBps, statementIds: row.statementIds, fxRateIds: row.fxRateIds,
        diagnostics: row.diagnostics, monetaryBasis: row.monetaryBasis ?? null, sourceIdentityVersion: row.sourceIdentityVersion ?? null,
        inputChecksum: row.inputChecksum, calculatedAt: row.calculatedAt.toISOString() };
      const currentVerification = await verifyCurrent(async () => isFinanceProfitVerified(await profitRunView(tx, row)) ? [] : ["financial_evidence_unverified"]);
      return { recorded: { kind: command.kind, record }, currentVerification };
    }
    case "bill_record": {
      const [row] = await tx.select().from(financePayableBills).where(predicate(financePayableBills)).limit(1); if (!row) unavailable();
      return { recorded: { kind: command.kind, balanceSnapshot: "not_saved", record: { id: row.id, supplierId: row.supplierId,
        kind: row.kind, externalBillId: row.externalBillId, currency: row.currency, amountMinor: row.amountMinor, issuedAt: row.issuedAt.toISOString(),
        dueAt: row.dueAt?.toISOString() ?? null, procurementInvoiceId: row.procurementInvoiceId, procurementProofId: row.procurementProofId,
        recordedAt: row.recordedAt.toISOString() } }, currentVerification: null };
    }
    case "payment_record": {
      const [row] = await tx.select().from(financePayablePayments).where(predicate(financePayablePayments)).limit(1); if (!row) unavailable();
      return { recorded: { kind: command.kind, balanceSnapshot: "not_saved", record: { id: row.id, supplierId: row.supplierId,
        externalPaymentId: row.externalPaymentId, currency: row.currency, amountMinor: row.amountMinor, paidAt: row.paidAt.toISOString(),
        method: row.method, evidenceReference: row.evidenceReference, evidenceStatus: "operator_recorded", recordedAt: row.recordedAt.toISOString() } }, currentVerification: null };
    }
    case "payment_allocate": {
      const [row] = await tx.select({ id: financePaymentAllocationBatches.id, paymentId: financePaymentAllocationBatches.paymentId,
        recordedAt: financePaymentAllocationBatches.recordedAt }).from(financePaymentAllocationBatches).where(predicate(financePaymentAllocationBatches)).limit(1);
      if (!row) unavailable();
      const collection = await readCollection(tx, access, "allocations");
      return { recorded: { kind: command.kind, balanceSnapshot: "not_saved", record: { ...row,
        recordedAt: row.recordedAt.toISOString(), allocationCount: collection.total } }, currentVerification: null };
    }
    case "allocation_release": {
      const [row] = await tx.select().from(financeAllocationReleases).where(predicate(financeAllocationReleases)).limit(1); if (!row) unavailable();
      const [allocation] = await tx.select().from(financePaymentAllocations).where(and(eq(financePaymentAllocations.tenantId, current.tenantId),
        eq(financePaymentAllocations.id, row.allocationId))).limit(1); if (!allocation) unavailable();
      return { recorded: { kind: command.kind, balanceSnapshot: "not_saved", record: { ...releaseView(row), allocation: recordedAllocation(allocation) } }, currentVerification: null };
    }
    case "bill_adjustment_record": {
      const [row] = await tx.select().from(financeBillAdjustments).where(predicate(financeBillAdjustments)).limit(1); if (!row) unavailable();
      return { recorded: { kind: command.kind, balanceSnapshot: "saved_on_event", record: billAdjustmentView(row) }, currentVerification: null };
    }
    case "payment_adjustment_record": {
      const [row] = await tx.select().from(financePaymentAdjustments).where(predicate(financePaymentAdjustments)).limit(1); if (!row) unavailable();
      return { recorded: { kind: command.kind, balanceSnapshot: "saved_on_event", record: paymentAdjustmentView(row) }, currentVerification: null };
    }
    case "cost_version_approve": {
      const [row] = await tx.select().from(financeCostAllocationVersions).where(predicate(financeCostAllocationVersions)).limit(1); if (!row) unavailable();
      const view = await costAllocationVersionView(tx, row);
      const { sources, ...preview } = view.preview;
      const { basisProblems, preview: ignored, ...header } = view; void ignored;
      return { recorded: { kind: command.kind, record: { ...header, preview, sourceCount: sources.length,
        shareCount: sources.reduce((sum, source) => sum + source.shares.length, 0) } }, currentVerification: verification(basisProblems) };
    }
    case "allocated_profit_calculate": {
      const [row] = await tx.select().from(financeAllocatedProfitRuns).where(predicate(financeAllocatedProfitRuns)).limit(1); if (!row) unavailable();
      const view = await allocatedProfitRunView(tx, row), { basisProblems, ...record } = view;
      return { recorded: { kind: command.kind, record }, currentVerification: verification(view.status === "complete"
        ? basisProblems : [...basisProblems, "financial_evidence_unverified"]) };
    }
  }
}

function recordedAllocation(row: typeof financePaymentAllocations.$inferSelect) {
  // The original allocation is immutable; today's release flag is a separate event.
  const { released: ignored, ...record } = allocationView(row, false); void ignored;
  return stored(FinanceCommandResultAllocationSchema, record);
}

async function verifyCurrent(read: () => Promise<Verification["problems"]>): Promise<Verification> {
  try { return verification(await read()); }
  catch (error) {
    if (!(error instanceof ConflictException) && !(error instanceof NotFoundException)) throw error;
    return verification(["financial_evidence_unverified"]);
  }
}

function verification(problems: Verification["problems"]): Verification {
  return { verified: problems.length === 0, problems: [...new Set(problems)].sort(), checkedAt: new Date().toISOString() };
}

async function readCollection(tx: TenantTransaction, access: Access, section: FinanceCommandResultSection): Promise<Collection> {
  const { command, current, result } = access, root = resultTables[command.kind];
  const [parent] = await tx.execute<{ id: string }>(sql`select ${root.id} as id from ${root}
    where ${root.tenantId}=${current.tenantId}::uuid and ${root.id}=${result.id}::uuid limit 1`);
  if (!parent) unavailable();
  switch (section) {
    case "facts": {
      const where = and(eq(financeFacts.tenantId, current.tenantId), eq(financeFacts.statementId, result.id))!;
      const total = await countRows(tx, financeFacts, where);
      if (!total) unavailable();
      return { total, entries: async (offset, limit) => (await tx.select().from(financeFacts).where(where)
        .orderBy(asc(financeFacts.lineKey), asc(financeFacts.id)).offset(offset).limit(limit))
        .map(row => ({ anchor: row.id, value: factView(row) })) };
    }
    case "contributions": {
      const where = and(eq(financeProfitContributions.tenantId, current.tenantId), eq(financeProfitContributions.runId, result.id))!;
      const total = await countRows(tx, financeProfitContributions, where);
      return { total, entries: async (offset, limit) => (await tx.select({ contribution: financeProfitContributions, fact: financeFacts })
        .from(financeProfitContributions).innerJoin(financeFacts, and(eq(financeFacts.tenantId, financeProfitContributions.tenantId),
          eq(financeFacts.id, financeProfitContributions.factId))).where(where)
        .orderBy(asc(financeFacts.occurredAt), asc(financeFacts.id), asc(financeProfitContributions.id)).offset(offset).limit(limit))
        .map(({ contribution, fact }) => ({ anchor: contribution.id, value: stored(FinanceProfitContributionViewSchema, {
          id: contribution.id, factId: contribution.factId, fxRateId: contribution.fxRateId, bucket: contribution.bucket,
          sourceAmountMinor: contribution.sourceAmountMinor, sourceCurrency: contribution.sourceCurrency,
          reportingAmountMinor: contribution.reportingAmountMinor, reportingCurrency: contribution.reportingCurrency,
          effectSign: contribution.effectSign, factType: fact.factType, occurredAt: fact.occurredAt.toISOString(),
          orderId: fact.orderId, orderLineId: fact.orderLineId, skuId: fact.skuId, listingId: fact.listingId,
          accountId: fact.accountId, supplierId: fact.supplierId,
        }) })) };
    }
    case "allocations": {
      const [batch] = await tx.select({ expected: sql<string>`jsonb_array_length(${financePaymentAllocationBatches.input}->'allocations')::text` })
        .from(financePaymentAllocationBatches).where(and(eq(financePaymentAllocationBatches.tenantId, current.tenantId),
          eq(financePaymentAllocationBatches.id, result.id))).limit(1);
      if (!batch) unavailable();
      const where = and(eq(financePaymentAllocations.tenantId, current.tenantId), eq(financePaymentAllocations.batchId, result.id))!;
      const total = await countRows(tx, financePaymentAllocations, where);
      if (total !== count(batch.expected)) unavailable();
      // Original batch input preserves the operator's allocation order. A later
      // release is intentionally never joined into this immutable collection.
      const ordinal = sql`(select source.ordinality from jsonb_array_elements(${financePaymentAllocationBatches.input}->'allocations')
        with ordinality source(value,ordinality) where source.value->>'billId'=${financePaymentAllocations.billId}::text)`;
      return { total, entries: async (offset, limit) => (await tx.select({ allocation: financePaymentAllocations })
        .from(financePaymentAllocations).innerJoin(financePaymentAllocationBatches, and(
          eq(financePaymentAllocationBatches.tenantId, financePaymentAllocations.tenantId),
          eq(financePaymentAllocationBatches.id, financePaymentAllocations.batchId)))
        .where(where).orderBy(ordinal, asc(financePaymentAllocations.id)).offset(offset).limit(limit))
        .map(({ allocation }) => ({ anchor: allocation.id, value: recordedAllocation(allocation) })) };
    }
    case "cost_sources": {
      const [row] = await tx.execute<{ total: string }>(sql`select jsonb_array_length(${financeCostAllocationVersions.preview}->'sources')::text as total
        from ${financeCostAllocationVersions} where ${financeCostAllocationVersions.tenantId}=${current.tenantId}::uuid
          and ${financeCostAllocationVersions.id}=${result.id}::uuid`);
      const total = count(row?.total);
      return { total, entries: async (offset, limit) => (await tx.execute<{ sourceIndex: number; source: unknown }>(sql`
        select (source.ordinality-1)::int as "sourceIndex",source.value-'shares' as source
        from ${financeCostAllocationVersions} cross join lateral jsonb_array_elements(${financeCostAllocationVersions.preview}->'sources')
          with ordinality source(value,ordinality)
        where ${financeCostAllocationVersions.tenantId}=${current.tenantId}::uuid and ${financeCostAllocationVersions.id}=${result.id}::uuid
        order by source.ordinality offset ${offset} limit ${limit}`)).map(row => {
        const value = stored(FinanceCommandResultSourceSchema, row.source);
        return { anchor: `source:${row.sourceIndex}:${value.contributionId}`, value };
      }) };
    }
    case "cost_shares": {
      const [row] = await tx.execute<{ total: string }>(sql`select coalesce(sum(jsonb_array_length(source.value->'shares')),0)::text as total
        from ${financeCostAllocationVersions} cross join lateral jsonb_array_elements(${financeCostAllocationVersions.preview}->'sources') source(value)
        where ${financeCostAllocationVersions.tenantId}=${current.tenantId}::uuid and ${financeCostAllocationVersions.id}=${result.id}::uuid`);
      const total = count(row?.total);
      return { total, entries: async (offset, limit) => (await tx.execute<{ sourceIndex: number; shareIndex: number; source: unknown; share: unknown }>(sql`
        select (source.ordinality-1)::int as "sourceIndex",(share.ordinality-1)::int as "shareIndex",
          source.value-'shares' as source,share.value as share
        from ${financeCostAllocationVersions} cross join lateral jsonb_array_elements(${financeCostAllocationVersions.preview}->'sources')
          with ordinality source(value,ordinality)
        cross join lateral jsonb_array_elements(source.value->'shares') with ordinality share(value,ordinality)
        where ${financeCostAllocationVersions.tenantId}=${current.tenantId}::uuid and ${financeCostAllocationVersions.id}=${result.id}::uuid
        order by source.ordinality,share.ordinality offset ${offset} limit ${limit}`)).map(row => {
        const value = stored(FinanceCommandResultShareSchema, row);
        return { anchor: `share:${value.sourceIndex}:${value.shareIndex}:${value.source.contributionId}:${value.share.target.key}`, value };
      }) };
    }
    case "slices": {
      const where = and(eq(financeAllocatedProfitSlices.tenantId, current.tenantId), eq(financeAllocatedProfitSlices.runId, result.id))!;
      const total = await countRows(tx, financeAllocatedProfitSlices, where);
      return { total, entries: async (offset, limit) => (await tx.select().from(financeAllocatedProfitSlices).where(where)
        .orderBy(desc(financeAllocatedProfitSlices.id)).offset(offset).limit(limit))
        .map(row => ({ anchor: row.id, value: allocatedProfitSliceView(row) })) };
    }
  }
}

async function countRows(tx: TenantTransaction, table: SQLWrapper, where: SQL) {
  const [row] = await tx.execute<{ total: string }>(sql`select count(*)::text as total from ${table} where ${where}`);
  return count(row?.total);
}

function count(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) unavailable();
  const amount = BigInt(value);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) unavailable();
  return Number(amount);
}

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException({ code: "finance_command_result_input_invalid", message: "原执行结果查询格式不正确" });
  return parsed.data;
}

function stored<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) unavailable();
  return parsed.data;
}

function bounded<T>(value: T, maximum: number): T {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximum)
    throw new PayloadTooLargeException({ code: "finance_command_result_too_large", message: "原执行结果超过单次读取上限 不会截断原始记录" });
  return value;
}

function encodeCursor(value: z.infer<typeof FinanceCommandResultCursorSchema>) { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function decodeCursor(raw: string, scope: string) {
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) invalidCursor();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), parsed = FinanceCommandResultCursorSchema.safeParse(JSON.parse(text));
    if (!parsed.success || parsed.data.scope !== scope) invalidCursor();
    const value = { v: 1 as const, scope: parsed.data.scope, offset: parsed.data.offset, anchor: parsed.data.anchor };
    if (text !== JSON.stringify(value)) invalidCursor();
    return value;
  } catch (error) { if (error instanceof BadRequestException) throw error; invalidCursor(); }
}
function invalidCursor(): never { throw new BadRequestException({ code: "finance_command_result_cursor_invalid", message: "分页位置与此原执行明细不一致 请重新读取" }); }
function unavailable(): never { throw new ConflictException({ code: "finance_command_result_unavailable", message: "原执行结果有缺项或不一致 不会使用当前余额或重新计算补齐" }); }
