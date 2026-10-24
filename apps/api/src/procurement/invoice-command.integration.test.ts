import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { SecretVault } from "@yummyai/ai-core";
import { ForbiddenError, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { createEntityId } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { ProcurementCommandListSchema, ProcurementCommandViewSchema } from "@yummyai/contracts/procurement/procurement-command";
import { sumStockQuantities } from "@yummyai/contracts/inventory/quantity";
import { connectDatabase, migrateDatabase, withTenant, procurementCommands, inventorySupplierInvoices, inventorySupplierInvoiceRequests,
  inventorySupplierInvoiceAllocations, inventorySupplierInvoiceLines, inventoryProcurementWriteRequests, expireProcurementCommandInputs } from "@yummyai/database";
import { startFactoryIdentityFixture } from "../../../../tools/testing/factory-identity-fixture.mjs";
import { ProcurementCommandService } from "./procurement-command.service.js";
import { procurementCommandBinding } from "./procurement-original-request.js";
import { procurementFixturePermissions } from "./procurement-command.fixtures.js";
import { invoiceCommandFixture, invoiceCommandCode, invoiceFactTables, requireInvoiceCommandFixture,
  startInvoiceApi, invoiceApiRequest, type InvoiceProcess } from "./invoice-command.fixtures.js";

requireInvoiceCommandFixture();
type Original = ReturnType<ReturnType<typeof invoiceCommandFixture>["original"]>;

describe.sequential("actual retained invoice originals and 149 receipt allocations", () => {
  const database = connectDatabase(), fixture = invoiceCommandFixture(database), { context, coworker, outsider, owner, audit } = fixture;
  const key = randomBytes(32), commands = new ProcurementCommandService(database, new SecretVault(key), owner, audit);
  const owned = new Set<string>(), children: InvoiceProcess[] = [];
  let identity: Awaited<ReturnType<typeof startFactoryIdentityFixture>> | undefined;
  const restarted = () => new ProcurementCommandService(database, new SecretVault(key), owner, audit);
  beforeAll(async () => { await migrateDatabase(database); await fixture.initialize(); }, 60_000);
  afterEach(async () => {
    const stopped = await Promise.allSettled(children.map(child => child.stop(true))); vi.restoreAllMocks();
    await fixture.setPermissions(context, procurementFixturePermissions);
    for (const id of owned) {
      const current = await commands.get(context, id);
      if (current.status === "prepared") await commands.cancel(context, id);
      if (!current.acknowledged) await commands.acknowledge(context, id);
    }
    owned.clear();
    if (stopped.some(result => result.status === "rejected")) throw new Error("Invoice API cleanup incomplete");
  }, 60_000);
  afterAll(async () => {
    try {
      const stopped = await Promise.allSettled(children.map(child => child.stop(true))); await identity?.close();
      if (stopped.some(result => result.status === "rejected") || children.some(child => child.child.exitCode === null && child.child.signalCode === null)) throw new Error("Invoice process still running");
      process.stdout.write(JSON.stringify({ type: "invoice.command.process.cleanup", pids: children.map(child => child.child.pid), allExited: true }) + "\n");
    } finally { key.fill(0); await database.client.end(); }
  }, 30_000);
  async function prepare(original: Original) {
    const result = await commands.prepare(context, original); owned.add(result.id); return result;
  }
  async function actual(original: Original, acknowledge = true) {
    const prepared = await prepare(original), executed = await commands.execute(context, prepared.id);
    expect(executed).toMatchObject({ status: "succeeded", result: { kind: "invoice_record", versionId: null, version: null } });
    if (acknowledge) { await commands.acknowledge(context, prepared.id); owned.delete(prepared.id); }
    return executed;
  }
  async function row(id: string) {
    const [value] = await withTenant(database.db, context, tx => tx.select().from(procurementCommands).where(eq(procurementCommands.id, id)));
    expect(value).toBeDefined(); return value!;
  }
  function protectedOriginal(value: Awaited<ReturnType<typeof row>>) {
    return { id: value.id, kind: value.kind, operation: value.operation, targetId: value.targetId, createdBy: value.createdBy,
      requestKey: value.requestKey, requestChecksum: value.requestChecksum, authoritySnapshot: value.authoritySnapshot,
      encryptedInput: value.encryptedInput, contractVersion: value.contractVersion, createdAt: value.createdAt, expiresAt: value.expiresAt };
  }
  async function proof(id: string) {
    const [value] = await withTenant(database.db, context, tx => tx.select().from(inventorySupplierInvoiceRequests).where(eq(inventorySupplierInvoiceRequests.invoiceId, id)));
    expect(value).toBeDefined(); return value!;
  }

  it("persists only the private original at preparation and reviews the invoice's actual price and currency", async () => {
    const b = await fixture.basis(), original = fixture.original(b.order.id, { currency: "EUR", unitCostMinor: 1300, priceBasisQuantity: 1 });
    const before = await fixture.state(), prepared = await prepare(original), stored = await row(prepared.id);
    expect(prepared).toMatchObject({ status: "prepared", original, invoiceResult: null, result: null, canExecute: true,
      reviewBasis: { currency: "EUR", lines: [{ quantity: "0.1", unit: "kilogram", unitCostMinor: 1300, priceBasisQuantity: 1, lineTotalMinor: 130,
        stockBasis: { stockUnit: "gram", stockQuantity: 100, priceBasisStockQuantity: 1000 } }] } });
    expect(prepared.reviewBasis!.sourceVersionId).not.toBeNull();
    expect(stored).toMatchObject({ resultProofId: null, invoiceResultProofId: null, createdBy: context.userId,
      requestKey: original.input.idempotencyKey, requestChecksum: procurementCommandBinding(original).requestChecksum });
    expect(stored.encryptedInput).not.toContain(original.input.invoiceNumber);
    expect(await fixture.state()).toEqual(before);
    expect((await restarted().get(context, prepared.id)).original).toEqual(original);
    const same = await prepare({ ...original, input: { ...original.input, issuedAt: original.input.issuedAt.replace(".000Z", "Z"),
      lines: original.input.lines.map(line => ({ ...line, invoicedQuantity: "0.100000000" })) } });
    expect(same.id).toBe(prepared.id); expect(protectedOriginal(await row(prepared.id))).toEqual(protectedOriginal(stored));
  });

  it("atomically binds one actual invoice, 149 proof and allocation to the original command under concurrent execution", async () => {
    const b = await fixture.basis(), original = fixture.original(b.order.id), prepared = await prepare(original);
    const before = await fixture.state(), preserved = protectedOriginal(await row(prepared.id));
    const [first, second] = await Promise.all([commands.execute(context, prepared.id), restarted().execute(context, prepared.id)]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "succeeded", original, result: { kind: "invoice_record", versionId: null, version: null },
      invoiceResult: { purchaseOrderId: b.order.id, invoiceNumber: original.input.invoiceNumber, totalMinor: 120,
        status: "matched", allocationStatus: "complete", varianceMinor: 0, lines: [{ invoicedQuantity: "0.1", allocatedQuantity: "0.1" }] } });
    const actualProof = await proof(first.result!.id), saved = await row(prepared.id);
    expect(saved.resultProofId).toBeNull(); expect(saved.invoiceResultProofId).toBe(actualProof.id);
    expect(actualProof).toMatchObject({ purchaseOrderId: b.order.id, createdBy: context.userId,
      requestChecksum: saved.requestChecksum, idempotencyKey: saved.requestKey });
    const after = await fixture.state();
    for (const table of ["inventory_supplier_invoices", "inventory_supplier_invoice_lines", "inventory_supplier_invoice_requests", "inventory_supplier_invoice_allocations"])
      expect(after[table]!.count).toBe(before[table]!.count + 1);
    for (const table of invoiceFactTables.filter(table => !table.startsWith("inventory_supplier_invoice"))) expect(after[table]).toEqual(before[table]);
    expect(protectedOriginal(saved)).toEqual(preserved);
    expect(JSON.stringify(first.invoiceResult)).not.toMatch(/encryptedInput|authoritySnapshot|requestChecksum|idempotencyKey|createdBy|tenantId/);
    expect((await restarted().execute(context, prepared.id)).invoiceResult).toEqual(first.invoiceResult);
    expect(await fixture.state()).toEqual(after);
  });

  it("rejects changes to the original invoice body, purchase or actor without replacing the stored original", async () => {
    const b = await fixture.basis(), other = await fixture.basis(), original = fixture.original(b.order.id), prepared = await prepare(original);
    const preserved = protectedOriginal(await row(prepared.id)), before = await fixture.state([...invoiceFactTables, "inventory_procurement_commands", "audit_events"]);
    const changes: Original[] = [{ ...original, targetId: other.order.id }, ...[
      { invoiceNumber: invoiceCommandCode("CHANGED") }, { currency: "EUR" }, { expectedVersion: 2 },
      { lines: [{ ...original.input.lines[0]!, invoicedQuantity: "0.100000001" }] },
      { lines: [{ ...original.input.lines[0]!, unitCostMinor: 1300 }] }, { lines: [{ ...original.input.lines[0]!, priceBasisQuantity: "0.5" }] },
    ].map(input => ({ ...original, input: { ...original.input, ...input } }))];
    for (const changed of changes) await expect(commands.prepare(context, changed)).rejects.toMatchObject({ status: 409,
      response: expect.objectContaining({ code: "procurement_original_mismatch" }) });
    await expect(commands.prepare(coworker, original)).rejects.toMatchObject({ status: 409 });
    expect(protectedOriginal(await row(prepared.id))).toEqual(preserved);
    expect(await fixture.state(Object.keys(before))).toEqual(before);
  });

  it.each(["procurement.invoice.record", "procurement.command.execute"])("rolls all actual facts and outcome back when final %s audit fails", async action => {
    const b = await fixture.basis(), original = fixture.original(b.order.id), prepared = await prepare(original);
    const before = await fixture.state([...invoiceFactTables, "inventory_procurement_commands", "audit_events"]);
    const record = audit.recordInTransaction.bind(audit);
    vi.spyOn(audit, "recordInTransaction").mockImplementation(async (tx, current, event) => {
      if (event.action === action) throw new Error("Synthetic final invoice command audit unavailable");
      return record(tx, current, event);
    });
    await expect(commands.execute(context, prepared.id)).rejects.toThrow("Synthetic final invoice command audit unavailable");
    expect(await fixture.state(Object.keys(before))).toEqual(before);
    vi.restoreAllMocks();
    expect(await commands.execute(context, prepared.id)).toMatchObject({ status: "succeeded", invoiceResult: { status: "matched", totalMinor: 120 } });
  });

  it("rejects raw API and SQL bypass of a prepared invoice, including after acknowledgement", async () => {
    const b = await fixture.basis(), original = fixture.original(b.order.id), prepared = await prepare(original), before = await fixture.state();
    await expect(owner.recordInvoice(context, b.order.id, original.input)).rejects.toMatchObject({ status: 409,
      response: expect.objectContaining({ code: "procurement_original_pending" }) });
    await expect(withTenant(database.db, context, tx => tx.insert(inventorySupplierInvoices).values({ id: createEntityId(), tenantId: context.tenantId,
      purchaseOrderId: b.order.id, invoiceNumber: original.input.invoiceNumber, currency: "USD", totalMinor: 120, varianceMinor: 0,
      status: "matched", allocationStatus: "complete", issuedAt: new Date(original.input.issuedAt), idempotencyKey: original.input.idempotencyKey, createdBy: context.userId })))
      .rejects.toMatchObject({ cause: { code: "23514", message: expect.stringContaining("prepared invoice must execute through its original command") } });
    expect(await fixture.state()).toEqual(before);
    const done = await commands.execute(context, prepared.id); await commands.acknowledge(context, prepared.id);
    const final = await fixture.state();
    await expect(owner.recordInvoice(context, b.order.id, original.input)).rejects.toMatchObject({ status: 409,
      response: expect.objectContaining({ code: "procurement_original_pending" }) });
    expect((await commands.execute(context, prepared.id)).invoiceResult).toEqual(done.invoiceResult);
    expect(await fixture.state()).toEqual(final);
  });

  it("rolls back a real owner invoice when its matching command outcome is omitted", async () => {
    const b = await fixture.basis(), original = fixture.original(b.order.id), prepared = await prepare(original);
    const before = await fixture.state([...invoiceFactTables, "inventory_procurement_commands", "audit_events"]); let actualFactsReturned = false;
    await expect(withTenant(database.db, context, async tx => {
      await tx.execute(sql`select set_config('app.procurement_command_id',${prepared.id},true)`);
      const actual = await owner.recordInvoiceInTransaction(tx, context, b.order.id, original.input);
      expect(actual).toMatchObject({ status: "matched", allocationStatus: "complete", totalMinor: 120 }); actualFactsReturned = true;
      // Intentionally omit the command's success update after the real owner.
    })).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("invoice fact and actual original command outcome must commit together") });
    expect(actualFactsReturned).toBe(true); expect(await fixture.state(Object.keys(before))).toEqual(before);
  });

  it("refuses an unrelated 149 invoice proof and a 146 procurement proof as this invoice's outcome", async () => {
    const b = await fixture.basis(), other = fixture.original(b.order.id), recorded = await owner.recordInvoice(context, b.order.id, other.input);
    const otherProof = await proof(recorded.id), original = fixture.original(b.order.id), prepared = await prepare(original);
    const [oldProof] = await withTenant(database.db, context, tx => tx.select().from(inventoryProcurementWriteRequests)
      .where(and(eq(inventoryProcurementWriteRequests.purchaseOrderId, b.order.id), eq(inventoryProcurementWriteRequests.operation, "purchase_create"))));
    expect(oldProof).toBeDefined(); const before = await fixture.state([...invoiceFactTables, "inventory_procurement_commands"]);
    for (const update of [{ invoiceResultProofId: otherProof.id, resultProofId: null }, { invoiceResultProofId: null, resultProofId: oldProof!.id }]) {
      await expect(withTenant(database.db, context, async tx => {
        await tx.execute(sql`select set_config('app.procurement_command_id',${prepared.id},true)`);
        await tx.update(procurementCommands).set({ ...update, status: "succeeded", completedAt: sql`clock_timestamp()` }).where(eq(procurementCommands.id, prepared.id));
      })).rejects.toMatchObject({ cause: { code: "23514" } });
    }
    expect(await fixture.state(Object.keys(before))).toEqual(before);
  });

  it("never retroactively prepares a previously recorded actual invoice or invents a new original from a checksum", async () => {
    const b = await fixture.basis(), original = fixture.original(b.order.id), invoice = await owner.recordInvoice(context, b.order.id, original.input);
    const before = await fixture.state([...invoiceFactTables, "inventory_procurement_commands", "audit_events"]), binding = procurementCommandBinding(original);
    await expect(commands.prepare(context, original)).rejects.toMatchObject({ status: 409,
      response: expect.objectContaining({ code: "procurement_actual_already_recorded" }) });
    await expect(withTenant(database.db, context, tx => tx.insert(procurementCommands).values({ id: createEntityId(), tenantId: context.tenantId,
      createdBy: context.userId, kind: "invoice_record", operation: "invoice_record", targetId: b.order.id, requestKey: original.input.idempotencyKey,
      requestChecksum: binding.requestChecksum, authoritySnapshot: context, encryptedInput: new SecretVault(key).encrypt(canonicalJson(original)), expiresAt: sql`clock_timestamp()+interval '7 days'` })))
      .rejects.toMatchObject({ cause: { code: "23514", message: expect.stringContaining("an existing actual procurement cannot become a new prepared command") } });
    expect(await owner.recordInvoice(context, b.order.id, original.input)).toEqual(invoice);
    expect(await fixture.state(Object.keys(before))).toEqual(before);
  });

  it("serializes raw SQL and actual command execution on the same original key without deadlock", async () => {
    const b = await fixture.basis(), original = fixture.original(b.order.id), prepared = await prepare(original);
    const results = await Promise.allSettled([commands.execute(context, prepared.id), withTenant(database.db, context, tx => tx.insert(inventorySupplierInvoices).values({
      id: createEntityId(), tenantId: context.tenantId, purchaseOrderId: b.order.id, invoiceNumber: original.input.invoiceNumber,
      currency: "USD", totalMinor: 120, varianceMinor: 0, status: "matched", allocationStatus: "complete", issuedAt: new Date(original.input.issuedAt),
      idempotencyKey: original.input.idempotencyKey, createdBy: context.userId }))]);
    expect(results[0]!.status).toBe("fulfilled"); expect(results[1]!.status).toBe("rejected");
    if (results[1]!.status === "rejected") expect(results[1]!.reason).toMatchObject({ cause: { code: "23514" } });
    const invoices = await withTenant(database.db, context, tx => tx.select().from(inventorySupplierInvoices).where(eq(inventorySupplierInvoices.idempotencyKey, original.input.idempotencyKey)));
    expect(invoices).toHaveLength(1); expect((await commands.get(context, prepared.id)).invoiceResult!.id).toBe(invoices[0]!.id);
  }, 60_000);

  it("does not lock the order or concrete receipt during preparation and private original reads", async () => {
    const b = await fixture.basis(), original = fixture.original(b.order.id);
    let release!: () => void, ready!: () => void;
    const held = new Promise<void>(resolve => { ready = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
    const holder = withTenant(database.db, context, async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`procurement-order:${context.tenantId}:${b.order.id}`},0))`);
      const receipts = await tx.execute<{ id: string }>(sql`select l.id from inventory_procurement_receipt_lines l join inventory_procurement_receipts r on r.id=l.receipt_id and r.tenant_id=l.tenant_id where r.purchase_order_id=${b.order.id}`);
      for (const receipt of receipts) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`procurement-invoice-receipt:${context.tenantId}:${receipt.id}`},0))`);
      ready(); await released;
    });
    let pending: ReturnType<typeof prepare> | undefined, reading: ReturnType<typeof commands.get> | undefined;
    try {
      await held;
      pending = prepare(original);
      const outcome = await Promise.race([pending.then(value => ({ done: true as const, value })), delay(3000).then(() => ({ done: false as const }))]);
      expect(outcome.done).toBe(true);
      if (outcome.done) {
        reading = restarted().get(context, outcome.value.id);
        const read = await Promise.race([reading.then(value => ({ done: true as const, value })), delay(3000).then(() => ({ done: false as const }))]);
        expect(read.done).toBe(true);
        if (read.done) expect(read.value.original).toEqual(original);
      }
    } finally {
      release(); await holder;
      if (pending) await pending;
      if (reading) await reading;
    }
  }, 30_000);

  it("uses the actual remaining receipts at execution and cannot match stock consumed after preparation", async () => {
    const b = await fixture.basis(), original = fixture.original(b.order.id), prepared = await prepare(original);
    await owner.recordInvoice(context, b.order.id, fixture.original(b.order.id, { quantity: "0.2" }).input);
    const done = await commands.execute(context, prepared.id);
    expect(done.original).toEqual(original);
    expect(done.invoiceResult).toMatchObject({ totalMinor: 120, varianceMinor: 120, status: "reconciliation_required",
      allocationStatus: "reconciliation_required", lines: [{ allocatedQuantity: 0 }] });
    const allocations = await withTenant(database.db, context, tx => tx.select().from(inventorySupplierInvoiceAllocations)
      .innerJoin(inventorySupplierInvoiceLines, eq(inventorySupplierInvoiceLines.id, inventorySupplierInvoiceAllocations.invoiceLineId))
      .innerJoin(inventorySupplierInvoices, eq(inventorySupplierInvoices.id, inventorySupplierInvoiceLines.invoiceId)).where(eq(inventorySupplierInvoices.purchaseOrderId, b.order.id)));
    expect(sumStockQuantities(allocations.map(value => value.inventory_supplier_invoice_allocations.quantity))).toBe("0.2");
  });

  it("keeps one unacknowledged invoice per actor and purchase while allowing the next partial invoice after explicit confirmation", async () => {
    const b = await fixture.basis(), first = await actual(fixture.original(b.order.id), false);
    await expect(prepare(fixture.original(b.order.id))).rejects.toMatchObject({ status: 409,
      response: expect.objectContaining({ code: "procurement_original_unacknowledged" }) });
    await commands.acknowledge(context, first.id); owned.delete(first.id);
    const second = await actual(fixture.original(b.order.id)), third = await actual(fixture.original(b.order.id));
    expect(first.invoiceResult).toMatchObject({ status: "matched", totalMinor: 120 });
    expect(second.invoiceResult).toMatchObject({ status: "matched", totalMinor: 120 });
    expect(third.invoiceResult).toMatchObject({ status: "reconciliation_required", totalMinor: 120, varianceMinor: 120 });
  });

  it("rechecks current membership and keeps other actors and tenants outside the original invoice", async () => {
    const b = await fixture.basis(), original = fixture.original(b.order.id), prepared = await prepare(original), before = await fixture.state();
    await expect(commands.get(coworker, prepared.id)).rejects.toMatchObject({ status: 404 });
    await expect(commands.execute(coworker, prepared.id)).rejects.toMatchObject({ status: 404 });
    await expect(commands.get(outsider, prepared.id)).rejects.toMatchObject({ status: 404 });
    await fixture.setPermissions(context, procurementFixturePermissions.filter(permission => permission !== Permission.ProcurementWrite));
    expect(await commands.get(context, prepared.id)).toMatchObject({ canExecute: false, blockReason: "permission_denied" });
    await expect(commands.execute(context, prepared.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await fixture.state()).toEqual(before);
    await fixture.setPermissions(context, procurementFixturePermissions);
    expect((await commands.execute(context, prepared.id)).invoiceResult!.status).toBe("matched");
  });

  it("retains the encrypted original during a temporary wrong key and executes after the original key is restored", async () => {
    const b = await fixture.basis(), original = fixture.original(b.order.id), prepared = await prepare(original), saved = await row(prepared.id), before = await fixture.state();
    const temporary = randomBytes(32);
    try {
      const wrong = new ProcurementCommandService(database, new SecretVault(temporary), owner, audit);
      expect(await wrong.get(context, prepared.id)).toMatchObject({ status: "prepared", original: null, canExecute: false, blockReason: "input_unavailable" });
      await expect(wrong.execute(context, prepared.id)).rejects.toMatchObject({ status: 409,
        response: expect.objectContaining({ code: "procurement_original_unavailable" }) });
      expect(protectedOriginal(await row(prepared.id))).toEqual(protectedOriginal(saved)); expect(await fixture.state()).toEqual(before);
    } finally { temporary.fill(0); }
    expect((await restarted().get(context, prepared.id)).original).toEqual(original);
    expect((await restarted().execute(context, prepared.id)).invoiceResult!.status).toBe("matched");
  });

  it("cancels without invoice facts and acknowledges a real invoice without deleting its immutable result", async () => {
    const b = await fixture.basis(), original = fixture.original(b.order.id), prepared = await prepare(original), before = await fixture.state();
    expect(await commands.cancel(context, prepared.id)).toMatchObject({ status: "cancelled", original: null, result: null, invoiceResult: null });
    expect(await fixture.state()).toEqual(before); await commands.acknowledge(context, prepared.id); owned.delete(prepared.id);
    const done = await actual(fixture.original(b.order.id), false), facts = await fixture.state();
    const acknowledged = await commands.acknowledge(context, done.id);
    expect(acknowledged).toMatchObject({ acknowledged: true, original: null, status: "succeeded", result: done.result, invoiceResult: done.invoiceResult });
    expect((await commands.execute(context, done.id)).invoiceResult).toEqual(done.invoiceResult); expect(await fixture.state()).toEqual(facts);
  });

  it("expires only due invoice originals with zero business permissions and preserves 149 proofs and allocations", async () => {
    const b = await fixture.basis(), other = await fixture.basis(), done = await actual(fixture.original(b.order.id), false), pending = await prepare(fixture.original(other.order.id));
    requireInvoiceCommandFixture();
    await database.client.begin(async synthetic => {
      await synthetic.unsafe("set local session_replication_role=replica");
      await synthetic.unsafe("update inventory_procurement_commands set created_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 day' where tenant_id=$1 and id in($2,$3)", [context.tenantId, done.id, pending.id]);
    });
    const before = await fixture.state(), maintenance: TenantContext = { tenantId: context.tenantId, userId: "00000000-0000-7000-8000-000000000006", permissions: [], dataScope: "tenant" };
    expect(await withTenant(database.db, maintenance, tx => expireProcurementCommandInputs(tx, { commandId: done.id }))).toBe(1);
    expect(await withTenant(database.db, maintenance, tx => expireProcurementCommandInputs(tx, { commandId: pending.id }))).toBe(1);
    expect(await commands.get(context, done.id)).toMatchObject({ status: "succeeded", original: null, invoiceResult: done.invoiceResult });
    expect(await commands.execute(context, pending.id)).toMatchObject({ status: "expired", original: null, invoiceResult: null, result: null });
    expect(await fixture.state()).toEqual(before);
  });

  it("lists the actor's invoice original through the exact source filter and excludes coworkers", async () => {
    const b = await fixture.basis(), original = fixture.original(b.order.id), prepared = await prepare(original);
    expect(ProcurementCommandListSchema.parse(await commands.list(context, { kind: "invoice_record", targetId: b.order.id })).items.map(value => value.id)).toContain(prepared.id);
    expect(ProcurementCommandListSchema.parse(await commands.list(coworker, { kind: "invoice_record", targetId: b.order.id })).items).toEqual([]);
  });

  it.each(["before_commit", "after_commit"] as const)("restores the original invoice after a real API is killed at %s", async phase => {
    identity ??= await startFactoryIdentityFixture(context.tenantId, `procurement-command-${context.userId}`, "http://localhost:3130", { application: "erp", clientId: "yummyai-web" });
    const b = await fixture.basis(), original = fixture.original(b.order.id), prepared = await prepare(original), token = await identity.operatorToken();
    const saved = protectedOriginal(await row(prepared.id)), before = await fixture.state();
    const interrupted = startInvoiceApi(identity, key, { phase, commandId: prepared.id }); children.push(interrupted);
    const response = invoiceApiRequest(interrupted, token, `/${prepared.id}/execute`, {}).then(value => ({ received: true, status: value.status }), () => ({ received: false, status: 0 }));
    expect(await interrupted.wait("procurement.fixture.barrier", phase)).toMatchObject({ phase, commandId: prepared.id, pid: interrupted.child.pid });
    expect((await row(prepared.id)).status).toBe(phase === "before_commit" ? "prepared" : "succeeded");
    await interrupted.stop(true); expect((await response).received).toBe(false);
    if (phase === "before_commit") expect(await fixture.state()).toEqual(before);
    const fresh = startInvoiceApi(identity, key); children.push(fresh);
    const read = await invoiceApiRequest(fresh, token, `/${prepared.id}`); expect(read.status).toBe(200);
    expect(ProcurementCommandViewSchema.parse(await read.json())).toMatchObject({ id: prepared.id, original, status: phase === "before_commit" ? "prepared" : "succeeded" });
    const execute = await invoiceApiRequest(fresh, token, `/${prepared.id}/execute`, {}); expect(execute.status).toBe(200);
    const actual = ProcurementCommandViewSchema.parse(await execute.json());
    expect(actual.invoiceResult).toMatchObject({ invoiceNumber: original.input.invoiceNumber, purchaseOrderId: b.order.id, status: "matched", totalMinor: 120,
      lines: [{ invoicedQuantity: "0.1", allocatedQuantity: "0.1" }] });
    const proofRow = await proof(actual.result!.id); expect((await row(prepared.id)).invoiceResultProofId).toBe(proofRow.id);
    expect(proofRow.createdBy).toBe(context.userId); expect(protectedOriginal(await row(prepared.id))).toEqual(saved);
    const facts = await fixture.state();
    const repeated = await invoiceApiRequest(fresh, token, `/${prepared.id}/execute`, {}); expect(repeated.status).toBe(200);
    expect(ProcurementCommandViewSchema.parse(await repeated.json()).invoiceResult).toEqual(actual.invoiceResult);
    expect(await fixture.state()).toEqual(facts);
    const invoices = await withTenant(database.db, context, tx => tx.select().from(inventorySupplierInvoices).where(eq(inventorySupplierInvoices.idempotencyKey, original.input.idempotencyKey)));
    expect(invoices).toHaveLength(1); await fresh.stop();
  }, 120_000);
});
