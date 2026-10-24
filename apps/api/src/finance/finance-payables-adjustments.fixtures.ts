/** Synthetic supplier evidence only; the disposable runner owns every resource. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { RecordFinanceBillInput, RecordFinancePaymentInput } from "@yummyai/contracts/finance/payables";
import type { InvoiceReconciliationInput } from "@yummyai/contracts/procurement/invoice-reconciliation";
import { fulfillmentSuppliers, memberships, roles, withTenant, type DatabaseConnection } from "@yummyai/database";
import { invoiceReconciliationFixture, protectedInvoiceTables } from "../procurement/invoice-reconciliation.fixtures.js";
import { ProcurementCommandService } from "../procurement/procurement-command.service.js";
import { FinancePayablesService } from "./finance-payables.service.js";
import { FinancePayablesAdjustmentsService } from "./finance-payables-adjustments.service.js";

export function requireFinancePayablesAdjustmentsFixture() {
  const target = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
  if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FINANCE_PAYABLES_ADJUSTMENTS_ISOLATED !== "1"
    || process.env.E2E_INVOICE_RECONCILIATION_ISOLATED !== "1" || !["postgres:", "postgresql:"].includes(target.protocol)
    || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(target.pathname))
    throw new Error("Payables adjustments require the dedicated disposable acceptance runner before connection");
}
export const adjustmentKey = () => `synthetic-payables-adjustment-${randomUUID()}`;
export const adjustmentCode = () => `ADJ-${randomUUID().slice(0, 8).toUpperCase()}`;
export const adjustmentPermissions = [Permission.ProcurementRead, Permission.ProcurementWrite, Permission.ProcurementApprove,
  Permission.InventoryRead, Permission.InventoryWrite, Permission.ProductRead, Permission.ProductWrite,
  Permission.FinanceRead, Permission.FinanceWrite, Permission.FinanceReview];
export const existingPayablesTables = ["finance_payable_bills", "finance_payable_payments", "finance_payment_allocation_batches",
  "finance_payment_allocations", "finance_allocation_releases"];
export const protectedAdjustmentFacts = [...protectedInvoiceTables, "inventory_invoice_reconciliations", "inventory_invoice_allocation_effects",
  "finance_statements", "finance_facts", "finance_profit_runs", "finance_profit_contributions"];

export function financePayablesAdjustmentsFixture(database: DatabaseConnection) {
  requireFinancePayablesAdjustmentsFixture();
  const procurement = invoiceReconciliationFixture(database), secret = randomBytes(32);
  const context: TenantContext = { ...procurement.context, permissions: adjustmentPermissions };
  const coworker: TenantContext = { ...procurement.coworker, permissions: adjustmentPermissions };
  const outsider: TenantContext = { ...procurement.outsider, permissions: adjustmentPermissions };
  const payables = new FinancePayablesService(database, procurement.audit);
  const adjustments = new FinancePayablesAdjustmentsService(database, procurement.audit);
  const commands = new ProcurementCommandService(database, new SecretVault(secret), procurement.owner, procurement.audit);
  async function rights(actor: TenantContext, granted: string[], dataScope: "tenant" | "self" | "team" = "tenant") {
    await withTenant(database.db, actor, tx => tx.update(roles).set({ permissions: granted, dataScope })
      .where(eq(roles.id, procurement.roleIds.get(actor.userId)!)));
  }
  async function restoreRights() {
    for (const actor of [context, coworker, outsider]) {
      await rights(actor, adjustmentPermissions);
      await withTenant(database.db, actor, tx => tx.update(memberships).set({ status: "active" }).where(eq(memberships.userId, actor.userId)));
    }
  }
  async function initialize() { await procurement.initialize(); await restoreRights(); }
  function billInput(amountMinor = 10000, overrides: Partial<RecordFinanceBillInput> = {}): RecordFinanceBillInput {
    return { supplierId: procurement.supplierId, kind: "factory_invoice", externalBillId: adjustmentCode(), currency: "USD", amountMinor,
      issuedAt: "2026-07-01T00:00:00.000Z", dueAt: null, procurementInvoiceId: null, idempotencyKey: adjustmentKey(), ...overrides };
  }
  function paymentInput(amountMinor = 10000, overrides: Partial<RecordFinancePaymentInput> = {}): RecordFinancePaymentInput {
    return { supplierId: procurement.supplierId, externalPaymentId: adjustmentCode(), currency: "USD", amountMinor,
      paidAt: "2026-07-02T00:00:00.000Z", method: "bank_transfer", evidenceReference: adjustmentCode(), idempotencyKey: adjustmentKey(), ...overrides };
  }
  const bill = (amount = 10000, overrides: Partial<RecordFinanceBillInput> = {}) => payables.recordBill(context, billInput(amount, overrides));
  const payment = (amount = 10000, overrides: Partial<RecordFinancePaymentInput> = {}) => payables.recordPayment(context, paymentInput(amount, overrides));
  const allocate = (paymentId: string, billId: string, amountMinor: number) => payables.allocate(context,
    { paymentId, allocations: [{ billId, amountMinor }], idempotencyKey: adjustmentKey() });
  const workspace = () => payables.workspace(context);
  async function state(tables: string[]) {
    return withTenant(database.db, context, async tx => {
      const result: Record<string, { count: number; digest: string }> = {};
      for (const table of tables) {
        const rows = await tx.execute(sql`select * from ${sql.identifier(table)} order by id`);
        result[table] = { count: rows.length, digest: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
      }
      return result;
    });
  }
  async function execute(invoiceId: string, input: InvoiceReconciliationInput) {
    const prepared = await commands.prepare(context, { kind: "invoice_reconcile", targetId: invoiceId, input });
    const completed = await commands.execute(context, prepared.id);
    if (!completed.reconciliationResult) throw new Error("Synthetic actual reconciliation event missing");
    await commands.acknowledge(context, prepared.id);
    return completed.reconciliationResult;
  }
  async function record(source: Awaited<ReturnType<typeof procurement.basis>>, options: Parameters<typeof procurement.record>[2] = {}) {
    const original = await procurement.record(source.invoice.id, source.invoiceLine.id, options);
    return execute(source.invoice.id, original.input);
  }
  async function review(invoiceId: string, adjustmentId: string, decision: "approved" | "rejected" = "approved") {
    const original = await procurement.review(invoiceId, adjustmentId, decision); return execute(invoiceId, original.input);
  }
  async function procurementBill(source: Awaited<ReturnType<typeof procurement.basis>>) {
    return bill(source.invoice.totalMinor, { kind: "procurement_invoice", procurementInvoiceId: source.invoice.id,
      externalBillId: source.invoice.invoiceNumber, currency: source.invoice.currency, issuedAt: source.invoice.issuedAt });
  }
  async function supplier() {
    const id = createEntityId();
    await withTenant(database.db, context, tx => tx.insert(fulfillmentSuppliers).values({ id, tenantId: context.tenantId,
      name: `Synthetic adjustment supplier ${id}`, kind: "manual", status: "active", regionCode: "US", settlementCurrency: "USD", createdBy: context.userId }));
    return id;
  }
  return { database, procurement, context, coworker, outsider, payables, adjustments, commands, initialize, rights, restoreRights,
    billInput, paymentInput, bill, payment, allocate, workspace, state, execute, record, review, procurementBill, supplier,
    destroy() { secret.fill(0); }, get supplierId() { return procurement.supplierId; } };
}
