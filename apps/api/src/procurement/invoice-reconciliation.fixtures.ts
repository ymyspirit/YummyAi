/** Actual synthetic procurement facts; all resources belong to the disposable runner. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { withTenant, inventorySupplierInvoiceLines, inventoryProcurementReceiptLines, type DatabaseConnection } from "@yummyai/database";
import { PrepareProcurementCommandSchema } from "@yummyai/contracts/procurement/procurement-command";
import { InvoiceReconciliationInputSchema, type InvoiceReconciliationInput } from "@yummyai/contracts/procurement/invoice-reconciliation";
import type { StockQuantity } from "@yummyai/contracts/inventory/quantity";
import { procurementCommandFixture, procurementFixtureKey, requireProcurementCommandFixture } from "./procurement-command.fixtures.js";
import { observeInvoiceProcess } from "./invoice-command.fixtures.js";
import { IncomingInspectionService } from "./incoming-inspection.service.js";
import { InvoiceReconciliationService } from "./invoice-reconciliation.service.js";

export function requireInvoiceReconciliationFixture() {
  requireProcurementCommandFixture();
  if (process.env.E2E_INVOICE_RECONCILIATION_ISOLATED !== "1") throw new Error("Invoice reconciliation requires its own disposable acceptance suite");
}
export const reconciliationKey = procurementFixtureKey;
export const reconciliationCode = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
export const protectedInvoiceTables = ["inventory_supplier_invoices", "inventory_supplier_invoice_lines", "inventory_supplier_invoice_requests",
  "inventory_supplier_invoice_allocations", "inventory_procurement_receipts", "inventory_procurement_receipt_lines", "inventory_purchase_order_versions",
  "inventory_lots", "inventory_movements", "inventory_balances", "inventory_procurement_write_requests"];
export const reconciliationFactTables = ["inventory_invoice_reconciliations", "inventory_invoice_allocation_effects"];

export function invoiceReconciliationFixture(database: DatabaseConnection) {
  requireInvoiceReconciliationFixture();
  const fixture = procurementCommandFixture(database), { context, owner, audit, inventory } = fixture;
  const incoming = new IncomingInspectionService(database, owner, audit), reconciliation = new InvoiceReconciliationService(database, audit);
  const standards = new Map<string, string>();
  async function receive(orderId: string, stockId: string, quantity: StockQuantity) {
    const at = (await fixture.clock()).toISOString();
    let standardId = standards.get(stockId);
    if (!standardId) {
      const standard = await incoming.publishStandard(context, { code: reconciliationCode("RECON-STD"), stockItemId: stockId, expectedVersion: 0,
        title: "Synthetic actual receiving observations", sourceReference: "Isolated supplier receiving observations; no supplier contact",
        criteria: [{ code: "WIDTH", label: "Synthetic width", kind: "numeric_range", unit: "mm", minimum: "9", maximum: "11" }], idempotencyKey: reconciliationKey() });
      standardId = standard.id; standards.set(stockId, standardId);
    }
    const arrival = await incoming.recordArrival(context, orderId, { code: reconciliationCode("RECON-ARR"), expectedPurchaseOrderVersion: 1,
      arrivedAt: at, externalReference: "Synthetic actual accepted material", lines: [{ lineKey: "LINE-1", quantity, unit: "gram",
        holdingLocationId: fixture.locationId, lotCode: reconciliationCode("RECON-LOT"), expiresAt: null }], idempotencyKey: reconciliationKey() });
    const line = arrival.lines[0]!;
    const inspection = await incoming.recordInspection(context, line.id, { expectedInspectionVersion: 0, standardVersionId: standardId,
      acceptedQuantity: quantity, rejectedQuantity: 0, sampleQuantity: quantity, rejectionReason: null, measuredAt: at,
      readings: [{ criterionCode: "WIDTH", value: "10", unit: "mm" }], notes: null, idempotencyKey: reconciliationKey() });
    const reviewed = await incoming.reviewInspection(context, line.id, { expectedInspectionVersion: 1, inspectionId: inspection.inspections[0]!.id,
      decision: "approved", reason: "Synthetic actual measurement checked", idempotencyKey: reconciliationKey() });
    const posted = await incoming.postInspection(context, line.id, { expectedInspectionVersion: 1, approvalId: reviewed.inspections[0]!.review!.id,
      acceptedQuantity: quantity, rejectedQuantity: 0, rejectionLocationId: null, ownershipConfirmation: "merchant_received", postedAt: at, idempotencyKey: reconciliationKey() });
    const receiptId = posted.postings[0]!.receiptId;
    const [receiptLine] = await withTenant(database.db, context, tx => tx.select().from(inventoryProcurementReceiptLines)
      .where(and(eq(inventoryProcurementReceiptLines.receiptId, receiptId), eq(inventoryProcurementReceiptLines.lineKey, "LINE-1"))));
    if (!receiptLine) throw new Error("Synthetic actual receipt line missing");
    return { arrival, posted, receiptLine };
  }
  async function basis(options: { received?: StockQuantity; invoiced?: StockQuantity; unitCostMinor?: number; currency?: string } = {}) {
    const code = reconciliationCode("RECON"), stock = await inventory.createStockItem(context, { code: `${code}-MAT`, name: "Synthetic reconciliation measured material", skuId: null, baseUnit: "gram" });
    const order = await owner.createPurchaseOrder(context, { code: `${code}-PO`, supplierId: fixture.supplierId, requisitionId: null, quoteId: null,
      currency: "USD", expectedAt: new Date((await fixture.clock()).getTime() + 86_400_000).toISOString(),
      lines: [{ lineKey: "LINE-1", stockItemId: stock.id, destinationLocationId: fixture.locationId, quantity: "0.25", unit: "kilogram", unitCostMinor: 1200, priceBasisQuantity: 1 }], idempotencyKey: reconciliationKey() });
    await owner.reviewPurchaseOrder(context, order.id, { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC", idempotencyKey: reconciliationKey() });
    const receipt = await receive(order.id, stock.id, options.received ?? 200);
    const original = { expectedVersion: 1, invoiceNumber: reconciliationCode("RECON-INV"), currency: options.currency ?? "USD", issuedAt: (await fixture.clock()).toISOString(),
      lines: [{ lineKey: "LINE-1", invoicedQuantity: options.invoiced ?? "0.2", unitCostMinor: options.unitCostMinor ?? 1200, priceBasisQuantity: 1 }], idempotencyKey: reconciliationKey() };
    const invoice = await owner.recordInvoice(context, order.id, original);
    const [invoiceLine] = await withTenant(database.db, context, tx => tx.select().from(inventorySupplierInvoiceLines).where(eq(inventorySupplierInvoiceLines.invoiceId, invoice.id)));
    if (!invoiceLine) throw new Error("Synthetic actual invoice line missing");
    return { code, order, stock, receipt, invoice, invoiceLine, original };
  }
  async function record(invoiceId: string, invoiceLineId: string, options: { kind?: "credit_note" | "debit_note"; quantity?: StockQuantity; amountMinor?: number; currency?: string; number?: string } = {}) {
    const detail = await reconciliation.detail(context, invoiceId);
    return original(invoiceId, { action: "adjustment_record", expectedFingerprint: detail.fingerprint, reason: "Synthetic supplier correction recorded for approval",
      idempotencyKey: reconciliationKey(), document: { kind: options.kind ?? "credit_note", number: options.number ?? reconciliationCode("ADJUSTMENT"),
        issuedAt: (await fixture.clock()).toISOString(), currency: options.currency ?? detail.balance.currency,
        evidenceReference: "Synthetic supplier document reference; local entry does not verify external authenticity or payment" },
      lines: [{ invoiceLineId, quantity: options.quantity ?? 0, unit: "kilogram", amountMinor: options.amountMinor ?? 20 }] });
  }
  async function review(invoiceId: string, adjustmentId: string, decision: "approved" | "rejected" = "approved") {
    const detail = await reconciliation.detail(context, invoiceId);
    return original(invoiceId, { action: "adjustment_review", expectedFingerprint: detail.fingerprint, adjustmentId, decision,
      reason: "Synthetic current authority checked the original supplier correction", idempotencyKey: reconciliationKey() });
  }
  async function match(invoiceId: string, invoiceLineId: string, receiptLineId: string, quantity: StockQuantity) {
    const detail = await reconciliation.detail(context, invoiceId);
    return original(invoiceId, { action: "receipt_match", expectedFingerprint: detail.fingerprint,
      reason: "Synthetic later actual accepted receipt checked", idempotencyKey: reconciliationKey(), lines: [{ invoiceLineId, receiptLineId, quantity, unit: "kilogram" }] });
  }
  function original(invoiceId: string, input: InvoiceReconciliationInput) {
    const parsed = PrepareProcurementCommandSchema.parse({ kind: "invoice_reconcile", targetId: invoiceId, input: InvoiceReconciliationInputSchema.parse(input) });
    if (parsed.kind !== "invoice_reconcile") throw new Error("Unexpected synthetic reconciliation command kind");
    return parsed;
  }
  async function state(tables = [...protectedInvoiceTables, ...reconciliationFactTables]) {
    return withTenant(database.db, context, async tx => {
      const result: Record<string, { count: number; digest: string }> = {};
      for (const table of tables) {
        const rows = await tx.execute(sql`select * from ${sql.identifier(table)} order by id`);
        result[table] = { count: rows.length, digest: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
      }
      return result;
    });
  }
  return { ...fixture, reconciliation, incoming, basis, receive, record, review, match, original, state,
    get supplierId() { return fixture.supplierId; }, get locationId() { return fixture.locationId; } };
}
export type ReconciliationFixture = ReturnType<typeof invoiceReconciliationFixture>;
export type ReconciliationOriginal = ReturnType<ReconciliationFixture["original"]>;
export type ReconciliationProcess = ReturnType<typeof observeInvoiceProcess>;
export function startReconciliationApi(identity: { baseUrl: string }, key: Buffer, options: { phase?: "before_commit" | "after_commit"; commandId?: string } = {}) {
  requireInvoiceReconciliationFixture();
  if (process.env.E2E_PROCUREMENT_PROCESS_ISOLATED !== "1") throw new Error("Reconciliation process acceptance requires the actual process guard");
  return observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "../../tools/testing/invoice-reconciliation-api-process-fixture.mts"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env,
      TSX_DISABLE_CACHE: "1", NODE_ENV: "test", OIDC_ISSUER: identity.baseUrl, OIDC_JWKS_URI: `${identity.baseUrl}/protocol/openid-connect/certs`,
      PROCUREMENT_COMMAND_ENCRYPTION_KEY: key.toString("base64url"), PROCUREMENT_FIXTURE_GATE: options.phase ?? "none", PROCUREMENT_FIXTURE_ACTION: "execute",
      PROCUREMENT_FIXTURE_COMMAND_ID: options.commandId } }));
}
