import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { ProcurementCommandViewSchema } from "@yummyai/contracts/procurement/procurement-command";
import { InvoiceReconciliationBalanceSchema, type InvoiceReconciliationBalance, type InvoiceReconciliationInput } from "@yummyai/contracts/procurement/invoice-reconciliation";
import { sumStockQuantities } from "@yummyai/contracts/inventory/quantity";
import { connectDatabase, migrateDatabase, withTenant, procurementCommands, invoiceReconciliations, invoiceAllocationEffects,
  inventorySupplierInvoices, inventorySupplierInvoiceLines } from "@yummyai/database";
import { startFactoryIdentityFixture } from "../../../../tools/testing/factory-identity-fixture.mjs";
import { ProcurementCommandService } from "./procurement-command.service.js";
import { procurementFixturePermissions } from "./procurement-command.fixtures.js";
import { invoiceReconciliationFixture, requireInvoiceReconciliationFixture, protectedInvoiceTables, reconciliationFactTables,
  reconciliationKey, startReconciliationApi, type ReconciliationOriginal, type ReconciliationProcess } from "./invoice-reconciliation.fixtures.js";

requireInvoiceReconciliationFixture();

describe.sequential("actual immutable supplier corrections, reviews and later receipt matching", () => {
  const database = connectDatabase(), fixture = invoiceReconciliationFixture(database);
  const { context, coworker, outsider, owner, audit, reconciliation } = fixture;
  const key = randomBytes(32), commands = new ProcurementCommandService(database, new SecretVault(key), owner, audit);
  const owned = new Map<string, TenantContext>(), children: ReconciliationProcess[] = [];
  let identity: Awaited<ReturnType<typeof startFactoryIdentityFixture>> | undefined;
  beforeAll(async () => { await migrateDatabase(database); await fixture.initialize(); }, 60_000);
  afterEach(async () => {
    const stopped = await Promise.allSettled(children.map(child => child.stop(true))); vi.restoreAllMocks();
    await fixture.setPermissions(context, procurementFixturePermissions); await fixture.setPermissions(coworker, procurementFixturePermissions);
    for (const [id, current] of owned) {
      const value = await commands.get(current, id);
      if (value.status === "prepared") await commands.cancel(current, id);
      if (!value.acknowledged) await commands.acknowledge(current, id);
    }
    owned.clear();
    if (stopped.some(result => result.status === "rejected")) throw new Error("Reconciliation API process cleanup incomplete");
  }, 60_000);
  afterAll(async () => {
    try {
      const stopped = await Promise.allSettled(children.map(child => child.stop(true))); await identity?.close();
      if (stopped.some(result => result.status === "rejected") || children.some(child => child.child.exitCode === null && child.child.signalCode === null))
        throw new Error("Reconciliation API process remained active");
      process.stdout.write(JSON.stringify({ type: "invoice.reconciliation.process.cleanup", pids: children.map(child => child.child.pid), allExited: true }) + "\n");
    } finally { key.fill(0); await database.client.end(); }
  }, 30_000);
  async function prepare(original: ReconciliationOriginal, current = context) {
    const value = await commands.prepare(current, original); owned.set(value.id, current); return value;
  }
  async function actual(original: ReconciliationOriginal, current = context) {
    const saved = await prepare(original, current), result = await commands.execute(current, saved.id);
    expect(result.status).toBe("succeeded"); expect(result.result).toEqual({ kind: "invoice_reconcile", id: result.reconciliationResult!.id, versionId: null, version: null });
    await commands.acknowledge(current, saved.id); owned.delete(saved.id); return result.reconciliationResult!;
  }
  async function row(id: string) {
    const [value] = await withTenant(database.db, context, tx => tx.select().from(procurementCommands).where(eq(procurementCommands.id, id)));
    expect(value).toBeDefined(); return value!;
  }
  const protectedOriginal = (value: Awaited<ReturnType<typeof row>>) => ({ id: value.id, kind: value.kind, operation: value.operation, targetId: value.targetId,
    createdBy: value.createdBy, requestKey: value.requestKey, requestChecksum: value.requestChecksum, encryptedInput: value.encryptedInput,
    authoritySnapshot: value.authoritySnapshot, createdAt: value.createdAt, expiresAt: value.expiresAt, contractVersion: value.contractVersion });
  const detail = (id: string) => reconciliation.detail(context, id);
  async function effects(invoiceId: string) {
    return withTenant(database.db, context, tx => tx.select().from(invoiceAllocationEffects).innerJoin(invoiceReconciliations,
      eq(invoiceReconciliations.id, invoiceAllocationEffects.eventId)).where(eq(invoiceReconciliations.invoiceId, invoiceId)));
  }
  const conflict = (code: string) => ({ status: 409, response: expect.objectContaining({ code }) });
  const pgFailure = (error: unknown) => {
    const value = error as { code?: string; message?: string; cause?: { code?: string; message?: string } };
    return value.cause?.code ? value.cause : value;
  };
  async function rawEvent(original: ReconciliationOriginal, preparedId: string, options: { input?: InvoiceReconciliationInput; balance?: InvoiceReconciliationBalance; outcome?: () => void } = {}) {
    const basis = await detail(original.targetId), prepared = await row(preparedId), input = options.input ?? original.input;
    return withTenant(database.db, context, async tx => {
      await tx.execute(sql`select set_config('app.procurement_command_id',${preparedId},true)`);
      const id = createEntityId();
      await tx.insert(invoiceReconciliations).values({ id, tenantId: context.tenantId, invoiceId: basis.invoiceId, originalProofId: basis.originalProofId!,
        purchaseOrderId: basis.purchaseOrderId, purchaseOrderVersionId: basis.purchaseOrderVersionId!, supplierId: basis.supplierId,
        sequence: basis.events.length + 1, previousId: basis.events.at(-1)?.id ?? null, adjustmentId: input.action === "adjustment_review" ? input.adjustmentId : null,
        action: input.action, input, balance: options.balance ?? basis.balance,
        documentKey: input.action === "adjustment_record" ? `${input.document.kind}:${input.document.number.trim().toLowerCase()}` : null,
        requestKey: input.idempotencyKey, requestChecksum: prepared.requestChecksum, createdBy: context.userId, creationTransactionId: sql`pg_current_xact_id()::text` });
      await tx.update(procurementCommands).set({ status: "succeeded", reconciliationResultProofId: id, completedAt: sql`clock_timestamp()` }).where(eq(procurementCommands.id, preparedId));
      options.outcome?.();
    });
  }

  it("prepares only private original evidence and records a pending document without applying money or quantity", async () => {
    const b = await fixture.basis({ unitCostMinor: 1300 }), before = await fixture.state(), original = await fixture.record(b.invoice.id, b.invoiceLine.id);
    const prepared = await prepare(original), saved = await row(prepared.id);
    expect(prepared).toMatchObject({ kind: "invoice_reconcile", targetId: b.invoice.id, status: "prepared", original, reconciliationResult: null, result: null });
    expect(saved.encryptedInput).not.toContain(original.input.idempotencyKey); expect(await fixture.state()).toEqual(before);
    const done = await commands.execute(context, prepared.id), pending = await detail(b.invoice.id);
    expect(done.reconciliationResult).toMatchObject({ action: "adjustment_record", input: original.input, createdBy: context.userId });
    expect(pending.adjustments).toMatchObject([{ status: "pending", document: { kind: "credit_note" }, reviewId: null }]);
    expect(pending.balance).toMatchObject({ netAmountMinor: 260, varianceMinor: 20, lines: [{ creditedQuantity: 0, allocatedQuantity: "0.2" }] });
    expect(await effects(b.invoice.id)).toEqual([]); expect(await fixture.state(protectedInvoiceTables)).toEqual(Object.fromEntries(protectedInvoiceTables.map(table => [table, before[table]])));
    expect(saved.reconciliationResultProofId).toBeNull(); const committed = await row(prepared.id);
    expect(committed.reconciliationResultProofId).toBe(done.result!.id); expect(committed.resultProofId).toBeNull(); expect(committed.invoiceResultProofId).toBeNull();
  });

  it("approves partial amount credits to close the current balance while retaining original mismatch facts", async () => {
    const b = await fixture.basis({ unitCostMinor: 1300 }), protectedFacts = await fixture.state(protectedInvoiceTables);
    for (const [amount, remaining] of [[12, 8], [8, 0]] as const) {
      const recorded = await actual(await fixture.record(b.invoice.id, b.invoiceLine.id, { amountMinor: amount }));
      expect((await detail(b.invoice.id)).balance.varianceMinor).toBe(remaining + amount);
      const reviewed = await actual(await fixture.review(b.invoice.id, recorded.id));
      expect(reviewed.balance).toMatchObject({ varianceMinor: remaining, netAmountMinor: 240 + remaining, status: remaining === 0 ? "matched" : "reconciliation_required" });
    }
    const value = await detail(b.invoice.id); expect(value.originalStatus).toBe("reconciliation_required");
    expect(value.balance.lines[0]).toMatchObject({ originalAmountMinor: 260, creditAmountMinor: 20, netAmountMinor: 240, allocatedQuantity: "0.2" });
    expect(await fixture.state(protectedInvoiceTables)).toEqual(protectedFacts); expect(await effects(b.invoice.id)).toEqual([]);
  });

  it("releases only approved actual quantity and lets a new actual invoice use that capacity once without changing stock", async () => {
    const b = await fixture.basis(), originalFacts = await fixture.state(protectedInvoiceTables);
    const recorded = await actual(await fixture.record(b.invoice.id, b.invoiceLine.id, { quantity: "0.1", amountMinor: 120 }));
    expect((await detail(b.invoice.id)).balance.lines[0]!.allocatedQuantity).toBe("0.2"); expect(await effects(b.invoice.id)).toEqual([]);
    await actual(await fixture.review(b.invoice.id, recorded.id));
    const released = await effects(b.invoice.id); expect(released).toHaveLength(1);
    expect(released[0]!.inventory_invoice_allocation_effects).toMatchObject({ kind: "release", quantity: "0.1", unit: "kilogram", sourceEffectId: null });
    expect(released[0]!.inventory_invoice_allocation_effects.sourceAllocationId).not.toBeNull();
    expect((await detail(b.invoice.id)).balance).toMatchObject({ status: "matched", netAmountMinor: 120, varianceMinor: 0, lines: [{ netQuantity: "0.1", allocatedQuantity: "0.1" }] });
    expect(await fixture.state(protectedInvoiceTables)).toEqual(originalFacts);
    const make = () => ({ ...b.original, invoiceNumber: `REPLACEMENT-${createEntityId()}`, lines: [{ ...b.original.lines[0]!, invoicedQuantity: "0.1" }], idempotencyKey: reconciliationKey() });
    const next = await owner.recordInvoice(context, b.order.id, make()), excess = await owner.recordInvoice(context, b.order.id, make());
    expect(next).toMatchObject({ status: "matched", totalMinor: 120, lines: [{ allocatedQuantity: "0.1" }] });
    expect(excess).toMatchObject({ status: "reconciliation_required", varianceMinor: 120, lines: [{ allocatedQuantity: 0 }] });
    expect(await fixture.state(["inventory_lots", "inventory_movements", "inventory_balances"])).toEqual(Object.fromEntries(["inventory_lots", "inventory_movements", "inventory_balances"].map(table => [table, originalFacts[table]])));
  });

  it("credits the unallocated original claim first and never releases another invoice's accepted quantity", async () => {
    const b = await fixture.basis({ invoiced: "0.3" }), protectedFacts = await fixture.state(protectedInvoiceTables);
    const recorded = await actual(await fixture.record(b.invoice.id, b.invoiceLine.id, { quantity: "0.1", amountMinor: 120 }));
    await actual(await fixture.review(b.invoice.id, recorded.id));
    expect((await detail(b.invoice.id)).balance).toMatchObject({ status: "matched", netAmountMinor: 240, varianceMinor: 0,
      lines: [{ creditedQuantity: "0.1", netQuantity: "0.2", allocatedQuantity: "0.2", unallocatedQuantity: 0 }] });
    expect(await effects(b.invoice.id)).toEqual([]); expect(await fixture.state(protectedInvoiceTables)).toEqual(protectedFacts);
    const extra = await owner.recordInvoice(context, b.order.id, { ...b.original, invoiceNumber: `EXTRA-${createEntityId()}`,
      lines: [{ ...b.original.lines[0]!, invoicedQuantity: "0.1" }], idempotencyKey: reconciliationKey() });
    expect(extra).toMatchObject({ status: "reconciliation_required", lines: [{ allocatedQuantity: 0 }] });
  });

  it("records a pure amount debit without allocating the same received quantity twice", async () => {
    const b = await fixture.basis({ unitCostMinor: 1000 }), before = await fixture.state(protectedInvoiceTables);
    const recorded = await actual(await fixture.record(b.invoice.id, b.invoiceLine.id, { kind: "debit_note", amountMinor: 40, quantity: 0 }));
    expect((await detail(b.invoice.id)).balance.varianceMinor).toBe(-40); await actual(await fixture.review(b.invoice.id, recorded.id));
    expect((await detail(b.invoice.id)).balance).toMatchObject({ status: "matched", netAmountMinor: 240, varianceMinor: 0,
      lines: [{ originalQuantity: "0.2", netQuantity: "0.2", allocatedQuantity: "0.2", debitAmountMinor: 40 }] });
    expect(await effects(b.invoice.id)).toEqual([]); expect(await fixture.state(protectedInvoiceTables)).toEqual(before);
  });

  it("adds an actual later accepted receipt match without modifying the original invoice or its 149 allocations", async () => {
    const b = await fixture.basis({ invoiced: "0.25" }); expect((await detail(b.invoice.id)).balance.varianceMinor).toBe(60);
    const later = await fixture.receive(b.order.id, b.stock.id, 50), before = await fixture.state(protectedInvoiceTables);
    const original = await fixture.match(b.invoice.id, b.invoiceLine.id, later.receiptLine.id, "0.05"), result = await actual(original);
    expect(result.balance).toMatchObject({ status: "matched", netAmountMinor: 300, varianceMinor: 0,
      lines: [{ originalQuantity: "0.25", allocatedQuantity: "0.25", unallocatedQuantity: 0 }] });
    const rows = await effects(b.invoice.id); expect(rows).toHaveLength(1);
    expect(rows[0]!.inventory_invoice_allocation_effects).toMatchObject({ kind: "consume", quantity: "0.05", receiptLineId: later.receiptLine.id, sourceAllocationId: null, sourceEffectId: null });
    expect(await fixture.state(protectedInvoiceTables)).toEqual(before);
    const originalInvoice = await withTenant(database.db, context, tx => tx.select().from(inventorySupplierInvoices).where(eq(inventorySupplierInvoices.id, b.invoice.id)));
    expect(originalInvoice[0]).toMatchObject({ varianceMinor: 60, status: "reconciliation_required" });
  });

  it("keeps an almost integral large later receipt value unknown instead of rounding it to a minor unit", async () => {
    const basis = "9007199.254740991", received = "9007199.25474099", cost = 9007199254740990, code = `EXACT-${createEntityId().toUpperCase()}`;
    // N=9007199254740991: the later value is (N-1)^2/N=N-2+1/N.
    // The remainder is real even if a finite-scale numeric division rounds it away.
    const stock = await fixture.inventory.createStockItem(context, { code: `${code}-MAT`, name: "Synthetic exact minor remainder material", skuId: null, baseUnit: "gram" });
    const order = await owner.createPurchaseOrder(context, { code: `${code}-PO`, supplierId: fixture.supplierId, requisitionId: null, quoteId: null,
      currency: "USD", expectedAt: new Date((await fixture.clock()).getTime() + 86_400_000).toISOString(),
      lines: [{ lineKey: "LINE-1", stockItemId: stock.id, destinationLocationId: fixture.locationId, quantity: basis, unit: "gram", unitCostMinor: cost, priceBasisQuantity: basis }],
      idempotencyKey: reconciliationKey() });
    await owner.reviewPurchaseOrder(context, order.id, { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC", idempotencyKey: reconciliationKey() });
    const invoice = await owner.recordInvoice(context, order.id, { expectedVersion: 1, invoiceNumber: `${code}-INV`, currency: "USD", issuedAt: (await fixture.clock()).toISOString(),
      lines: [{ lineKey: "LINE-1", invoicedQuantity: basis, unitCostMinor: cost, priceBasisQuantity: basis }], idempotencyKey: reconciliationKey() });
    expect(invoice).toMatchObject({ totalMinor: cost, varianceMinor: cost, lines: [{ allocatedQuantity: 0 }] });
    const [line] = await withTenant(database.db, context, tx => tx.select().from(inventorySupplierInvoiceLines).where(eq(inventorySupplierInvoiceLines.invoiceId, invoice.id)));
    expect(line).toBeDefined(); const later = await fixture.receive(order.id, stock.id, received), before = await fixture.state(protectedInvoiceTables);
    const original = fixture.original(invoice.id, { action: "receipt_match", expectedFingerprint: (await detail(invoice.id)).fingerprint,
      reason: "Synthetic exact fractional minor remainder must remain unknown", idempotencyKey: reconciliationKey(),
      lines: [{ invoiceLineId: line!.id, receiptLineId: later.receiptLine.id, quantity: received, unit: "gram" }] });
    const result = await actual(original);
    expect(result.balance).toMatchObject({ status: "unknown", netAmountMinor: cost, varianceMinor: null, unknownReasons: ["price_basis_unrepresentable"],
      lines: [{ originalQuantity: basis, allocatedQuantity: received, unallocatedQuantity: "0.000000001", expectedAmountMinor: null, varianceMinor: null }] });
    expect((await detail(invoice.id)).balance).toEqual(result.balance);
    const rows = await effects(invoice.id); expect(rows).toHaveLength(1);
    expect(rows[0]!.inventory_invoice_allocation_effects).toMatchObject({ kind: "consume", quantity: received, receiptLineId: later.receiptLine.id });
    expect(await fixture.state(protectedInvoiceTables)).toEqual(before);
  });

  it("binds a later quantity release to its concrete consume effect", async () => {
    const b = await fixture.basis({ invoiced: "0.25" }), later = await fixture.receive(b.order.id, b.stock.id, 50);
    await actual(await fixture.match(b.invoice.id, b.invoiceLine.id, later.receiptLine.id, "0.05"));
    const prior = (await effects(b.invoice.id)).find(row => row.inventory_invoice_allocation_effects.kind === "consume")!.inventory_invoice_allocation_effects;
    const recorded = await actual(await fixture.record(b.invoice.id, b.invoiceLine.id, { quantity: "0.25", amountMinor: 300 }));
    await actual(await fixture.review(b.invoice.id, recorded.id));
    const released = (await effects(b.invoice.id)).map(row => row.inventory_invoice_allocation_effects).filter(row => row.kind === "release");
    expect(sumStockQuantities(released.map(row => row.quantity))).toBe("0.25");
    expect(released.find(row => row.sourceEffectId === prior.id)).toMatchObject({ receiptLineId: later.receiptLine.id, quantity: "0.05", sourceAllocationId: null });
    expect((await detail(b.invoice.id)).balance).toMatchObject({ status: "fully_credited", netAmountMinor: 0, lines: [{ netQuantity: 0, allocatedQuantity: 0 }] });
  });

  it("leaves rejected evidence and quantities without financial effects and prevents rereview", async () => {
    const b = await fixture.basis(), recorded = await actual(await fixture.record(b.invoice.id, b.invoiceLine.id, { quantity: "0.1", amountMinor: 120 }));
    await actual(await fixture.review(b.invoice.id, recorded.id, "rejected"));
    expect((await detail(b.invoice.id)).adjustments).toMatchObject([{ status: "rejected", reviewedBy: context.userId }]);
    expect((await detail(b.invoice.id)).balance).toMatchObject({ netAmountMinor: 240, lines: [{ creditedQuantity: 0, allocatedQuantity: "0.2" }] });
    expect(await effects(b.invoice.id)).toEqual([]);
    await expect(prepare(await fixture.review(b.invoice.id, recorded.id))).rejects.toMatchObject(conflict("invoice_reconciliation_adjustment_reviewed"));
  });

  it("rejects stale review fingerprints while preserving the prepared original and all unapproved balances", async () => {
    const b = await fixture.basis({ unitCostMinor: 1300 }), first = await actual(await fixture.record(b.invoice.id, b.invoiceLine.id, { amountMinor: 12 }));
    const original = await fixture.review(b.invoice.id, first.id), pending = await prepare(original), preserved = protectedOriginal(await row(pending.id));
    await actual(await fixture.record(b.invoice.id, b.invoiceLine.id, { amountMinor: 8 }), coworker);
    const before = await fixture.state();
    await expect(commands.execute(context, pending.id)).rejects.toMatchObject(conflict("invoice_reconciliation_basis_changed"));
    expect(protectedOriginal(await row(pending.id))).toEqual(preserved); expect(await fixture.state()).toEqual(before);
    expect((await commands.get(context, pending.id)).blockReason).toBe("basis_changed"); expect((await detail(b.invoice.id)).balance.varianceMinor).toBe(20);
  });

  it("does not let another key or invoice consume a supplier document number again", async () => {
    const b = await fixture.basis(), other = await fixture.basis(), original = await fixture.record(b.invoice.id, b.invoiceLine.id, { number: "SYNTHETIC-CREDIT-UNIQUE" });
    await actual(original);
    await expect(prepare(await fixture.record(other.invoice.id, other.invoiceLine.id, { number: " synthetic-credit-unique " })))
      .rejects.toMatchObject(conflict("invoice_reconciliation_document_duplicate"));
    const duplicate = { ...original, input: { ...original.input, idempotencyKey: reconciliationKey(), expectedFingerprint: (await detail(b.invoice.id)).fingerprint } };
    await expect(prepare(duplicate)).rejects.toMatchObject(conflict("invoice_reconciliation_document_duplicate"));
    const debit = await fixture.record(other.invoice.id, other.invoiceLine.id, { kind: "debit_note", number: "SYNTHETIC-CREDIT-UNIQUE" });
    expect((await actual(debit)).action).toBe("adjustment_record");
  });

  it("binds one retained original to its exact actor, invoice, document and nine-place quantities", async () => {
    const b = await fixture.basis(), other = await fixture.basis(), original = await fixture.record(b.invoice.id, b.invoiceLine.id, { quantity: "0.1", amountMinor: 120 });
    const prepared = await prepare(original), saved = protectedOriginal(await row(prepared.id));
    if (original.input.action !== "adjustment_record") throw new Error("Unexpected synthetic correction action");
    const changed = { ...original, input: { ...original.input, lines: [{ ...original.input.lines[0]!, quantity: "0.100000001" }] } };
    for (const mutation of [changed, { ...original, targetId: other.invoice.id }])
      await expect(prepare(mutation)).rejects.toMatchObject(conflict("procurement_original_mismatch"));
    await expect(prepare(original, coworker)).rejects.toMatchObject({ status: 409 });
    const normalized = { ...original, input: { ...original.input, lines: [{ ...original.input.lines[0]!, quantity: "0.100000000" }] } };
    expect((await prepare(normalized)).id).toBe(prepared.id); expect(protectedOriginal(await row(prepared.id))).toEqual(saved);
  });

  it("rechecks approval separately from writing and keeps other actors and tenants outside private originals", async () => {
    const b = await fixture.basis(), recorded = await actual(await fixture.record(b.invoice.id, b.invoiceLine.id));
    const prepared = await prepare(await fixture.review(b.invoice.id, recorded.id));
    await fixture.setPermissions(context, procurementFixturePermissions.filter(permission => permission !== Permission.ProcurementApprove));
    await expect(commands.execute(context, prepared.id)).rejects.toMatchObject({ status: 403 });
    expect((await detail(b.invoice.id)).adjustments[0]!.status).toBe("pending");
    await expect(commands.get(coworker, prepared.id)).rejects.toMatchObject({ status: 404 });
    await expect(reconciliation.detail(outsider, b.invoice.id)).rejects.toMatchObject({ status: 404 });
    const foreign = await withTenant(database.db, outsider, tx => tx.select().from(invoiceReconciliations).where(eq(invoiceReconciliations.invoiceId, b.invoice.id)));
    expect(foreign).toEqual([]);
    await fixture.setPermissions(context, procurementFixturePermissions);
    const succeeded = await commands.execute(context, prepared.id);
    expect(succeeded.reconciliationResult).toMatchObject({ action: "adjustment_review", createdBy: context.userId });
    const tables = [...protectedInvoiceTables, ...reconciliationFactTables, "inventory_procurement_commands", "audit_events"], before = await fixture.state(tables);
    await fixture.setPermissions(context, procurementFixturePermissions.filter(permission => permission !== Permission.ProcurementApprove));
    const recovered = await commands.execute(context, prepared.id);
    expect(recovered).toMatchObject({ id: prepared.id, status: "succeeded", canExecute: false, result: succeeded.result });
    expect(recovered.reconciliationResult).toEqual(succeeded.reconciliationResult); expect(await fixture.state(tables)).toEqual(before);
  });

  it("serializes two current reviews without double releasing or hiding a stale decision", async () => {
    const b = await fixture.basis(), recorded = await actual(await fixture.record(b.invoice.id, b.invoiceLine.id, { quantity: "0.1", amountMinor: 120 }));
    const first = await fixture.review(b.invoice.id, recorded.id), second = { ...first, input: { ...first.input, idempotencyKey: reconciliationKey() } };
    const a = await prepare(first), z = await prepare(second, coworker);
    const results = await Promise.allSettled([commands.execute(context, a.id), commands.execute(coworker, z.id)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409 });
    expect(sumStockQuantities((await effects(b.invoice.id)).map(row => row.inventory_invoice_allocation_effects.quantity))).toBe("0.1");
    expect((await detail(b.invoice.id)).adjustments[0]!.status).toBe("approved");
  });

  it("lets a concurrent later match or new actual invoice occupy a received remainder, never both", async () => {
    const b = await fixture.basis({ invoiced: "0.25" }), later = await fixture.receive(b.order.id, b.stock.id, 50);
    const prepared = await prepare(await fixture.match(b.invoice.id, b.invoiceLine.id, later.receiptLine.id, "0.05"));
    const results = await Promise.allSettled([commands.execute(context, prepared.id), owner.recordInvoice(context, b.order.id, { ...b.original,
      invoiceNumber: `CONCURRENT-${createEntityId()}`, lines: [{ ...b.original.lines[0]!, invoicedQuantity: "0.05" }], idempotencyKey: reconciliationKey() })]);
    const direct = results[1]; expect(direct.status).toBe("fulfilled");
    if (direct.status !== "fulfilled") throw new Error("Synthetic actual concurrent invoice failed");
    const consumed = (await effects(b.invoice.id)).map(row => row.inventory_invoice_allocation_effects).filter(row => row.kind === "consume");
    const total = sumStockQuantities([direct.value.lines![0]!.allocatedQuantity!, ...consumed.map(row => row.quantity)]); expect(total).toBe("0.05");
    if (results[0]!.status === "rejected") expect(results[0]!.reason).toMatchObject({ status: 409 });
    else expect(direct.value.status).toBe("reconciliation_required");
  });

  it.each(["procurement.invoice.reconcile", "procurement.command.execute"])("rolls facts, effects and outcome back on final %s audit failure", async action => {
    const b = await fixture.basis(), pending = await actual(await fixture.record(b.invoice.id, b.invoiceLine.id, { quantity: "0.1", amountMinor: 120 }));
    const prepared = await prepare(await fixture.review(b.invoice.id, pending.id));
    const before = await fixture.state([...protectedInvoiceTables, ...reconciliationFactTables, "inventory_procurement_commands", "audit_events"]);
    const record = audit.recordInTransaction.bind(audit);
    vi.spyOn(audit, "recordInTransaction").mockImplementation(async (tx, current, event) => {
      if (event.action === action) throw new Error("Synthetic final reconciliation audit unavailable");
      return record(tx, current, event);
    });
    await expect(commands.execute(context, prepared.id)).rejects.toThrow("Synthetic final reconciliation audit unavailable");
    expect(await fixture.state(Object.keys(before))).toEqual(before); vi.restoreAllMocks();
    expect((await commands.execute(context, prepared.id)).reconciliationResult!.balance.lines[0]!.netQuantity).toBe("0.1");
  });

  it("rejects a real owner event whose command success outcome is omitted at commit", async () => {
    const b = await fixture.basis(), original = await fixture.record(b.invoice.id, b.invoiceLine.id), prepared = await prepare(original), before = await fixture.state();
    let actualFactReturned = false;
    await expect(withTenant(database.db, context, async tx => {
      await tx.execute(sql`select set_config('app.procurement_command_id',${prepared.id},true)`);
      const id = await reconciliation.executeInTransaction(tx, context, original.targetId, original.input);
      const [fact] = await tx.select().from(invoiceReconciliations).where(eq(invoiceReconciliations.id, id)); actualFactReturned = Boolean(fact);
    })).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("reconciliation fact and original command outcome must commit together") });
    expect(actualFactReturned).toBe(true); expect(await fixture.state()).toEqual(before); expect((await commands.get(context, prepared.id)).status).toBe("prepared");
  });

  it("physically rejects a changed raw body even when its prepared key and copied checksum are genuine", async () => {
    const b = await fixture.basis(), original = await fixture.record(b.invoice.id, b.invoiceLine.id), prepared = await prepare(original), before = await fixture.state();
    await expect(rawEvent(original, prepared.id, { input: { ...original.input, reason: "Different but otherwise valid supplier correction evidence" } }))
      .rejects.toSatisfy((error: unknown) => { const value = pgFailure(error); return value.code === "23514" && Boolean(value.message?.includes("original request checksum")); });
    expect(await fixture.state()).toEqual(before); expect((await row(prepared.id)).status).toBe("prepared");
  });

  it("binds real Unicode, quotes, newlines and equivalent ISO dates through the SQL original request checksum", async () => {
    const b = await fixture.basis(), base = await fixture.record(b.invoice.id, b.invoiceLine.id, { number: "供应商-CN-\"quoted\"-001" });
    if (base.input.action !== "adjustment_record") throw new Error("Unexpected synthetic correction action");
    const original = { ...base, input: { ...base.input, reason: "原供应商\"价格\"凭据\n第二行 CNY/USD 不是自动汇率",
      document: { ...base.input.document, issuedAt: "2026-10-20T01:02:03Z", evidenceReference: "档案\\目录/凭据\"CN\"\n合成单据 未经外部验真" } } };
    const saved = await prepare(original), normalized = await prepare({ ...original, input: { ...original.input, document: { ...original.input.document, issuedAt: "2026-10-20T01:02:03.000Z" } } });
    expect(normalized.id).toBe(saved.id);
    const executed = await commands.execute(context, saved.id); expect(executed.reconciliationResult!.input).toEqual(original.input);
    expect((await row(saved.id)).reconciliationResultProofId).toBe(executed.result!.id);
  });

  it("physically rejects an internally coherent matched balance invented for an unapproved actual document", async () => {
    const b = await fixture.basis({ unitCostMinor: 1300 }), original = await fixture.record(b.invoice.id, b.invoiceLine.id), prepared = await prepare(original);
    const before = await fixture.state(), actualBalance = (await detail(b.invoice.id)).balance;
    const forged = InvoiceReconciliationBalanceSchema.parse({ ...actualBalance, status: "matched", netAmountMinor: 240, varianceMinor: 0,
      lines: actualBalance.lines.map(line => ({ ...line, creditAmountMinor: 20, netAmountMinor: 240, varianceMinor: 0 })) });
    let commandOutcomeWritten = false;
    await expect(rawEvent(original, prepared.id, { balance: forged, outcome: () => { commandOutcomeWritten = true; } }))
      .rejects.toMatchObject({ code: "23514", message: expect.stringContaining("reconciliation execution balance differs from actual line facts") });
    expect(commandOutcomeWritten).toBe(true); expect(await fixture.state()).toEqual(before); expect((await row(prepared.id)).status).toBe("prepared");
  });

  it.each(["consume", "release"] as const)("physically rejects raw excessive %s effects inside a legitimate current owner transaction", async kind => {
    const b = await fixture.basis({ invoiced: kind === "consume" ? "0.25" : "0.2" });
    let original: ReconciliationOriginal;
    if (kind === "consume") { const later = await fixture.receive(b.order.id, b.stock.id, 50); original = await fixture.match(b.invoice.id, b.invoiceLine.id, later.receiptLine.id, "0.05"); }
    else { const pending = await actual(await fixture.record(b.invoice.id, b.invoiceLine.id, { quantity: "0.1", amountMinor: 120 })); original = await fixture.review(b.invoice.id, pending.id); }
    const prepared = await prepare(original), before = await fixture.state(), record = audit.recordInTransaction.bind(audit); let reachedCapacity = false;
    vi.spyOn(audit, "recordInTransaction").mockImplementation(async (tx, current, event) => {
      const result = await record(tx, current, event);
      if (event.action === "procurement.invoice.reconcile" && event.resourceId) {
        const [effect] = await tx.select().from(invoiceAllocationEffects).where(and(eq(invoiceAllocationEffects.eventId, event.resourceId), eq(invoiceAllocationEffects.kind, kind)));
        if (!effect) throw new Error("Synthetic raw effect did not reach the legitimate actual event");
        reachedCapacity = true;
        await tx.insert(invoiceAllocationEffects).values({ ...effect, id: createEntityId(), quantity: kind === "consume" ? "0.000000001" : "0.100000001" });
      }
      return result;
    });
    await expect(commands.execute(context, prepared.id)).rejects.toSatisfy((error: unknown) => {
      const failure = pgFailure(error); return failure.code === "23514" && Boolean(failure.message?.includes(kind === "consume" ? "accepted receipt quantity already allocated" : "release exceeds actual original occupation"));
    });
    expect(reachedCapacity).toBe(true); expect(await fixture.state()).toEqual(before);
  });

  it("does not use another invoice line or another purchase's receipt as this original's matching basis", async () => {
    const b = await fixture.basis({ invoiced: "0.25" }), other = await fixture.basis(), before = await fixture.state();
    await expect(prepare(await fixture.match(b.invoice.id, other.invoiceLine.id, b.receipt.receiptLine.id, "0.01"))).rejects.toMatchObject({ status: 409 });
    await expect(prepare(await fixture.match(b.invoice.id, b.invoiceLine.id, other.receipt.receiptLine.id, "0.01"))).rejects.toMatchObject({ status: 409 });
    expect(await fixture.state()).toEqual(before);
  });

  it("preserves unknown cross-currency variance after a local supplier correction", async () => {
    const b = await fixture.basis({ currency: "EUR", unitCostMinor: 1300 }), recorded = await actual(await fixture.record(b.invoice.id, b.invoiceLine.id, { currency: "EUR", amountMinor: 20 }));
    await actual(await fixture.review(b.invoice.id, recorded.id));
    expect((await detail(b.invoice.id)).balance).toMatchObject({ status: "unknown", comparisonCurrency: "USD", netAmountMinor: 240, varianceMinor: null,
      unknownReasons: expect.arrayContaining(["currency_mismatch"]), lines: [{ expectedAmountMinor: null, varianceMinor: null }] });
    await expect(prepare(await fixture.record(b.invoice.id, b.invoiceLine.id, { currency: "USD" }))).rejects.toMatchObject(conflict("invoice_reconciliation_currency_mismatch"));
  });

  it("rejects over-credit quantity or money without clamping an approved result", async () => {
    for (const options of [{ quantity: "0.200000001", amountMinor: 240 }, { quantity: 0, amountMinor: 241 }]) {
      const b = await fixture.basis(), before = await fixture.state();
      await expect(prepare(await fixture.record(b.invoice.id, b.invoiceLine.id, options))).rejects.toMatchObject({ status: 409 });
      expect(await fixture.state()).toEqual(before);
    }
  });

  it("reads preparation and detail without waiting for a write-held purchase or receipt lock", async () => {
    const b = await fixture.basis(), original = await fixture.record(b.invoice.id, b.invoiceLine.id);
    let unlock!: () => void, locked!: () => void;
    const released = new Promise<void>(resolve => { unlock = resolve; }), entered = new Promise<void>(resolve => { locked = resolve; });
    const holder = withTenant(database.db, context, async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`procurement-order:${context.tenantId}:${b.order.id}`},0))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`procurement-invoice-receipt:${context.tenantId}:${b.receipt.receiptLine.id}`},0))`);
      locked(); await released;
    });
    await entered;
    const reads = Promise.all([prepare(original), detail(b.invoice.id)]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const values = await Promise.race([reads, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Reconciliation preview held business write locks")), 2_000); })]);
      expect(values[0].original).toEqual(original); expect(values[1].invoiceId).toBe(b.invoice.id);
    } finally { if (timer) clearTimeout(timer); unlock(); await holder; await reads; }
  });

  it.each(["before_commit", "after_commit"] as const)("restores a quantity-credit approval after a real API is killed at %s", async phase => {
    identity ??= await startFactoryIdentityFixture(context.tenantId, `procurement-command-${context.userId}`, "http://localhost:3130", { application: "erp", clientId: "yummyai-web" });
    const b = await fixture.basis(), recorded = await actual(await fixture.record(b.invoice.id, b.invoiceLine.id, { quantity: "0.1", amountMinor: 120 }));
    const original = await fixture.review(b.invoice.id, recorded.id), prepared = await prepare(original), saved = protectedOriginal(await row(prepared.id)), before = await fixture.state();
    const token = await identity.operatorToken(), interrupted = startReconciliationApi(identity, key, { phase, commandId: prepared.id }); children.push(interrupted);
    const request = async (probe: ReconciliationProcess, path: string, body?: object) => {
      const { url } = await probe.wait("procurement.fixture.ready");
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url ?? "")) throw new Error("Unsafe synthetic reconciliation API origin");
      return fetch(`${url}/v1/procurement/commands/${prepared.id}${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
    };
    const response = request(interrupted, "/execute", {}).then(() => ({ received: true }), () => ({ received: false }));
    expect(await interrupted.wait("procurement.fixture.barrier", phase)).toMatchObject({ phase, commandId: prepared.id, pid: interrupted.child.pid });
    expect((await row(prepared.id)).status).toBe(phase === "before_commit" ? "prepared" : "succeeded");
    await interrupted.stop(true); expect((await response).received).toBe(false); if (phase === "before_commit") expect(await fixture.state()).toEqual(before);
    const fresh = startReconciliationApi(identity, key); children.push(fresh);
    const read = await request(fresh, ""); expect(read.status).toBe(200);
    expect(ProcurementCommandViewSchema.parse(await read.json())).toMatchObject({ id: prepared.id, original, status: phase === "before_commit" ? "prepared" : "succeeded" });
    const done = await request(fresh, "/execute", {}); expect(done.status).toBe(200); const actualResult = ProcurementCommandViewSchema.parse(await done.json());
    expect(actualResult.reconciliationResult).toMatchObject({ action: "adjustment_review", input: original.input, createdBy: context.userId,
      balance: { status: "matched", netAmountMinor: 120, lines: [{ allocatedQuantity: "0.1" }] } });
    expect((await row(prepared.id)).reconciliationResultProofId).toBe(actualResult.result!.id); expect(protectedOriginal(await row(prepared.id))).toEqual(saved);
    const facts = await fixture.state(), replay = await request(fresh, "/execute", {}); expect(replay.status).toBe(200);
    expect(ProcurementCommandViewSchema.parse(await replay.json()).reconciliationResult).toEqual(actualResult.reconciliationResult); expect(await fixture.state()).toEqual(facts);
    const releases = (await effects(b.invoice.id)).map(value => value.inventory_invoice_allocation_effects).filter(value => value.kind === "release");
    expect(releases).toHaveLength(1); expect(releases[0]!.quantity).toBe("0.1"); await fresh.stop();
  }, 120_000);
});
