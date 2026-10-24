import { financeCommandOwnerLock } from "./finance-command-lock.js";
import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { authorize, ForbiddenError, intersectPermissionContexts, Permission, permissionScope } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import type { PrepareFinanceCommand } from "@yummyai/contracts/finance/finance-command";
import {
  AllocateFinancePaymentInputSchema, canonicalFinancePayablesRequest,
  FinanceAllocationReleaseViewSchema, FinancePayableBillViewSchema, FinancePayablePaymentViewSchema,
  FinancePayablesWorkspaceViewSchema, FinancePaymentAllocationBatchViewSchema, FinancePaymentAllocationViewSchema,
  RecordFinanceBillInputSchema, RecordFinancePaymentInputSchema, ReleaseFinanceAllocationInputSchema,
  type AllocateFinancePaymentInput, type FinanceAllocationReleaseView, type FinancePayableBillView,
  type FinancePayablePaymentView, type FinancePayablesWorkspaceView, type FinancePaymentAllocationBatchView,
  type FinancePaymentAllocationView, type RecordFinanceBillInput, type RecordFinancePaymentInput,
  type ReleaseFinanceAllocationInput,
} from "@yummyai/contracts/finance/payables";
import { FinanceProcurementAdjustmentOptionSchema, type FinanceBillBalance, type FinancePaymentBalance } from "@yummyai/contracts/finance/payables-adjustments";
import {
  financeAllocationReleases, financeBillAdjustments, financePaymentAdjustments, financePayableBills, financePayablePayments, financePaymentAllocationBatches,
  financePaymentAllocations, fulfillmentSuppliers, inventoryPurchaseOrders, inventorySupplierInvoiceRequests,
  inventorySupplierInvoices, invoiceReconciliations, loadCurrentMembershipContext, withTenant,
  type DatabaseConnection, type TenantTransaction,
} from "@yummyai/database";
import { and, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { readBillBalance, readBillStates, readBillSourceStatus, readPaymentBalance, readPaymentBalances,
  billAdjustmentView, paymentAdjustmentView } from "./finance-payables-ledger.js";

type BillRow = typeof financePayableBills.$inferSelect;
type PaymentRow = typeof financePayablePayments.$inferSelect;
type BatchRow = typeof financePaymentAllocationBatches.$inferSelect;
type AllocationRow = typeof financePaymentAllocations.$inferSelect;
type ReleaseRow = typeof financeAllocationReleases.$inferSelect;
type Operation = "bill" | "payment" | "allocation" | "release";
type BillBasis = Pick<BillRow, "supplierId" | "currency" | "amountMinor" | "procurementInvoiceId" | "externalBillId">
  & { issuedAt: string | Date; procurementProofId?: string | null };
type Source = {
  invoice: typeof inventorySupplierInvoices.$inferSelect;
  order: typeof inventoryPurchaseOrders.$inferSelect;
  proof: typeof inventorySupplierInvoiceRequests.$inferSelect | null;
  adjusted: boolean;
  reconciliationStatus: string;
  pendingAdjustment: boolean;
};
type SourceStatus = FinancePayableBillView["sourceStatus"];

/** This ledger records operator-supplied payment evidence and its application.
 * It never initiates a transfer or creates a second cost in FinanceFacts. */
@Injectable()
export class FinancePayablesService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Read the same prospective facts used after the actual owner's locks.
   * Preparing or inspecting an original never reserves financial capacity. */
  async validateCommandInTransaction(tx: TenantTransaction, context: TenantContext, original: PrepareFinanceCommand): Promise<void> {
    if (original.kind === "bill_record") {
      await currentAuthority(tx, context, Permission.FinanceWrite);
      await billRegistrationPlan(tx, original.input);
    } else if (original.kind === "payment_record") {
      await currentAuthority(tx, context, Permission.FinanceWrite);
      await paymentRegistrationPlan(tx, original.input);
    } else if (original.kind === "payment_allocate") {
      const current = await currentAuthority(tx, context, Permission.FinanceReview);
      await allocationPlan(tx, current, original.input, await allocationRoots(tx, original.input));
    } else if (original.kind === "allocation_release") {
      await currentAuthority(tx, context, Permission.FinanceReview);
      await releasePlan(tx, await allocationRoot(tx, original.targetId));
    } else throw new BadRequestException({ code: "finance_command_kind_invalid", message: "此财务提交不属于应付与核销拥有者" });
  }

  async workspace(context: TenantContext): Promise<FinancePayablesWorkspaceView> {
    return withTenant(this.database.db, context, async tx => {
      const current = await currentAuthority(tx, context, Permission.FinanceRead);
      const suppliers = await tx.select({ id: fulfillmentSuppliers.id, name: fulfillmentSuppliers.name, status: fulfillmentSuppliers.status })
        .from(fulfillmentSuppliers).orderBy(desc(fulfillmentSuppliers.id)).limit(1001);
      const bills = await tx.select().from(financePayableBills).orderBy(desc(financePayableBills.id)).limit(501);
      const payments = await tx.select().from(financePayablePayments).orderBy(desc(financePayablePayments.id)).limit(501);
      const allocations = await tx.select().from(financePaymentAllocations).orderBy(desc(financePaymentAllocations.id)).limit(501);
      const releases = await tx.select().from(financeAllocationReleases).orderBy(desc(financeAllocationReleases.id)).limit(501);
      const billAdjustments = await tx.select().from(financeBillAdjustments).orderBy(desc(financeBillAdjustments.id)).limit(501);
      const paymentAdjustments = await tx.select().from(financePaymentAdjustments).orderBy(desc(financePaymentAdjustments.id)).limit(501);
      const billPage = bills.slice(0, 500), paymentPage = payments.slice(0, 500), allocationPage = allocations.slice(0, 500);
      // Totals and release flags use the entire ledger, including facts beyond
      // the bounded workspace pages. A hidden release must still restore capacity.
      const billStates = await readBillStates(tx, current.tenantId, billPage.map(row => row.id));
      const paymentBalances = await readPaymentBalances(tx, current.tenantId, paymentPage.map(row => row.id));
      const released = await releasedIds(tx, allocationPage.map(row => row.id));
      const procurement = await readProcurementAdjustmentOptions(tx, billPage.map(row => row.id));
      return FinancePayablesWorkspaceViewSchema.parse({
        suppliers: suppliers.slice(0, 1000),
        bills: billPage.map(row => { const state = billStates.get(row.id); if (!state) inconsistent(); return billView(row, state.balance, state.sourceStatus); }),
        payments: paymentPage.map(row => paymentView(row, paymentBalances.get(row.id) ?? inconsistent())),
        allocations: allocationPage.map(row => allocationView(row, released.has(row.id))),
        releases: releases.slice(0, 500).map(releaseView),
        billAdjustments: billAdjustments.slice(0, 500).map(billAdjustmentView),
        paymentAdjustments: paymentAdjustments.slice(0, 500).map(paymentAdjustmentView),
        procurementAdjustments: procurement.options, procurementAdjustmentDiagnostics: procurement.diagnostics,
        permissions: { canWrite: allowed(current, Permission.FinanceWrite), canReview: allowed(current, Permission.FinanceReview) },
        truncated: suppliers.length > 1000 || [bills, payments, allocations, releases, billAdjustments, paymentAdjustments].some(rows => rows.length > 500) || procurement.truncated,
      });
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
  }

  async recordBill(context: TenantContext, raw: unknown): Promise<FinancePayableBillView> {
    return withTenant(this.database.db, context, tx => this.recordBillInTransaction(tx, context, raw));
  }

  async recordBillInTransaction(tx: TenantTransaction, context: TenantContext, raw: unknown): Promise<FinancePayableBillView> {
    const input = parse(RecordFinanceBillInputSchema, raw), checksum = requestChecksum("bill", input);
      const current = await currentAuthority(tx, context, Permission.FinanceWrite);
      await financeCommandOwnerLock(tx, current, "bill_record", input.idempotencyKey);
      await requestLock(tx, current, "bill", input.idempotencyKey);
      await lock(tx, `finance-payables-bill:${current.tenantId}:${input.supplierId}:${input.externalBillId}`);
      await scopeLock(tx, current, input.supplierId, input.currency);
      const [existing] = await tx.select().from(financePayableBills).where(eq(financePayableBills.idempotencyKey, input.idempotencyKey)).limit(1);
      if (existing) {
        assertReplay(existing, current, checksum);
        return readBillView(tx, existing);
      }
      const sources = input.procurementInvoiceId === null ? undefined : await lockedProcurementSources(tx, current, [input]);
      const { procurementProofId, recordedSource } = await billRegistrationPlan(tx, input, sources);
      const [row] = await tx.insert(financePayableBills).values({ ...input, issuedAt: new Date(input.issuedAt),
        dueAt: input.dueAt === null ? null : new Date(input.dueAt), id: createEntityId(), tenantId: current.tenantId,
        procurementProofId, requestChecksum: checksum, recordedBy: current.userId }).returning();
      if (!row) inconsistent();
      await this.audit.recordInTransaction(tx, current, { action: "finance.payables.bill_recorded", resourceType: "finance_payable_bill",
        resourceId: row.id, result: "success", metadata: { supplierId: row.supplierId, kind: row.kind, currency: row.currency,
          amountMinor: row.amountMinor, procurementInvoiceId: row.procurementInvoiceId, procurementProofId: row.procurementProofId } });
      return billView(row, initialBillBalance(row), recordedSource);
  }

  async recordPayment(context: TenantContext, raw: unknown): Promise<FinancePayablePaymentView> {
    return withTenant(this.database.db, context, tx => this.recordPaymentInTransaction(tx, context, raw));
  }

  async recordPaymentInTransaction(tx: TenantTransaction, context: TenantContext, raw: unknown): Promise<FinancePayablePaymentView> {
    const input = parse(RecordFinancePaymentInputSchema, raw), checksum = requestChecksum("payment", input);
      const current = await currentAuthority(tx, context, Permission.FinanceWrite);
      await financeCommandOwnerLock(tx, current, "payment_record", input.idempotencyKey);
      await requestLock(tx, current, "payment", input.idempotencyKey);
      await lock(tx, `finance-payables-payment:${current.tenantId}:${input.supplierId}:${input.externalPaymentId}`);
      await scopeLock(tx, current, input.supplierId, input.currency);
      const [existing] = await tx.select().from(financePayablePayments).where(eq(financePayablePayments.idempotencyKey, input.idempotencyKey)).limit(1);
      if (existing) {
        assertReplay(existing, current, checksum);
        return readPaymentView(tx, existing);
      }
      await paymentRegistrationPlan(tx, input);
      const [row] = await tx.insert(financePayablePayments).values({ ...input, paidAt: new Date(input.paidAt), id: createEntityId(), tenantId: current.tenantId,
        requestChecksum: checksum, recordedBy: current.userId }).returning();
      if (!row) inconsistent();
      await this.audit.recordInTransaction(tx, current, { action: "finance.payables.payment_recorded", resourceType: "finance_payable_payment",
        resourceId: row.id, result: "success", metadata: { supplierId: row.supplierId, currency: row.currency, amountMinor: row.amountMinor,
          method: row.method, evidenceStatus: "operator_recorded" } });
      return paymentView(row, initialPaymentBalance(row));
  }

  async allocate(context: TenantContext, raw: unknown): Promise<FinancePaymentAllocationBatchView> {
    return withTenant(this.database.db, context, tx => this.allocateInTransaction(tx, context, raw));
  }

  async allocateInTransaction(tx: TenantTransaction, context: TenantContext, raw: unknown): Promise<FinancePaymentAllocationBatchView> {
    const input = parse(AllocateFinancePaymentInputSchema, raw), checksum = requestChecksum("allocation", input);
      const current = await currentAuthority(tx, context, Permission.FinanceReview);
      await financeCommandOwnerLock(tx, current, "payment_allocate", input.idempotencyKey);
      await requestLock(tx, current, "allocation", input.idempotencyKey);
      const [existing] = await tx.select().from(financePaymentAllocationBatches)
        .where(eq(financePaymentAllocationBatches.idempotencyKey, input.idempotencyKey)).limit(1);
      if (existing) {
        assertReplay(existing, current, checksum);
        return readBatchView(tx, existing);
      }
      const roots = await allocationRoots(tx, input), { payment, bills } = roots;
      await scopeLock(tx, current, payment.supplierId, payment.currency);
      await lockedProcurementSources(tx, current, bills);
      const { total } = await allocationPlan(tx, current, input, roots);
      const [batch] = await tx.insert(financePaymentAllocationBatches).values({ id: createEntityId(), tenantId: current.tenantId,
        paymentId: payment.id, input, requestChecksum: checksum, idempotencyKey: input.idempotencyKey, recordedBy: current.userId }).returning();
      if (!batch) inconsistent();
      await tx.insert(financePaymentAllocations).values(input.allocations.map(item => ({ id: createEntityId(), tenantId: current.tenantId,
        batchId: batch.id, paymentId: payment.id, billId: item.billId, supplierId: payment.supplierId, currency: payment.currency,
        amountMinor: item.amountMinor, recordedBy: current.userId })));
      await this.audit.recordInTransaction(tx, current, { action: "finance.payables.payment_allocated", resourceType: "finance_payment_allocation_batch",
        resourceId: batch.id, result: "success", metadata: { paymentId: payment.id, supplierId: payment.supplierId, currency: payment.currency,
          amountMinor: safeMinor(total), allocationCount: input.allocations.length } });
      return readBatchView(tx, batch);
  }

  async release(context: TenantContext, rawAllocationId: string, raw: unknown): Promise<FinanceAllocationReleaseView> {
    return withTenant(this.database.db, context, tx => this.releaseInTransaction(tx, context, rawAllocationId, raw));
  }

  async releaseInTransaction(tx: TenantTransaction, context: TenantContext, rawAllocationId: string, raw: unknown): Promise<FinanceAllocationReleaseView> {
    const allocationId = parse(EntityIdSchema, rawAllocationId).toLowerCase(), input = parse(ReleaseFinanceAllocationInputSchema, raw);
    const checksum = requestChecksum("release", input, allocationId);
      const current = await currentAuthority(tx, context, Permission.FinanceReview);
      await financeCommandOwnerLock(tx, current, "allocation_release", input.idempotencyKey);
      await requestLock(tx, current, "release", input.idempotencyKey);
      const [existing] = await tx.select().from(financeAllocationReleases).where(eq(financeAllocationReleases.idempotencyKey, input.idempotencyKey)).limit(1);
      if (existing) {
        assertReplay(existing, current, checksum);
        if (existing.allocationId !== allocationId) requestMismatch();
        return releaseView(existing);
      }
      const allocation = await allocationRoot(tx, allocationId);
      await scopeLock(tx, current, allocation.supplierId, allocation.currency);
      await releasePlan(tx, allocation);
      const [row] = await tx.insert(financeAllocationReleases).values({ ...input, id: createEntityId(), tenantId: current.tenantId,
        allocationId, requestChecksum: checksum, recordedBy: current.userId }).returning();
      if (!row) inconsistent();
      await this.audit.recordInTransaction(tx, current, { action: "finance.payables.allocation_released", resourceType: "finance_allocation_release",
        resourceId: row.id, result: "success", metadata: { allocationId, paymentId: allocation.paymentId, billId: allocation.billId,
          supplierId: allocation.supplierId, currency: allocation.currency, amountMinor: allocation.amountMinor, reasonCode: row.reasonCode } });
      return releaseView(row);
  }
}

async function billRegistrationPlan(tx: TenantTransaction, input: RecordFinanceBillInput, retainedSources?: Map<string, Source>) {
  await requireSupplier(tx, input.supplierId);
  const [duplicate] = await tx.select({ id: financePayableBills.id }).from(financePayableBills).where(and(
    eq(financePayableBills.supplierId, input.supplierId), eq(financePayableBills.externalBillId, input.externalBillId),
  )).limit(1);
  if (duplicate) conflict("finance_payables_bill_already_recorded", "该供应商账单号已有原始记录 请核对已有账单");
  let procurementProofId: string | null = null, recordedSource: SourceStatus = "current";
  if (input.procurementInvoiceId !== null) {
    const sources = retainedSources ?? await readProcurementSources(tx, [input.procurementInvoiceId]);
    recordedSource = sourceStatus(input, sources);
    requireCurrentSource(recordedSource, true);
    procurementProofId = sources.get(input.procurementInvoiceId)!.proof!.id;
    const [mapped] = await tx.select({ id: financePayableBills.id }).from(financePayableBills)
      .where(eq(financePayableBills.procurementInvoiceId, input.procurementInvoiceId)).limit(1);
    if (mapped) conflict("finance_payables_bill_already_recorded", "该采购发票已有应付记录 不可重复登记");
  }
  return { procurementProofId, recordedSource };
}

async function paymentRegistrationPlan(tx: TenantTransaction, input: RecordFinancePaymentInput) {
  await requireSupplier(tx, input.supplierId);
  const [duplicate] = await tx.select({ id: financePayablePayments.id }).from(financePayablePayments).where(and(
    eq(financePayablePayments.supplierId, input.supplierId), eq(financePayablePayments.externalPaymentId, input.externalPaymentId),
  )).limit(1);
  if (duplicate) conflict("finance_payables_payment_already_recorded", "该供应商付款凭据号已有记录 请核对已有付款");
}

async function allocationRoots(tx: TenantTransaction, input: AllocateFinancePaymentInput): Promise<{ payment: PaymentRow; bills: BillRow[] }> {
  const [payment] = await tx.select().from(financePayablePayments).where(eq(financePayablePayments.id, input.paymentId)).limit(1);
  if (!payment) throw new NotFoundException("付款记录不存在");
  const bills = await tx.select().from(financePayableBills).where(inArray(financePayableBills.id, input.allocations.map(item => item.billId)));
  if (bills.length !== input.allocations.length) throw new NotFoundException("核销账单不存在");
  if (bills.some(bill => bill.supplierId !== payment.supplierId || bill.currency !== payment.currency))
    conflict("finance_payables_scope_mismatch", "一次核销只能使用同一供应商和同币种的账单与付款");
  return { payment, bills };
}

/** No writes or business locks: the actual path calls this again under its
 * scope/PO locks, so a preview never reserves or silently consumes a balance. */
async function allocationPlan(tx: TenantTransaction, current: TenantContext, input: AllocateFinancePaymentInput,
  { payment, bills }: { payment: PaymentRow; bills: BillRow[] }) {
  const billStates = await readBillStates(tx, current.tenantId, bills.map(row => row.id));
  for (const bill of bills) { const state = billStates.get(bill.id); if (!state) inconsistent(); requireCurrentSource(state.sourceStatus); }
  const paymentBalance = await readPaymentBalance(tx, current.tenantId, payment.id);
  const total = input.allocations.reduce((sum, item) => sum + minor(item.amountMinor), 0n);
  if (total > minor(paymentBalance.unallocatedMinor))
    conflict("finance_payables_payment_exceeded", "核销金额超过该付款的未分配余额");
  const byId = new Map(bills.map(bill => [bill.id, bill]));
  for (const item of input.allocations) {
    const bill = byId.get(item.billId)!;
    if (minor(item.amountMinor) > minor(billStates.get(bill.id)!.balance.outstandingMinor))
      conflict("finance_payables_bill_exceeded", "核销金额超过账单的剩余应付余额");
  }
  return { total };
}

async function allocationRoot(tx: TenantTransaction, allocationId: string) {
  const [allocation] = await tx.select().from(financePaymentAllocations).where(eq(financePaymentAllocations.id, allocationId)).limit(1);
  if (!allocation) throw new NotFoundException("原核销记录不存在");
  return allocation;
}

async function releasePlan(tx: TenantTransaction, allocation: AllocationRow) {
  const [released] = await tx.select({ id: financeAllocationReleases.id }).from(financeAllocationReleases)
    .where(eq(financeAllocationReleases.allocationId, allocation.id)).limit(1);
  if (released) conflict("finance_payables_allocation_already_released", "该核销已全额撤销 请使用其原撤销凭据");
}

async function currentAuthority(tx: TenantTransaction, base: TenantContext, permission: Permission) {
  const current = intersectPermissionContexts(base, await loadCurrentMembershipContext(tx, base, { lock: true }));
  requireTenantPermission(current, permission);
  return current;
}

function requireTenantPermission(context: TenantContext, permission: Permission) {
  authorize(context, permission);
  if (permissionScope(context, permission) !== "tenant") throw new ForbiddenError(permission, "outside_data_scope");
}

function allowed(context: TenantContext, permission: Permission) {
  try { requireTenantPermission(context, permission); return true; }
  catch (error) { if (error instanceof ForbiddenError) return false; throw error; }
}

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException({ code: "finance_payables_input_invalid", message: "应付与付款填写格式不正确" });
  return result.data;
}

function requestChecksum(operation: Operation, input: RecordFinanceBillInput | RecordFinancePaymentInput | AllocateFinancePaymentInput | ReleaseFinanceAllocationInput, targetId: string | null = null) {
  return createHash("sha256").update(canonicalFinancePayablesRequest(operation, input, targetId)).digest("hex");
}

function assertReplay(row: { recordedBy: string; requestChecksum: string }, current: TenantContext, checksum: string) {
  if (row.recordedBy !== current.userId || row.requestChecksum !== checksum) requestMismatch();
}

function requestMismatch(): never {
  conflict("finance_payables_request_mismatch", "该请求键已绑定原填写和操作者 请核对原始提交");
}

async function lock(tx: TenantTransaction, key: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);
}

function requestLock(tx: TenantTransaction, current: TenantContext, operation: Operation, key: string) {
  return lock(tx, `finance-payables-request:${current.tenantId}:${operation}:${key}`);
}

function scopeLock(tx: TenantTransaction, current: TenantContext, supplierId: string, currency: string) {
  return lock(tx, `finance-payables-scope:${current.tenantId}:${supplierId}:${currency}`);
}

async function requireSupplier(tx: TenantTransaction, supplierId: string) {
  const [supplier] = await tx.select({ id: fulfillmentSuppliers.id }).from(fulfillmentSuppliers).where(eq(fulfillmentSuppliers.id, supplierId)).limit(1);
  if (!supplier) throw new NotFoundException("供应商不存在");
  // Historical obligations and payment evidence can still be recorded for a
  // suspended supplier. Its status does not erase a real financial obligation.
}

function invoiceIds(bills: BillBasis[]) {
  return [...new Set(bills.flatMap(bill => bill.procurementInvoiceId === null ? [] : [bill.procurementInvoiceId]))];
}

async function readProcurementSources(tx: TenantTransaction, ids: string[]): Promise<Map<string, Source>> {
  if (!ids.length) return new Map();
  const rows = await tx.select({ invoice: inventorySupplierInvoices, order: inventoryPurchaseOrders, proof: inventorySupplierInvoiceRequests })
    .from(inventorySupplierInvoices).innerJoin(inventoryPurchaseOrders, eq(inventoryPurchaseOrders.id, inventorySupplierInvoices.purchaseOrderId))
    .leftJoin(inventorySupplierInvoiceRequests, eq(inventorySupplierInvoiceRequests.invoiceId, inventorySupplierInvoices.id))
    .where(inArray(inventorySupplierInvoices.id, ids));
  const adjusted = new Set((await tx.select({ invoiceId: invoiceReconciliations.invoiceId }).from(invoiceReconciliations).where(and(
    inArray(invoiceReconciliations.invoiceId, ids), eq(invoiceReconciliations.action, "adjustment_review"),
    sql`${invoiceReconciliations.input}->>'decision'='approved'`,
  ))).map(row => row.invoiceId));
  const statuses = new Map((await tx.selectDistinctOn([invoiceReconciliations.invoiceId], {
    invoiceId: invoiceReconciliations.invoiceId, status: sql<string>`${invoiceReconciliations.balance}->>'status'`,
  }).from(invoiceReconciliations).where(inArray(invoiceReconciliations.invoiceId, ids))
    .orderBy(invoiceReconciliations.invoiceId, desc(invoiceReconciliations.sequence))).map(row => [row.invoiceId, row.status]));
  const pending = new Set((await tx.select({ invoiceId: invoiceReconciliations.invoiceId }).from(invoiceReconciliations).where(and(
    inArray(invoiceReconciliations.invoiceId, ids), eq(invoiceReconciliations.action, "adjustment_record"), sql`not exists (
      select 1 from ${invoiceReconciliations} reviewed where reviewed.tenant_id=${invoiceReconciliations.tenantId}
        and reviewed.adjustment_id=${invoiceReconciliations.id}
    )`,
  ))).map(row => row.invoiceId));
  return new Map(rows.map(row => [row.invoice.id, { ...row, adjusted: adjusted.has(row.invoice.id),
    reconciliationStatus: statuses.get(row.invoice.id) ?? row.invoice.status, pendingAdjustment: pending.has(row.invoice.id) }]));
}

async function lockedProcurementSources(tx: TenantTransaction, current: TenantContext, bills: BillBasis[]) {
  const ids = invoiceIds(bills), initial = await readProcurementSources(tx, ids);
  for (const orderId of [...new Set([...initial.values()].map(source => source.order.id))].sort())
    await lock(tx, `procurement-order:${current.tenantId}:${orderId}`);
  return readProcurementSources(tx, ids);
}

function sourceStatus(bill: BillBasis, sources: Map<string, Source>): SourceStatus {
  if (bill.procurementInvoiceId === null) return "current";
  const source = sources.get(bill.procurementInvoiceId);
  if (!source || !source.proof || !source.invoice.creationTransactionId || source.invoice.allocationStatus === null
    || source.invoice.allocationStatus === "legacy_unknown" || source.proof.evidenceVersion !== 1
    || source.proof.purchaseOrderId !== source.order.id || source.invoice.purchaseOrderId !== source.order.id
    || source.proof.idempotencyKey !== source.invoice.idempotencyKey || source.proof.createdBy !== source.invoice.createdBy
    || source.order.supplierId !== bill.supplierId || source.invoice.currency !== bill.currency
    || source.invoice.invoiceNumber !== bill.externalBillId
    || source.invoice.issuedAt.getTime() !== (typeof bill.issuedAt === "string" ? Date.parse(bill.issuedAt) : bill.issuedAt.getTime())
    || !Number.isSafeInteger(source.invoice.totalMinor) || source.invoice.totalMinor !== bill.amountMinor
    || "procurementProofId" in bill && bill.procurementProofId !== source.proof.id) return "source_unavailable";
  if (source.adjusted) return "source_adjusted";
  return source.pendingAdjustment || source.reconciliationStatus !== "matched" ? "source_unreconciled" : "current";
}

function requireCurrentSource(status: SourceStatus, allowRegistration = false) {
  if (status === "source_adjusted" && !allowRegistration) conflict("finance_payables_source_adjusted", "采购发票有尚未同步的核准调整 请先逐条核对同步 再按净额核销");
  if (status === "source_unavailable") conflict("finance_payables_source_unavailable", "采购发票原始凭据或供应商 币种 金额依据不一致 不可自动建立或核销应付");
  if (status === "source_unreconciled" && !allowRegistration)
    conflict("finance_payables_source_unreconciled", "采购发票尚未完成收货与金额核对 或仍有待审批凭证 请先完成核对再核销");
}

export async function readProcurementAdjustmentOptions(tx: TenantTransaction, ids: string[], page?: {limit:number;beforeId?:string;upperId?:string;id?:string}) {
  const options: FinancePayablesWorkspaceView["procurementAdjustments"] = [];
  const diagnostics: FinancePayablesWorkspaceView["procurementAdjustmentDiagnostics"] = [];
  const limit = page?.limit ?? 500;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new RangeError("Invalid approved-source read limit");
  if (!ids.length) return { options, diagnostics, truncated: false, sources: [] };
  const source = alias(invoiceReconciliations, "payable_adjustment_source"), review = alias(invoiceReconciliations, "payable_adjustment_review");
  const rows = await tx.select({ billId: financePayableBills.id, source, reviewId: review.id, mappedEventId: financeBillAdjustments.id })
    .from(financePayableBills).innerJoin(source, and(eq(source.invoiceId, financePayableBills.procurementInvoiceId), eq(source.action, "adjustment_record")))
    .innerJoin(review, and(eq(review.adjustmentId, source.id), eq(review.action, "adjustment_review"), sql`${review.input}->>'decision'='approved'`))
    .leftJoin(financeBillAdjustments, and(eq(financeBillAdjustments.billId, financePayableBills.id), eq(financeBillAdjustments.procurementAdjustmentId, source.id)))
    .where(and(inArray(financePayableBills.id, ids), page?.beforeId ? lt(source.id,page.beforeId) : undefined,
      page?.upperId ? lte(source.id,page.upperId) : undefined, page?.id ? eq(source.id,page.id) : undefined)).orderBy(desc(source.id)).limit(limit+1);
  for (const row of rows.slice(0, limit)) {
    const diagnostic = { billId: row.billId, procurementAdjustmentId: row.source.id, procurementReviewId: row.reviewId,
      code: "source_format_not_supported" as const };
    const input = row.source.input;
    if (input.action !== "adjustment_record" || input.lines.some(line => !Number.isSafeInteger(line.amountMinor) || line.amountMinor < 0)) {
      diagnostics.push(diagnostic); continue;
    }
    const amount = input.lines.reduce((sum, line) => sum + BigInt(line.amountMinor), 0n);
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) { diagnostics.push(diagnostic); continue; }
    const parsed = FinanceProcurementAdjustmentOptionSchema.safeParse({ billId: row.billId, procurementAdjustmentId: row.source.id,
      procurementReviewId: row.reviewId, kind: input.document.kind === "credit_note" ? "credit" : "debit", amountMinor: Number(amount),
      externalDocumentId: input.document.number, evidenceReference: input.document.evidenceReference, occurredAt: input.document.issuedAt,
      mappedEventId: row.mappedEventId });
    if (!parsed.success || parsed.data.externalDocumentId !== input.document.number || parsed.data.evidenceReference !== input.document.evidenceReference)
      diagnostics.push(diagnostic);
    else options.push(parsed.data);
  }
  return { options, diagnostics, truncated: rows.length > limit,
    sources: rows.slice(0,limit).map(row=>({id:row.source.id,billId:row.billId,reviewId:row.reviewId,recordedAt:row.source.createdAt.toISOString()})) };
}

export async function releasedIds(tx: TenantTransaction, ids: string[]) {
  if (!ids.length) return new Set<string>();
  return new Set((await tx.select({ id: financeAllocationReleases.allocationId }).from(financeAllocationReleases)
    .where(inArray(financeAllocationReleases.allocationId, ids))).map(row => row.id));
}

export async function readBillView(tx: TenantTransaction, row: BillRow) {
  return billView(row, await readBillBalance(tx, row.tenantId, row.id), await readBillSourceStatus(tx, row.tenantId, row.id));
}

export async function readPaymentView(tx: TenantTransaction, row: PaymentRow) {
  return paymentView(row, await readPaymentBalance(tx, row.tenantId, row.id));
}

export async function readBatchView(tx: TenantTransaction, row: BatchRow): Promise<FinancePaymentAllocationBatchView> {
  const allocations = await tx.select().from(financePaymentAllocations).where(eq(financePaymentAllocations.batchId, row.id));
  const byBill = new Map(allocations.map(allocation => [allocation.billId, allocation]));
  if (allocations.length !== row.input.allocations.length || byBill.size !== allocations.length) inconsistent();
  const released = await releasedIds(tx, allocations.map(allocation => allocation.id));
  return FinancePaymentAllocationBatchViewSchema.parse({ id: row.id, paymentId: row.paymentId, recordedAt: row.recordedAt.toISOString(),
    allocations: row.input.allocations.map(item => {
      const allocation = byBill.get(item.billId);
      if (!allocation || allocation.paymentId !== row.paymentId || allocation.amountMinor !== item.amountMinor) inconsistent();
      return allocationView(allocation, released.has(allocation.id));
    }) });
}

export function billView(row: BillRow, balance: FinanceBillBalance, source: SourceStatus): FinancePayableBillView {
  if (balance.amountMinor !== row.amountMinor) inconsistent();
  return FinancePayableBillViewSchema.parse({ id: row.id, supplierId: row.supplierId, kind: row.kind, externalBillId: row.externalBillId,
    currency: row.currency, ...balance, issuedAt: row.issuedAt.toISOString(), dueAt: row.dueAt?.toISOString() ?? null,
    procurementInvoiceId: row.procurementInvoiceId, procurementProofId: row.procurementProofId, sourceStatus: source,
    status: allocationStatus(minor(balance.allocatedMinor), minor(balance.outstandingMinor)), recordedAt: row.recordedAt.toISOString() });
}

export function paymentView(row: PaymentRow, balance: FinancePaymentBalance): FinancePayablePaymentView {
  if (balance.amountMinor !== row.amountMinor) inconsistent();
  return FinancePayablePaymentViewSchema.parse({ id: row.id, supplierId: row.supplierId, externalPaymentId: row.externalPaymentId,
    currency: row.currency, ...balance, paidAt: row.paidAt.toISOString(), method: row.method, evidenceReference: row.evidenceReference,
    evidenceStatus: "operator_recorded", status: allocationStatus(minor(balance.allocatedMinor), minor(balance.unallocatedMinor)), recordedAt: row.recordedAt.toISOString() });
}

function initialBillBalance(row: BillRow): FinanceBillBalance {
  return { amountMinor: row.amountMinor, creditMinor: 0, debitMinor: 0, voidedMinor: 0, netAmountMinor: row.amountMinor,
    allocatedMinor: 0, outstandingMinor: row.amountMinor, lifecycle: "active" };
}
function initialPaymentBalance(row: PaymentRow): FinancePaymentBalance {
  return { amountMinor: row.amountMinor, refundedMinor: 0, voidedMinor: 0, netAmountMinor: row.amountMinor,
    allocatedMinor: 0, unallocatedMinor: row.amountMinor, lifecycle: "active" };
}

function allocationStatus(allocated: bigint, remaining: bigint) {
  return allocated === 0n ? "unallocated" : remaining === 0n ? "fully_allocated" : "partially_allocated";
}

export function allocationView(row: AllocationRow, released: boolean): FinancePaymentAllocationView {
  return FinancePaymentAllocationViewSchema.parse({ id: row.id, batchId: row.batchId, paymentId: row.paymentId, billId: row.billId,
    supplierId: row.supplierId, currency: row.currency, amountMinor: row.amountMinor, released, recordedAt: row.recordedAt.toISOString() });
}

export function releaseView(row: ReleaseRow): FinanceAllocationReleaseView {
  return FinanceAllocationReleaseViewSchema.parse({ id: row.id, allocationId: row.allocationId, reasonCode: row.reasonCode, recordedAt: row.recordedAt.toISOString() });
}

function minor(amount: number) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new UnprocessableEntityException({ code: "finance_money_overflow", message: "金额超出可精确记录的范围" });
  return BigInt(amount);
}

function safeMinor(amount: bigint) {
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new UnprocessableEntityException({ code: "finance_money_overflow", message: "金额超出可精确记录的范围" });
  return Number(amount);
}

function inconsistent(): never {
  conflict("finance_payables_ledger_inconsistent", "核销原始凭据不完整或余额不一致 请先核对已有台账");
}

function conflict(code: string, message: string): never {
  throw new ConflictException({ code, message });
}
