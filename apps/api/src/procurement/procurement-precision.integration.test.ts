import { randomBytes } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { SecretVault } from "@yummyai/ai-core";
import { createEntityId } from "@yummyai/contracts";
import { SupplyTermsSchema } from "@yummyai/contracts/catalog/product-supply";
import { PrepareProcurementCommandSchema, ProcurementCommandViewSchema, type PrepareProcurementCommand } from "@yummyai/contracts/procurement/procurement-command";
import { sumStockQuantities } from "@yummyai/contracts/inventory/quantity";
import { connectDatabase, migrateDatabase, withTenant, productPlans, procurementCommands, inventoryProcurementWriteRequests,
  inventoryBalances, inventoryLots, inventoryProcurementReceipts, inventoryProcurementReceiptLines, inventoryPurchaseOrders,
  inventoryPurchaseOrderVersions, inventorySupplierInvoices, inventorySupplierInvoiceRequests,
  inventorySupplierInvoiceAllocations, inventorySupplierInvoiceLines } from "@yummyai/database";
import { startFactoryIdentityFixture } from "../../../../tools/testing/factory-identity-fixture.mjs";
import { AuditService } from "../audit/audit.service.js";
import { ProcurementService } from "./procurement.service.js";
import { ProcurementCommandService } from "./procurement-command.service.js";
import { invoiceRequestChecksum } from "./procurement-invoice-request.js";
import { procurementFixturePermissions } from "./procurement-command.fixtures.js";
import { precisionFixture, precisionKey, precisionCode, requireProcurementPrecisionFixture,
  startPrecisionApi, precisionApiRequest, type PrecisionProcess } from "./precision-fixtures.js";

requireProcurementPrecisionFixture();

describe.sequential("exact procurement, physical units, partial invoices and original recovery", () => {
  const database = connectDatabase(), fixture = precisionFixture(database), { context, coworker, owner, inventory, audit, incoming } = fixture;
  const key = randomBytes(32), commands = new ProcurementCommandService(database, new SecretVault(key), owner, audit);
  const owned = new Set<string>(), children: PrecisionProcess[] = [];
  let identity: Awaited<ReturnType<typeof startFactoryIdentityFixture>> | undefined;
  beforeAll(async () => { await migrateDatabase(database); await fixture.initialize(); }, 60_000);
  afterEach(async () => {
    const stopped = await Promise.allSettled(children.map(child => child.stop(true)));
    await fixture.setPermissions(context, procurementFixturePermissions);
    for (const id of owned) {
      const current = await commands.get(context, id);
      if (current.status === "prepared") await commands.cancel(context, id);
      if (!current.acknowledged) await commands.acknowledge(context, id);
    }
    owned.clear(); vi.restoreAllMocks();
    if (stopped.some(result => result.status === "rejected")) throw new Error("Precision API child cleanup incomplete");
  }, 60_000);
  afterAll(async () => {
    try {
      const stopped = await Promise.allSettled(children.map(child => child.stop(true)));
      await identity?.close();
      if (stopped.some(result => result.status === "rejected") || children.some(child => child.child.exitCode === null && child.child.signalCode === null))
        throw new Error("Precision API process still running");
      process.stdout.write(JSON.stringify({ type: "procurement.precision.process.cleanup", pids: children.map(child => child.child.pid), allExited: true }) + "\n");
    } finally { key.fill(0); await database.client.end(); }
  }, 30_000);

  async function actual(raw: PrepareProcurementCommand) {
    const original = PrepareProcurementCommandSchema.parse(raw), prepared = await commands.prepare(context, raw);
    owned.add(prepared.id); expect(prepared.original).toEqual(original);
    const executed = await commands.execute(context, prepared.id);
    expect(executed).toMatchObject({ status: "succeeded", result: { kind: raw.kind } });
    expect((await commands.execute(context, prepared.id)).result).toEqual(executed.result);
    await commands.acknowledge(context, prepared.id); owned.delete(prepared.id);
    return executed.result!;
  }
  async function readOrder(id: string) {
    const workspace = await owner.workspace(context);
    const order = workspace.purchaseOrders.find(row => row.id === id);
    expect(order).toBeDefined(); return order!;
  }
  async function receivedOrder(options: Parameters<typeof fixture.basis>[0] = {}, amount: number | string = 200) {
    const b = await fixture.basis(options), order = await owner.createPurchaseOrder(context, b.purchaseInput);
    await fixture.approve(order.id);
    const received = await fixture.receive(order.id, b.stock.id, amount, { unit: options.unit === "meter" ? "meter" : "gram" });
    return { ...b, order, received };
  }
  async function original(id: string) {
    const [row] = await withTenant(database.db, context, tx => tx.select().from(procurementCommands).where(eq(procurementCommands.id, id)));
    expect(row).toBeDefined(); return row!;
  }
  function protectedOriginal(row: Awaited<ReturnType<typeof original>>) {
    return { id: row.id, createdBy: row.createdBy, requestKey: row.requestKey, requestChecksum: row.requestChecksum,
      authoritySnapshot: row.authoritySnapshot, encryptedInput: row.encryptedInput, contractVersion: row.contractVersion,
      createdAt: row.createdAt, expiresAt: row.expiresAt };
  }

  it("binds a fractional quoted purchase to grams, actual inspection, returned rejection and two matched partial invoices", async () => {
    const b = await fixture.basis();
    const requestLine = { lineKey: b.line.lineKey, stockItemId: b.line.stockItemId,
      destinationLocationId: b.line.destinationLocationId, quantity: b.line.quantity, unit: b.line.unit };
    const requisition = await actual({ kind: "requisition_create", targetId: null, input: { code: `${b.code}-REQ`, reasonCode: "SYNTHETIC",
      lines: [requestLine], idempotencyKey: precisionKey() } });
    const rfq = await actual({ kind: "rfq_create", targetId: requisition.id, input: { expectedRequisitionVersion: 1,
      supplierIds: [fixture.supplierId], responseDueAt: b.future, idempotencyKey: precisionKey() } });
    const quote = await actual({ kind: "quote_record", targetId: rfq.id, input: { supplierId: fixture.supplierId, currency: "USD",
      validUntil: b.future, lines: [{ lineKey: "LINE-1", unitCostMinor: 1200, minimumOrderQuantity: "0.125", priceBasisQuantity: 1, leadTimeDays: 0 }], idempotencyKey: precisionKey() } });
    const purchase = await actual({ kind: "purchase_create", targetId: null, input: { ...b.purchaseInput,
      requisitionId: requisition.id, quoteId: quote.id, lines: [{ ...b.line, priceBasisQuantity: 1 }] } });
    expect(await readOrder(purchase.id)).toMatchObject({ totalMinor: 300, lines: [{ quantity: "0.25", unit: "kilogram",
      unitCostMinor: 1200, priceBasisQuantity: 1, stockBasis: { stockUnit: "gram", stockQuantity: 250,
        conversionNumerator: "1000", conversionDenominator: "1", priceBasisStockQuantity: 1000 } }] });
    await actual({ kind: "purchase_review", targetId: purchase.id, input: { expectedVersion: 1, decision: "approved",
      reasonCode: "SYNTHETIC_APPROVAL", idempotencyKey: precisionKey() } });
    const received = await fixture.receive(purchase.id, b.stock.id, 250, { accepted: 200, rejected: 50 });
    expect(received.posted.quantities).toMatchObject({ accepted: 200, rejected: 50, pending: 0, rejectedHeld: 50 });
    const returned = await incoming.returnRejected(context, received.line.id, received.posted.postings[0]!.id, { quantity: 50,
      returnedAt: received.at, externalReference: "Synthetic actual rejected handover", reason: "Synthetic rejected 50 grams", idempotencyKey: precisionKey() });
    expect(returned.quantities).toMatchObject({ accepted: 200, rejected: 50, returned: 50, rejectedHeld: 0, pending: 0 });
    const receiptLines = await withTenant(database.db, context, tx => tx.select().from(inventoryProcurementReceiptLines)
      .innerJoin(inventoryProcurementReceipts, eq(inventoryProcurementReceiptLines.receiptId, inventoryProcurementReceipts.id))
      .where(eq(inventoryProcurementReceipts.purchaseOrderId, purchase.id)));
    expect(receiptLines).toHaveLength(1);
    expect(receiptLines[0]!.inventory_procurement_receipt_lines).toMatchObject({ receivedQuantity: "0.2", rejectedQuantity: "0.05",
      unit: "kilogram", stockUnit: "gram", stockReceivedQuantity: 200, stockRejectedQuantity: 50, priceBasisQuantity: 1 });
    const lots = await withTenant(database.db, context, tx => tx.select().from(inventoryLots).where(eq(inventoryLots.stockItemId, b.stock.id)));
    expect(lots).toHaveLength(1); expect(lots[0]).toMatchObject({ stockItemId: b.stock.id, unitCostMinor: 1200, unitCostQuantity: 1000 });
    const balances = await withTenant(database.db, context, tx => tx.select().from(inventoryBalances).where(eq(inventoryBalances.stockItemId, b.stock.id)));
    expect(sumStockQuantities(balances.map(row => row.physicalQuantity))).toBe(200);
    const firstInput = fixture.invoice(), first = await owner.recordInvoice(context, purchase.id, firstInput);
    expect(first).toMatchObject({ status: "matched", allocationStatus: "complete", totalMinor: 120, varianceMinor: 0,
      lines: [{ invoicedQuantity: "0.1", allocatedQuantity: "0.1", unit: "kilogram" }] });
    expect(await fixture.restartedOwner().recordInvoice(context, purchase.id, firstInput)).toEqual(first);
    const second = await owner.recordInvoice(context, purchase.id, fixture.invoice());
    expect(second).toMatchObject({ status: "matched", allocationStatus: "complete", totalMinor: 120, varianceMinor: 0 });
    const third = await owner.recordInvoice(context, purchase.id, fixture.invoice());
    expect(third).toMatchObject({ status: "reconciliation_required", allocationStatus: "reconciliation_required",
      lines: [{ allocatedQuantity: 0 }] });
    expect(sumStockQuantities([first.lines![0]!.allocatedQuantity!, second.lines![0]!.allocatedQuantity!, third.lines![0]!.allocatedQuantity!])).toBe("0.2");
  });

  it("normalizes equivalent nine-place originals without changing their ciphertext or accepting a one-nano change", async () => {
    const b = await fixture.basis({ quantity: "0.290000000", unit: "meter", stockUnit: "meter", unitCostMinor: 100 });
    const input: PrepareProcurementCommand = { kind: "purchase_create", targetId: null, input: b.purchaseInput };
    const prepared = await commands.prepare(context, input); owned.add(prepared.id);
    const before = protectedOriginal(await original(prepared.id));
    const replay = await commands.prepare(context, { ...input, input: { ...b.purchaseInput,
      lines: [{ ...b.line, quantity: "0.29" }] } });
    expect(replay.id).toBe(prepared.id); expect(replay.original!.input).toMatchObject({ lines: [{ quantity: "0.29" }] });
    expect(protectedOriginal(await original(prepared.id))).toEqual(before);
    await expect(commands.prepare(context, { ...input, input: { ...b.purchaseInput,
      lines: [{ ...b.line, quantity: "0.290000001" }] } })).rejects.toMatchObject({ status: 409,
      response: expect.objectContaining({ code: "procurement_original_mismatch" }) });
    const result = await commands.execute(context, prepared.id);
    expect(await readOrder(result.result!.id)).toMatchObject({ totalMinor: 29, lines: [{ quantity: "0.29" }] });
    expect(protectedOriginal(await original(prepared.id))).toEqual(before);
  });

  it("revises an exact nine-place purchase and refuses an unrepresentable amount before any fact is saved", async () => {
    const b = await fixture.basis({ quantity: "1.000000001", unit: "meter", stockUnit: "meter", unitCostMinor: 1_000_000_000 });
    const order = await owner.createPurchaseOrder(context, b.purchaseInput);
    expect(order.totalMinor).toBe(1_000_000_001);
    const revised = await actual({ kind: "purchase_revise", targetId: order.id, input: { expectedVersion: 1, currency: "USD", expectedAt: b.future,
      lines: [{ ...b.line, quantity: "1.000000002" }], idempotencyKey: precisionKey() } });
    expect(await readOrder(revised.id)).toMatchObject({ currentVersion: 2, totalMinor: 1_000_000_002 });
    const versions = await withTenant(database.db, context, tx => tx.select().from(inventoryPurchaseOrderVersions)
      .where(eq(inventoryPurchaseOrderVersions.purchaseOrderId, order.id)));
    expect(versions.map(row => row.lineSnapshot[0]!.quantity).sort()).toEqual(["1.000000001", "1.000000002"]);
    const before = await fixture.state(["inventory_purchase_orders", "inventory_purchase_order_versions", "inventory_procurement_write_requests", "audit_events"]);
    await expect(owner.createPurchaseOrder(context, { ...b.purchaseInput, code: precisionCode("SUBMINOR"), idempotencyKey: precisionKey(),
      lines: [{ ...b.line, quantity: "0.5", unitCostMinor: 1 }] })).rejects.toBeInstanceOf(ConflictException);
    expect(await fixture.state(Object.keys(before))).toEqual(before);
  });

  it("applies a fractional supply MOQ in its purchase unit and pins its exact price basis", async () => {
    const b = await fixture.basis(), productId = createEntityId(), now = await fixture.clock();
    await withTenant(database.db, context, tx => tx.insert(productPlans).values({ id: productId, tenantId: context.tenantId,
      name: "Synthetic precision supply product", status: "approved", customization: { version: 1, fields: [] }, createdBy: context.userId }));
    const terms = SupplyTermsSchema.parse({ fulfillmentModes: ["fba_replenishment"], stockItemId: b.stock.id,
      purchaseUnit: "kilogram", priceBasisQuantity: "0.05", minimumOrderQuantity: "0.125", unitCostMinor: 60, currency: "USD", leadTimeDays: 0,
      validFrom: new Date(now.getTime() - 3_600_000).toISOString(), validUntil: b.future, status: "active", preference: "primary", sampleStatus: "passed" });
    const link = await fixture.supply.create(context, { productPlanId: productId, supplierId: fixture.supplierId, skuId: null, terms, idempotencyKey: precisionKey() });
    const input = { purpose: "fba_replenishment" as const, expectedVersion: 1, code: b.purchaseInput.code,
      destinationLocationId: fixture.locationId, quantity: "0.125", expectedAt: b.future, idempotencyKey: precisionKey() };
    const before = await fixture.state(["inventory_purchase_orders", "inventory_procurement_write_requests", "audit_events"]);
    await expect(owner.createPurchaseOrderFromSupply(context, link.id, { ...input, quantity: "0.124999999" })).rejects.toBeInstanceOf(ConflictException);
    expect(await fixture.state(Object.keys(before))).toEqual(before);
    const result = await actual({ kind: "supply_purchase_create", targetId: link.id, input });
    const order = await readOrder(result.id);
    const history = await fixture.supply.history(context, link.id);
    expect(history).toHaveLength(1);
    expect(order).toMatchObject({ sourceSupplyVersionId: history[0]!.id, totalMinor: 150, lines: [{ quantity: "0.125", unit: "kilogram",
      priceBasisQuantity: "0.05", unitCostMinor: 60, stockBasis: { stockUnit: "gram", stockQuantity: 125, priceBasisStockQuantity: 50 } }] });
    await fixture.supply.revise(context, link.id, { expectedVersion: 1, terms: { ...terms, unitCostMinor: 70 }, idempotencyKey: precisionKey() });
    const tables = ["inventory_purchase_orders", "inventory_purchase_order_versions", "inventory_purchase_order_events",
      "inventory_procurement_write_requests", "inventory_procurement_commands", "product_supply_links", "product_supply_versions", "audit_events"];
    const beforeReplay = await fixture.state(tables);
    await expect(owner.createPurchaseOrderFromSupply(context, link.id, input)).rejects.toMatchObject({ status: 409,
      response: expect.objectContaining({ code: "procurement_original_pending" }) });
    const restored = await commands.prepare(context, { kind: "supply_purchase_create", targetId: link.id, input });
    expect(restored).toMatchObject({ status: "succeeded", acknowledged: true, result: { id: order.id } });
    expect((await commands.execute(context, restored.id)).result).toEqual(result);
    expect(await readOrder(order.id)).toEqual(order);
    expect(await fixture.state(tables)).toEqual(beforeReplay);
  });

  it.each(["each", "pair", "set"] as const)("rejects fractional %s facts and MOQ before saving original proof", async unit => {
    const b = await fixture.basis({ quantity: 2, unit, stockUnit: unit, unitCostMinor: 100 });
    const line = { lineKey: b.line.lineKey, stockItemId: b.line.stockItemId,
      destinationLocationId: b.line.destinationLocationId, quantity: b.line.quantity, unit: b.line.unit };
    const req = await owner.createRequisition(context, { code: precisionCode("REQ"), reasonCode: "SYNTHETIC", lines: [line], idempotencyKey: precisionKey() });
    const rfq = await owner.createRfq(context, req.id, { expectedRequisitionVersion: 1, supplierIds: [fixture.supplierId], responseDueAt: b.future, idempotencyKey: precisionKey() });
    const before = await fixture.state(["inventory_purchase_orders", "inventory_supplier_quote_versions", "inventory_procurement_write_requests", "audit_events"]);
    await expect(owner.createPurchaseOrder(context, { ...b.purchaseInput, lines: [{ ...b.line, quantity: "0.5" }] })).rejects.toThrow();
    await expect(owner.recordSupplierQuote(context, rfq.id, { supplierId: fixture.supplierId, currency: "USD", validUntil: b.future,
      lines: [{ lineKey: "LINE-1", minimumOrderQuantity: "0.5", unitCostMinor: 100, leadTimeDays: 0 }], idempotencyKey: precisionKey() })).rejects.toThrow();
    expect(await fixture.state(Object.keys(before))).toEqual(before);
  });

  it("rejects cross-dimension, over-precise and overflowing physical conversions atomically", async () => {
    for (const options of [{ quantity: 1, unit: "meter" as const, stockUnit: "gram" as const },
      { quantity: "0.000000001", unit: "gram" as const, stockUnit: "kilogram" as const },
      { quantity: "2147483.647000001", unit: "kilogram" as const, stockUnit: "gram" as const }]) {
      const b = await fixture.basis({ ...options, unitCostMinor: 0 }), before = await fixture.state(["inventory_purchase_orders", "inventory_purchase_order_versions", "inventory_procurement_write_requests", "audit_events"]);
      await expect(owner.createPurchaseOrder(context, b.purchaseInput)).rejects.toBeInstanceOf(ConflictException);
      expect(await fixture.state(Object.keys(before))).toEqual(before);
    }
  });

  it("binds a successful invoice key to its original purchase, actor and complete decimal input", async () => {
    const b = await receivedOrder(), input = fixture.invoice(), invoice = await owner.recordInvoice(context, b.order.id, input);
    const another = await receivedOrder(), before = await fixture.state();
    const attempts: Parameters<typeof owner.recordInvoice>[] = [[context, another.order.id, input], [coworker, b.order.id, input],
      [context, b.order.id, { ...input, lines: [{ ...input.lines[0]!, invoicedQuantity: "0.100000001" }] }],
      [context, b.order.id, { ...input, invoiceNumber: precisionCode("CHANGED") }]];
    for (const [actor, target, changed] of attempts)
      await expect(owner.recordInvoice(actor, target, changed)).rejects.toMatchObject({ status: 409,
        response: expect.objectContaining({ code: "procurement_invoice_input_mismatch" }) });
    expect(await fixture.state()).toEqual(before);
    expect(await fixture.restartedOwner().recordInvoice(context, b.order.id, { ...input,
      issuedAt: input.issuedAt.replace(".000Z", "Z"), lines: [{ ...input.lines[0]!, invoicedQuantity: "0.100000000" }] })).toEqual(invoice);
  });

  it("rolls the invoice, allocation, reconciliation event and original proof back with a final audit failure", async () => {
    const b = await receivedOrder(), input = fixture.invoice("0.1", { unitCostMinor: 1300 }), before = await fixture.state();
    const failedAudit = new AuditService(database), failed = new ProcurementService(database, inventory, failedAudit);
    vi.spyOn(failedAudit, "recordInTransaction").mockRejectedValueOnce(new Error("Synthetic final invoice audit unavailable"));
    await expect(failed.recordInvoice(context, b.order.id, input)).rejects.toThrow("Synthetic final invoice audit unavailable");
    expect(await fixture.state()).toEqual(before);
    const invoice = await owner.recordInvoice(context, b.order.id, input);
    expect(invoice).toMatchObject({ status: "reconciliation_required", allocationStatus: "complete", totalMinor: 130, varianceMinor: 10 });
    expect(await owner.recordInvoice(context, b.order.id, input)).toEqual(invoice);
  });

  it("allocates concurrent partial invoices against the same received remainder only once", async () => {
    const b = await receivedOrder();
    const results = await Promise.all([owner.recordInvoice(context, b.order.id, fixture.invoice("0.15")),
      fixture.restartedOwner().recordInvoice(context, b.order.id, fixture.invoice("0.15"))]);
    expect(results.filter(row => row.status === "matched")).toHaveLength(1);
    expect(results.filter(row => row.allocationStatus === "complete")).toHaveLength(1);
    expect(results.filter(row => row.allocationStatus === "reconciliation_required")).toHaveLength(1);
    expect(sumStockQuantities(results.flatMap(row => row.lines!.map(line => line.allocatedQuantity!)))).toBe("0.2");
  });

  it("physically rejects a raw allocation beyond the accepted receipt after the exact remainder is exhausted", async () => {
    const b = await receivedOrder();
    await owner.recordInvoice(context, b.order.id, fixture.invoice());
    await owner.recordInvoice(context, b.order.id, fixture.invoice());
    const excess = await owner.recordInvoice(context, b.order.id, fixture.invoice());
    expect(excess).toMatchObject({ status: "reconciliation_required", varianceMinor: 120,
      lines: [{ allocatedQuantity: 0, varianceMinor: 120 }] });
    const [receiptLine] = await withTenant(database.db, context, tx => tx.select({ id: inventoryProcurementReceiptLines.id })
      .from(inventoryProcurementReceiptLines).innerJoin(inventoryProcurementReceipts, eq(inventoryProcurementReceipts.id, inventoryProcurementReceiptLines.receiptId))
      .where(eq(inventoryProcurementReceipts.purchaseOrderId, b.order.id)));
    const [version] = await withTenant(database.db, context, tx => tx.select({ id: inventoryPurchaseOrderVersions.id })
      .from(inventoryPurchaseOrderVersions).where(and(eq(inventoryPurchaseOrderVersions.purchaseOrderId, b.order.id), eq(inventoryPurchaseOrderVersions.versionNumber, 1))));
    expect(receiptLine).toBeDefined(); expect(version).toBeDefined();
    const before = await fixture.state();
    const input = fixture.invoice(), invoiceId = createEntityId(), lineId = createEntityId();
    await expect(withTenant(database.db, context, async tx => {
      // Header, evidence and line are created in this actual transaction, so
      // the insertion-witness gate cannot mask the receipt-capacity check.
      await tx.insert(inventorySupplierInvoices).values({ id: invoiceId, tenantId: context.tenantId,
        purchaseOrderId: b.order.id, invoiceNumber: input.invoiceNumber, currency: "USD", totalMinor: 120,
        varianceMinor: 0, status: "matched", allocationStatus: "complete", issuedAt: new Date(input.issuedAt),
        idempotencyKey: input.idempotencyKey, createdBy: context.userId });
      await tx.insert(inventorySupplierInvoiceRequests).values({ id: createEntityId(), tenantId: context.tenantId,
        invoiceId, purchaseOrderId: b.order.id, purchaseOrderVersionId: version!.id, createdBy: context.userId,
        evidenceVersion: 1, requestChecksum: invoiceRequestChecksum(b.order.id, input), idempotencyKey: input.idempotencyKey });
      await tx.insert(inventorySupplierInvoiceLines).values({ id: lineId, tenantId: context.tenantId, invoiceId,
        lineKey: "LINE-1", invoicedQuantity: "0.1", unit: "kilogram", unitCostMinor: 1200,
        priceBasisQuantity: 1, allocatedQuantity: "0.1", varianceMinor: 0 });
      await tx.insert(inventorySupplierInvoiceAllocations).values({ id: createEntityId(), tenantId: context.tenantId,
        createdBy: context.userId, invoiceLineId: lineId, receiptLineId: receiptLine!.id, quantity: "0.1", unit: "kilogram" });
    })).rejects.toMatchObject({ cause: { code: "23514", message: expect.stringContaining("accepted receipt quantity already allocated") } });
    expect(await fixture.state()).toEqual(before);
  });

  it("marks a currency discrepancy for reconciliation even when the exact stock allocation is complete", async () => {
    const b = await receivedOrder();
    expect(await owner.recordInvoice(context, b.order.id, fixture.invoice("0.1", { currency: "EUR" })))
      .toMatchObject({ status: "reconciliation_required", allocationStatus: "complete", totalMinor: 120,
        comparisonCurrency: "USD", varianceMinor: null, lines: [{ varianceMinor: null }] });
  });

  it("retains safe boundary minor amounts and rejects an overflowing sum without committing a purchase", async () => {
    const b = await fixture.basis({ quantity: 1, unit: "meter", stockUnit: "meter", unitCostMinor: Number.MAX_SAFE_INTEGER });
    expect(await owner.createPurchaseOrder(context, b.purchaseInput)).toMatchObject({ totalMinor: Number.MAX_SAFE_INTEGER });
    const before = await fixture.state(["inventory_purchase_orders", "inventory_purchase_order_versions", "inventory_procurement_write_requests", "audit_events"]);
    await expect(owner.createPurchaseOrder(context, { ...b.purchaseInput, code: precisionCode("OVERFLOW"), idempotencyKey: precisionKey(),
      lines: [b.line, { ...b.line, lineKey: "LINE-2", unitCostMinor: 1 }] })).rejects.toBeInstanceOf(ConflictException);
    expect(await fixture.state(Object.keys(before))).toEqual(before);
  });

  it("refuses an invoice below one minor unit and leaves its actual receipt available", async () => {
    const b = await receivedOrder({ quantity: 1, unit: "meter", stockUnit: "meter", unitCostMinor: 1 }, "0.5");
    const before = await fixture.state();
    await expect(owner.recordInvoice(context, b.order.id, fixture.invoice("0.5", { unitCostMinor: 1 }))).rejects.toBeInstanceOf(ConflictException);
    expect(await fixture.state()).toEqual(before);
  });

  it.each(["before_commit", "after_commit"] as const)("recovers the same nine-place original after actual API termination at %s", async phase => {
    identity ??= await startFactoryIdentityFixture(context.tenantId, `procurement-command-${context.userId}`, "http://localhost:3130", { application: "erp", clientId: "yummyai-web" });
    const accessToken = await identity.operatorToken(), b = await fixture.basis({ quantity: "1.000000001", unit: "meter", stockUnit: "meter", unitCostMinor: 1_000_000_000 });
    const input = PrepareProcurementCommandSchema.parse({ kind: "purchase_create", targetId: null, input: b.purchaseInput });
    const prepared = await commands.prepare(context, input); owned.add(prepared.id);
    const protectedBefore = protectedOriginal(await original(prepared.id));
    const baseline = await fixture.state(["inventory_purchase_orders", "inventory_purchase_order_versions", "inventory_procurement_write_requests"]);
    const interrupted = startPrecisionApi(identity, key, { phase, commandId: prepared.id }); children.push(interrupted);
    const unknown = precisionApiRequest(interrupted, accessToken, `/${prepared.id}/execute`, {}).then(response => ({ received: true, status: response.status }), () => ({ received: false, status: 0 }));
    expect(await interrupted.wait("procurement.fixture.barrier", phase)).toMatchObject({ commandId: prepared.id, phase, pid: interrupted.child.pid });
    expect((await original(prepared.id)).status).toBe(phase === "before_commit" ? "prepared" : "succeeded");
    await interrupted.stop(true); expect((await unknown).received).toBe(false);
    if (phase === "before_commit") expect(await fixture.state(Object.keys(baseline))).toEqual(baseline);
    const restarted = startPrecisionApi(identity, key); children.push(restarted);
    const readResponse = await precisionApiRequest(restarted, accessToken, `/${prepared.id}`); expect(readResponse.status).toBe(200);
    const restored = ProcurementCommandViewSchema.parse(await readResponse.json());
    expect(restored).toMatchObject({ id: prepared.id, status: phase === "before_commit" ? "prepared" : "succeeded", original: input });
    expect(protectedOriginal(await original(prepared.id))).toEqual(protectedBefore);
    const resultResponse = await precisionApiRequest(restarted, accessToken, `/${prepared.id}/execute`, {}); expect(resultResponse.status).toBe(200);
    const result = ProcurementCommandViewSchema.parse(await resultResponse.json());
    expect(await readOrder(result.result!.id)).toMatchObject({ totalMinor: 1_000_000_001, lines: [{ quantity: "1.000000001", stockBasis: { stockQuantity: "1.000000001" } }] });
    const proof = await withTenant(database.db, context, tx => tx.select().from(inventoryProcurementWriteRequests)
      .where(eq(inventoryProcurementWriteRequests.idempotencyKey, b.purchaseInput.idempotencyKey)));
    expect(proof).toHaveLength(1); expect(proof[0]!.createdBy).toBe(context.userId);
    const state = await fixture.state(Object.keys(baseline));
    const replayResponse = await precisionApiRequest(restarted, accessToken, `/${prepared.id}/execute`, {}); expect(replayResponse.status).toBe(200);
    expect(ProcurementCommandViewSchema.parse(await replayResponse.json()).result).toEqual(result.result);
    expect(await fixture.state(Object.keys(baseline))).toEqual(state);
    expect(protectedOriginal(await original(prepared.id))).toEqual(protectedBefore);
    const actualOrders = await withTenant(database.db, context, tx => tx.select().from(inventoryPurchaseOrders)
      .where(and(eq(inventoryPurchaseOrders.idempotencyKey, b.purchaseInput.idempotencyKey), eq(inventoryPurchaseOrders.createdBy, context.userId))));
    expect(actualOrders).toHaveLength(1);
    await restarted.stop();
  }, 120_000);
});
