import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { SecretVault } from "@yummyai/ai-core";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { canonicalFinancePayablesRequest, type RecordFinanceBillInput, type RecordFinancePaymentInput } from "@yummyai/contracts/finance/payables";
import type { InvoiceReconciliationInput } from "@yummyai/contracts/procurement/invoice-reconciliation";
import { connectDatabase, migrateDatabase, withTenant, roles, memberships, fulfillmentSuppliers, financePayablePayments,
  financePaymentAllocationBatches, financePaymentAllocations, inventorySupplierInvoiceRequests, inventoryProcurementReceiptLines } from "@yummyai/database";
import { procurementCommandFixture, procurementFixturePermissions } from "../procurement/procurement-command.fixtures.js";
import { ProcurementCommandService } from "../procurement/procurement-command.service.js";
import { InvoiceReconciliationService } from "../procurement/invoice-reconciliation.service.js";
import { IncomingInspectionService } from "../procurement/incoming-inspection.service.js";
import { FinancePayablesService } from "./finance-payables.service.js";

const disposable = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FINANCE_PAYABLES_ISOLATED !== "1" || !["postgres:", "postgresql:"].includes(disposable.protocol)
  || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(disposable.pathname)) throw new Error("Finance payables requires its isolated disposable database before connection");
const key = () => `synthetic-payables-${randomUUID()}`;
const tables = ["finance_payable_bills", "finance_payable_payments", "finance_payment_allocation_batches", "finance_payment_allocations", "finance_allocation_releases"];
const unchangedTables = ["finance_facts", "finance_statements", "inventory_supplier_invoices", "inventory_supplier_invoice_lines", "inventory_supplier_invoice_requests",
  "inventory_supplier_invoice_allocations", "inventory_lots", "inventory_movements", "inventory_balances"];
const permissions = [...procurementFixturePermissions, Permission.FinanceRead, Permission.FinanceWrite, Permission.FinanceReview];

describe.sequential("actual supplier payables, recorded payments and reversible allocations", () => {
  const database = connectDatabase(), fixture = procurementCommandFixture(database), context = { ...fixture.context, permissions }, coworker = { ...fixture.coworker, permissions }, outsider = { ...fixture.outsider, permissions };
  const service = new FinancePayablesService(database, fixture.audit), secret = randomBytes(32), commands = new ProcurementCommandService(database, new SecretVault(secret), fixture.owner, fixture.audit);
  const reconciliation = new InvoiceReconciliationService(database, fixture.audit), incoming = new IncomingInspectionService(database, fixture.owner, fixture.audit);
  let secondSupplier: string;
  beforeAll(async () => {
    await migrateDatabase(database); await fixture.initialize();
    for (const actor of [context, coworker, outsider]) await rights(actor, permissions);
    secondSupplier = createEntityId(); await withTenant(database.db, context, tx => tx.insert(fulfillmentSuppliers).values({ id: secondSupplier,
      tenantId: context.tenantId, name: "Synthetic second payable supplier", kind: "manual", status: "active", regionCode: "US", settlementCurrency: "USD", createdBy: context.userId }));
  }, 60_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const actor of [context, coworker, outsider]) {
      await rights(actor, permissions);
      await withTenant(database.db, actor, tx => tx.update(memberships).set({ status: "active" }).where(eq(memberships.userId, actor.userId)));
    }
  });
  afterAll(async () => { secret.fill(0); await database.client.end(); });
  async function rights(actor: TenantContext, granted: string[], scope: "self" | "tenant" = "tenant") {
    await withTenant(database.db, actor, tx => tx.update(roles).set({ permissions: granted, dataScope: scope }).where(eq(roles.id, fixture.roleIds.get(actor.userId)!)));
  }
  function billInput(amountMinor = 10000, overrides: Partial<RecordFinanceBillInput> = {}): RecordFinanceBillInput {
    return { supplierId: fixture.supplierId, kind: "factory_invoice", externalBillId: key(), currency: "USD", amountMinor,
      issuedAt: "2026-07-01T00:00:00.000Z", dueAt: null, procurementInvoiceId: null, idempotencyKey: key(), ...overrides };
  }
  function paymentInput(amountMinor = 10000, overrides: Partial<RecordFinancePaymentInput> = {}): RecordFinancePaymentInput {
    return { supplierId: fixture.supplierId, externalPaymentId: key(), currency: "USD", amountMinor, paidAt: "2026-07-02T00:00:00.000Z",
      method: "bank_transfer", evidenceReference: key(), idempotencyKey: key(), ...overrides };
  }
  const bill = (amount = 10000, overrides: Partial<RecordFinanceBillInput> = {}) => service.recordBill(context, billInput(amount, overrides));
  const payment = (amount = 10000, overrides: Partial<RecordFinancePaymentInput> = {}) => service.recordPayment(context, paymentInput(amount, overrides));
  const allocate = (paymentId: string, billId: string, amountMinor: number) => service.allocate(context, { paymentId, allocations: [{ billId, amountMinor }], idempotencyKey: key() });
  async function state(selected = [...tables, ...unchangedTables]) {
    return withTenant(database.db, context, async tx => {
      const result: Record<string, { count: number; hash: string }> = {};
      for (const table of selected) { const rows = await tx.execute(sql`select * from ${sql.identifier(table)} order by id`); result[table] = { count: rows.length, hash: createHash("sha256").update(JSON.stringify(rows)).digest("hex") }; }
      return result;
    });
  }
  const workspace = () => service.workspace(context);
  const denied = (error: unknown) => error instanceof ForbiddenError || (error as { status?: number }).status === 403;
  const pgCode = (error: unknown) => { const value = error as { code?: string; cause?: { code?: string } }; return value.cause?.code ?? value.code; };
  const pgMessage = (error: unknown) => { const value = error as { message?: string; cause?: { message?: string } }; return value.cause?.message ?? value.message ?? ""; };

  it("records partial and combined actual payments without adding another cost or changing procurement facts", async () => {
    const a = await bill(10000), b = await bill(5000), paid = await payment(12000), before = await state(unchangedTables);
    const batch = await service.allocate(context, { paymentId: paid.id, allocations: [{ billId: a.id, amountMinor: 7000 }, { billId: b.id, amountMinor: 5000 }], idempotencyKey: key() });
    expect(batch.allocations).toHaveLength(2); const first = await workspace();
    expect(first.bills.find(row => row.id === a.id)).toMatchObject({ allocatedMinor: 7000, outstandingMinor: 3000, status: "partially_allocated" });
    expect(first.bills.find(row => row.id === b.id)).toMatchObject({ allocatedMinor: 5000, outstandingMinor: 0, status: "fully_allocated" });
    expect(first.payments.find(row => row.id === paid.id)).toMatchObject({ evidenceStatus: "operator_recorded", allocatedMinor: 12000, unallocatedMinor: 0 });
    const remainder = await payment(3000); await allocate(remainder.id, a.id, 3000);
    expect((await workspace()).bills.find(row => row.id === a.id)).toMatchObject({ outstandingMinor: 0, status: "fully_allocated" });
    expect(await state(unchangedTables)).toEqual(before);
  });
  it("appends a release once, frees the actual balances and reallocates without deleting original money", async () => {
    const due = await bill(), paid = await payment(), batch = await allocate(paid.id, due.id, 6000), original = batch.allocations[0]!;
    const before = await state(unchangedTables), releaseInput = { reasonCode: "WRONG_BILL", idempotencyKey: key() };
    const released = await service.release(context, original.id, releaseInput); expect(released.allocationId).toBe(original.id);
    expect(await service.release(context, original.id, releaseInput)).toEqual(released);
    await expect(service.release(context, original.id, { ...releaseInput, idempotencyKey: key() })).rejects.toMatchObject({ status: 409 });
    const after = await workspace(); expect(after.bills.find(row => row.id === due.id)).toMatchObject({ allocatedMinor: 0, outstandingMinor: 10000 });
    expect(after.payments.find(row => row.id === paid.id)).toMatchObject({ amountMinor: 10000, allocatedMinor: 0, unallocatedMinor: 10000 });
    expect(after.allocations.find(row => row.id === original.id)).toMatchObject({ released: true, amountMinor: 6000 });
    await allocate(paid.id, due.id, 10000); expect((await workspace()).bills.find(row => row.id === due.id)!.outstandingMinor).toBe(0);
    const [stored] = await withTenant(database.db, context, tx => tx.select().from(financePaymentAllocations).where(eq(financePaymentAllocations.id, original.id)));
    expect(stored).toMatchObject({ amountMinor: 6000, paymentId: paid.id, billId: due.id }); expect(await state(unchangedTables)).toEqual(before);
  });
  it("binds bill and payment keys to the original actor, source and body", async () => {
    const originalBill = billInput(), originalPayment = paymentInput(), a = await service.recordBill(context, originalBill), p = await service.recordPayment(context, originalPayment), before = await state();
    expect((await service.recordBill(context, originalBill)).id).toBe(a.id); expect((await service.recordPayment(context, originalPayment)).id).toBe(p.id);
    for (const changed of [{ ...originalBill, amountMinor: 9999 }, { ...originalBill, supplierId: secondSupplier }]) await expect(service.recordBill(context, changed)).rejects.toMatchObject({ status: 409 });
    await expect(service.recordBill(coworker, originalBill)).rejects.toMatchObject({ status: 409 });
    await expect(service.recordPayment(context, { ...originalPayment, amountMinor: 9999 })).rejects.toMatchObject({ status: 409 });
    await expect(service.recordPayment(coworker, originalPayment)).rejects.toMatchObject({ status: 409 }); expect(await state()).toEqual(before);
  });
  it("does not record the same supplier bill or payment reference twice under a new request key", async () => {
    const source = billInput(), paid = paymentInput(); await service.recordBill(context, source); await service.recordPayment(context, paid); const before = await state();
    await expect(service.recordBill(context, { ...source, idempotencyKey: key() })).rejects.toMatchObject({ status: 409 });
    await expect(service.recordPayment(context, { ...paid, idempotencyKey: key() })).rejects.toMatchObject({ status: 409 }); expect(await state()).toEqual(before);
    expect((await bill(10000, { supplierId: secondSupplier, externalBillId: source.externalBillId })).supplierId).toBe(secondSupplier);
  });
  it("keeps allocation and release keys bound after the balances or target change", async () => {
    const a = await bill(), b = await bill(), paid = await payment(20000), original = { paymentId: paid.id, allocations: [{ billId: a.id, amountMinor: 1000 }], idempotencyKey: key() };
    const batch = await service.allocate(context, original), other = await allocate(paid.id, b.id, 1000), releaseInput = { reasonCode: "WRONG_BILL", idempotencyKey: key() };
    expect((await service.allocate(context, original)).id).toBe(batch.id);
    const before = await state(); await expect(service.allocate(context, { ...original, allocations: [{ billId: a.id, amountMinor: 1001 }] })).rejects.toMatchObject({ status: 409 });
    await expect(service.allocate(coworker, original)).rejects.toMatchObject({ status: 409 }); expect(await state()).toEqual(before);
    await service.release(context, batch.allocations[0]!.id, releaseInput); const released = await state();
    await expect(service.release(context, other.allocations[0]!.id, releaseInput)).rejects.toMatchObject({ status: 409 });
    await expect(service.release(context, batch.allocations[0]!.id, { ...releaseInput, reasonCode: "OTHER_REASON" })).rejects.toMatchObject({ status: 409 }); expect(await state()).toEqual(released);
  });
  it("refuses supplier and currency mixing without partial allocations or automatic FX", async () => {
    const paid = await payment(), foreign = await bill(10000, { supplierId: secondSupplier }), euro = await bill(10000, { currency: "EUR" }), valid = await bill(), before = await state();
    for (const target of [foreign, euro]) await expect(service.allocate(context, { paymentId: paid.id, allocations: [{ billId: valid.id, amountMinor: 100 }, { billId: target.id, amountMinor: 100 }], idempotencyKey: key() })).rejects.toMatchObject({ status: 409 });
    expect(await state()).toEqual(before);
  });
  it("retains the safe integer boundary and rejects an overflowing batch sum before saving", async () => {
    const due = await bill(Number.MAX_SAFE_INTEGER), paid = await payment(Number.MAX_SAFE_INTEGER); await allocate(paid.id, due.id, Number.MAX_SAFE_INTEGER);
    expect((await workspace()).bills.find(row => row.id === due.id)).toMatchObject({ outstandingMinor: 0, allocatedMinor: Number.MAX_SAFE_INTEGER });
    const extra = await bill(1), before = await state();
    await expect(service.allocate(context, { paymentId: paid.id, allocations: [{ billId: due.id, amountMinor: Number.MAX_SAFE_INTEGER }, { billId: extra.id, amountMinor: 1 }], idempotencyKey: key() })).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it.each(["ZZZ", "XXX"])("rejects %s bills and payments without a guessed minor unit", async currency => {
    const before = await state(); await expect(bill(100, { currency })).rejects.toThrow(); await expect(payment(100, { currency })).rejects.toThrow(); expect(await state()).toEqual(before);
  });
  it.each(["payment", "bill"] as const)("serializes competing allocations against one %s remainder", async dimension => {
    const due = await bill(100), otherBill = dimension === "payment" ? await bill(100) : due;
    const paid = await payment(100), otherPayment = dimension === "bill" ? await payment(100) : paid;
    const results = await Promise.allSettled([allocate(paid.id, due.id, 100), allocate(otherPayment.id, otherBill.id, 100)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    const current = await workspace(), allocations = current.allocations.filter(row => [due.id, otherBill.id].includes(row.billId) && [paid.id, otherPayment.id].includes(row.paymentId) && !row.released);
    expect(allocations.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n)).toBe(100n);
  });
  it.each(["bill", "payment", "allocation", "release"] as const)("rolls %s and its audit back together when the final audit is unavailable", async action => {
    const due = await bill(), paid = await payment(), existing = action === "release" ? await allocate(paid.id, due.id, 1000) : null;
    const inputBill = billInput(), inputPayment = paymentInput(), inputAllocation = { paymentId: paid.id, allocations: [{ billId: due.id, amountMinor: 1000 }], idempotencyKey: key() }, inputRelease = { reasonCode: "WRONG_BILL", idempotencyKey: key() };
    const invoke = () => action === "bill" ? service.recordBill(context, inputBill) : action === "payment" ? service.recordPayment(context, inputPayment)
      : action === "allocation" ? service.allocate(context, inputAllocation) : service.release(context, existing!.allocations[0]!.id, inputRelease);
    const before = await state([...tables, ...unchangedTables, "audit_events"]), spy = vi.spyOn(fixture.audit, "recordInTransaction").mockRejectedValue(new Error("Synthetic payables final audit unavailable"));
    await expect(invoke()).rejects.toThrow("Synthetic payables final audit unavailable"); expect(spy).toHaveBeenCalledOnce(); expect(await state([...tables, ...unchangedTables, "audit_events"])).toEqual(before);
    spy.mockRestore(); await expect(invoke()).resolves.toBeDefined();
  });
  it("rechecks current write and review rights even on a replay while allowing authorized reading", async () => {
    const inputBill = billInput(), inputPayment = paymentInput(), due = await service.recordBill(context, inputBill), paid = await service.recordPayment(context, inputPayment);
    const input = { paymentId: paid.id, allocations: [{ billId: due.id, amountMinor: 100 }], idempotencyKey: key() }, batch = await service.allocate(context, input);
    await rights(context, permissions.filter(permission => permission !== Permission.FinanceWrite)); const before = await state();
    await expect(service.recordBill(context, inputBill)).rejects.toSatisfy(denied); await expect(service.recordPayment(context, inputPayment)).rejects.toSatisfy(denied);
    expect((await workspace()).permissions.canWrite).toBe(false); expect(await state()).toEqual(before);
    await rights(context, permissions.filter(permission => permission !== Permission.FinanceReview));
    await expect(service.allocate(context, input)).rejects.toSatisfy(denied);
    await expect(service.release(context, batch.allocations[0]!.id, { reasonCode: "WRONG_BILL", idempotencyKey: key() })).rejects.toSatisfy(denied);
    expect((await workspace()).permissions.canReview).toBe(false); expect(await state()).toEqual(before);
  });
  it("rejects a disabled membership and a self scope before an old caller can write", async () => {
    const original = billInput(); await rights(context, permissions, "self"); await expect(service.recordBill(context, original)).rejects.toSatisfy(denied);
    await rights(context, permissions); await withTenant(database.db, context, tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.userId, context.userId)));
    await expect(service.recordBill(context, original)).rejects.toSatisfy(denied); await expect(workspace()).rejects.toSatisfy(denied);
  });
  it("keeps tenant RLS forced and all five financial histories immutable", async () => {
    const due = await bill(), paid = await payment(), batch = await allocate(paid.id, due.id, 100), released = await service.release(context, batch.allocations[0]!.id, { reasonCode: "WRONG_BILL", idempotencyKey: key() });
    expect(released.id).toBeDefined(); const foreign = await service.workspace(outsider); expect(foreign.bills).toEqual([]); expect(foreign.payments).toEqual([]);
    await expect(service.recordBill(outsider, billInput())).rejects.toMatchObject({ status: 404 });
    for (const table of tables) {
      const [policy] = await withTenant(database.db, context, tx => tx.execute<{ enabled: boolean; forced: boolean; canUpdate: boolean; canDelete: boolean }>(sql`select relrowsecurity as enabled,relforcerowsecurity as forced,
        has_table_privilege(current_user,${table},'UPDATE') as "canUpdate",has_table_privilege(current_user,${table},'DELETE') as "canDelete" from pg_class where oid=${table}::regclass`));
      expect(policy).toEqual({ enabled: true, forced: true, canUpdate: false, canDelete: false });
      expect(await withTenant(database.db, outsider, tx => tx.execute(sql`select * from ${sql.identifier(table)}`))).toEqual([]);
      await expect(withTenant(database.db, context, tx => tx.execute(sql`update ${sql.identifier(table)} set id=id`))).rejects.toThrow();
      await expect(withTenant(database.db, context, tx => tx.execute(sql`delete from ${sql.identifier(table)}`))).rejects.toThrow();
    }
  });
  it("physically rejects unsafe raw money and an incomplete or overdrawn allocation batch", async () => {
    const due = await bill(100), paid = await payment(100), before = await state();
    const [originalPayment] = await withTenant(database.db, context, tx => tx.select().from(financePayablePayments).where(eq(financePayablePayments.id, paid.id)));
    await expect(withTenant(database.db, context, tx => tx.insert(financePayablePayments).values({ ...originalPayment!, id: createEntityId(), externalPaymentId: key(), idempotencyKey: key(), amountMinor: sql`9007199254740992` }))).rejects.toSatisfy((error: unknown) => pgCode(error) === "23514");
    for (const requested of [1, 101]) await expect(withTenant(database.db, context, async tx => {
      const input = { paymentId: paid.id, allocations: [{ billId: due.id, amountMinor: requested }], idempotencyKey: key() }, id = createEntityId();
      await tx.insert(financePaymentAllocationBatches).values({ id, tenantId: context.tenantId, paymentId: paid.id, input, idempotencyKey: input.idempotencyKey,
        requestChecksum: createHash("sha256").update(canonicalFinancePayablesRequest("allocation", input)).digest("hex"), recordedBy: context.userId });
      if (requested === 101) await tx.insert(financePaymentAllocations).values({ id: createEntityId(), tenantId: context.tenantId, batchId: id, paymentId: paid.id,
        billId: due.id, supplierId: fixture.supplierId, currency: "USD", amountMinor: requested, recordedBy: context.userId });
      await fixture.audit.recordInTransaction(tx, context, { action: "finance.payables.payment_allocated", resourceType: "finance_payment_allocation_batch",
        resourceId: id, result: "success", metadata: { paymentId: paid.id } });
    })).rejects.toSatisfy((error: unknown) => pgCode(error) === "23514" && pgMessage(error).includes(requested === 1 ? "finance_payables_batch_incomplete" : "finance_payables_allocation_exceeds_evidence"));
    expect(await state()).toEqual(before);
  });
  it.each(["numeric_key", "numeric_payment_id", "scalar_input", "scalar_allocation"] as const)("rejects raw %s even with its exact SQL checksum and matching transaction audit", async shape => {
    const due = await bill(100), paid = await payment(100), requestKey = shape === "numeric_key" ? "12345678" : key(), id = createEntityId();
    const input = { paymentId: paid.id, allocations: [{ billId: due.id, amountMinor: 1 }], idempotencyKey: requestKey };
    const body: unknown = shape === "numeric_key" ? { ...input, idempotencyKey: 12345678 } : shape === "numeric_payment_id" ? { ...input, paymentId: 12345678 }
      : shape === "scalar_input" ? "synthetic scalar" : { ...input, allocations: [7] };
    const before = await state([...tables, "audit_events"]);
    await expect(withTenant(database.db, context, async tx => {
      await fixture.audit.recordInTransaction(tx, context, { action: "finance.payables.payment_allocated", resourceType: "finance_payment_allocation_batch", resourceId: id, result: "success" });
      await tx.execute(sql`insert into finance_payment_allocation_batches(id,tenant_id,payment_id,input,idempotency_key,request_checksum,recorded_by)
        values(${id},${context.tenantId},${paid.id},${JSON.stringify(body)}::jsonb,${requestKey},
          finance_payables_checksum('allocation',null::uuid,${JSON.stringify(body)}::jsonb),${context.userId})`);
    })).rejects.toSatisfy((error: unknown) => pgCode(error) === "23514" && pgMessage(error).includes(shape === "scalar_allocation" ? "finance_payables_batch_item_invalid" : "finance_payables_batch_invalid"));
    expect(await state([...tables, "audit_events"])).toEqual(before);
  });
  it("rejects a non-RFC UUIDv7 variant for a raw financial receipt without relying on missing audit", async () => {
    const input = paymentInput(100), parts = createEntityId().split("-"); parts[3] = `0${parts[3]!.slice(1)}`; const id = parts.join("-");
    const before = await state([...tables, "audit_events"]);
    await expect(withTenant(database.db, context, async tx => {
      await fixture.audit.recordInTransaction(tx, context, { action: "finance.payables.payment_recorded", resourceType: "finance_payable_payment", resourceId: id, result: "success" });
      await tx.insert(financePayablePayments).values({ ...input, paidAt: new Date(input.paidAt), id, tenantId: context.tenantId,
        requestChecksum: createHash("sha256").update(canonicalFinancePayablesRequest("payment", input)).digest("hex"), recordedBy: context.userId });
    })).rejects.toSatisfy((error: unknown) => pgCode(error) === "23514" && pgMessage(error).includes("finance_payables_authority_invalid"));
    expect(await state([...tables, "audit_events"])).toEqual(before);
  });
  it.each(["infinity", "10000-01-01T00:00:00Z", "2026-07-02T00:00:00.000001Z"])("rejects untransportable raw paidAt %s with an exact SQL-computed original checksum", async paidAt => {
    const input = paymentInput(100), id = createEntityId(), body = JSON.stringify({ ...input, paidAt }), before = await state([...tables, "audit_events"]);
    await expect(withTenant(database.db, context, async tx => {
      await fixture.audit.recordInTransaction(tx, context, { action: "finance.payables.payment_recorded", resourceType: "finance_payable_payment", resourceId: id, result: "success" });
      await tx.insert(financePayablePayments).values({ ...input, paidAt: sql`${paidAt}::timestamptz`, id, tenantId: context.tenantId, recordedBy: context.userId,
        requestChecksum: sql`finance_payables_checksum('payment',null::uuid,jsonb_set(${body}::jsonb,'{paidAt}',
          coalesce(to_jsonb(to_char(${paidAt}::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'null'::jsonb)))` });
    })).rejects.toSatisfy((error: unknown) => pgCode(error) === "23514" && pgMessage(error).includes("finance_payable_payment_date"));
    expect(await state([...tables, "audit_events"])).toEqual(before);
  });
  it("assigns raw recordedAt from the actual database millisecond clock while retaining the supplied business time", async () => {
    const input = paymentInput(100), id = createEntityId();
    const row = await withTenant(database.db, context, async tx => {
      const [created] = await tx.insert(financePayablePayments).values({ ...input, id, tenantId: context.tenantId, paidAt: new Date(input.paidAt),
        recordedAt: new Date("2099-01-01T00:00:00.000Z"), requestChecksum: createHash("sha256").update(canonicalFinancePayablesRequest("payment", input)).digest("hex"), recordedBy: context.userId }).returning();
      await fixture.audit.recordInTransaction(tx, context, { action: "finance.payables.payment_recorded", resourceType: "finance_payable_payment", resourceId: id, result: "success" });
      const [precision] = await tx.execute<{ exact: boolean }>(sql`select recorded_at=date_trunc('milliseconds',recorded_at) as exact from finance_payable_payments where id=${id}`);
      expect(precision!.exact).toBe(true); return created!;
    });
    expect(row.recordedAt.toISOString()).not.toBe("2099-01-01T00:00:00.000Z"); expect(row.paidAt.toISOString()).toBe(input.paidAt);
  });
  it("enforces a payment capacity sum across all raw rows of one combined multi-bill INSERT", async () => {
    const a = await bill(100), b = await bill(100), paid = await payment(100), input = { paymentId: paid.id,
      allocations: [{ billId: a.id, amountMinor: 60 }, { billId: b.id, amountMinor: 60 }], idempotencyKey: key() }, id = createEntityId();
    const before = await state([...tables, "audit_events"]);
    await expect(withTenant(database.db, context, async tx => {
      await tx.insert(financePaymentAllocationBatches).values({ id, tenantId: context.tenantId, paymentId: paid.id, input,
        idempotencyKey: input.idempotencyKey, requestChecksum: createHash("sha256").update(canonicalFinancePayablesRequest("allocation", input)).digest("hex"), recordedBy: context.userId });
      await fixture.audit.recordInTransaction(tx, context, { action: "finance.payables.payment_allocated", resourceType: "finance_payment_allocation_batch", resourceId: id, result: "success" });
      await tx.insert(financePaymentAllocations).values(input.allocations.map(item => ({ id: createEntityId(), tenantId: context.tenantId,
        batchId: id, paymentId: paid.id, billId: item.billId, supplierId: fixture.supplierId, currency: "USD", amountMinor: item.amountMinor, recordedBy: context.userId })));
    })).rejects.toSatisfy((error: unknown) => pgCode(error) === "23514" && pgMessage(error).includes("finance_payables_allocation_exceeds_evidence"));
    expect(await state([...tables, "audit_events"])).toEqual(before);
  });
  it("pins a real new procurement invoice proof and refuses wrong supplier, currency, amount or duplicate source", async () => {
    const source = await procurementSource(), original = sourceBill(source);
    for (const changed of [{ ...original, supplierId: secondSupplier }, { ...original, currency: "EUR" }, { ...original, amountMinor: original.amountMinor + 1 }])
      await expect(service.recordBill(context, { ...changed, idempotencyKey: key() })).rejects.toMatchObject({ status: 409 });
    const recorded = await service.recordBill(context, original); expect(recorded).toMatchObject({ procurementProofId: source.proof.id, sourceStatus: "current", amountMinor: source.invoice.totalMinor });
    await expect(service.recordBill(context, { ...original, externalBillId: key(), idempotencyKey: key() })).rejects.toMatchObject({ status: 409 });
  });
  it("waits for actual later accepted stock and an immutable receipt-match event before allocating a procurement bill", async () => {
    const source = await procurementSource(false), due = await service.recordBill(context, sourceBill(source)), paid = await payment(source.invoice.totalMinor);
    expect(due.sourceStatus).toBe("source_unreconciled"); const before = await state(tables);
    await expect(allocate(paid.id, due.id, due.amountMinor)).rejects.toMatchObject({ status: 409, response: { code: "finance_payables_source_unreconciled" } });
    expect(await state(tables)).toEqual(before);
    const receipt = await receive(source.order.id, source.basis.stock.id), detail = await reconciliation.detail(context, source.invoice.id);
    await executeReconciliation(source.invoice.id, { action: "receipt_match", expectedFingerprint: detail.fingerprint,
      reason: "Synthetic actual later receipt checked", idempotencyKey: key(), lines: [{ invoiceLineId: detail.balance.lines[0]!.invoiceLineId,
        receiptLineId: receipt.id, quantity: 20, unit: "each" }] });
    expect((await workspace()).bills.find(row => row.id === due.id)!.sourceStatus).toBe("current");
    await allocate(paid.id, due.id, due.amountMinor);
    expect((await workspace()).bills.find(row => row.id === due.id)).toMatchObject({ allocatedMinor: due.amountMinor, outstandingMinor: 0 });
  });
  it("blocks allocation while an actual supplier adjustment is pending and reopens it only after rejection", async () => {
    const source = await procurementSource(), due = await service.recordBill(context, sourceBill(source)), paid = await payment(source.invoice.totalMinor);
    const detail = await reconciliation.detail(context, source.invoice.id), recorded = await executeReconciliation(source.invoice.id, {
      action: "adjustment_record", expectedFingerprint: detail.fingerprint, reason: "Synthetic supplier document awaits review", idempotencyKey: key(),
      document: { kind: "credit_note", number: key(), currency: "USD", issuedAt: "2026-07-01T00:00:00.000Z", evidenceReference: "SYNTHETIC-CREDIT-REFERENCE" },
      lines: [{ invoiceLineId: detail.balance.lines[0]!.invoiceLineId, quantity: 0, unit: "each", amountMinor: 1 }],
    });
    expect((await workspace()).bills.find(row => row.id === due.id)!.sourceStatus).toBe("source_unreconciled");
    await expect(allocate(paid.id, due.id, 100)).rejects.toMatchObject({ status: 409, response: { code: "finance_payables_source_unreconciled" } });
    const pending = await reconciliation.detail(context, source.invoice.id);
    await executeReconciliation(source.invoice.id, { action: "adjustment_review", expectedFingerprint: pending.fingerprint,
      adjustmentId: recorded.result!.id, decision: "rejected", reason: "Synthetic supplier document rejected", idempotencyKey: key() });
    expect((await workspace()).bills.find(row => row.id === due.id)!.sourceStatus).toBe("current"); await allocate(paid.id, due.id, 100);
  });
  it("blocks new allocations after an actual approved procurement credit but still permits releasing an original allocation", async () => {
    const source = await procurementSource(), due = await service.recordBill(context, sourceBill(source)), paid = await payment(source.invoice.totalMinor);
    const batch = await allocate(paid.id, due.id, 100), original = await reconciliation.detail(context, source.invoice.id);
    const record = await commands.prepare(context, { kind: "invoice_reconcile", targetId: source.invoice.id, input: { action: "adjustment_record",
      expectedFingerprint: original.fingerprint, reason: "Synthetic actual supplier credit", idempotencyKey: key(), document: { kind: "credit_note", number: key(), currency: "USD",
        issuedAt: "2026-07-01T00:00:00.000Z", evidenceReference: "SYNTHETIC-CREDIT-REFERENCE" }, lines: [{ invoiceLineId: original.balance.lines[0]!.invoiceLineId, quantity: 0, unit: "each", amountMinor: 1 }] } });
    const recorded = await commands.execute(context, record.id); await commands.acknowledge(context, record.id);
    const pending = await reconciliation.detail(context, source.invoice.id), review = await commands.prepare(context, { kind: "invoice_reconcile", targetId: source.invoice.id,
      input: { action: "adjustment_review", expectedFingerprint: pending.fingerprint, adjustmentId: recorded.result!.id, decision: "approved", reason: "Synthetic actual credit checked", idempotencyKey: key() } });
    await commands.execute(context, review.id); await commands.acknowledge(context, review.id);
    expect((await workspace()).bills.find(row => row.id === due.id)!.sourceStatus).toBe("source_adjusted");
    await expect(allocate(paid.id, due.id, 1)).rejects.toMatchObject({ status: 409 });
    await expect(service.release(context, batch.allocations[0]!.id, { reasonCode: "SOURCE_CHANGED", idempotencyKey: key() })).resolves.toMatchObject({ allocationId: batch.allocations[0]!.id });
    expect((await workspace()).bills.find(row => row.id === due.id)).toMatchObject({ amountMinor: source.invoice.totalMinor, allocatedMinor: 0 });
  });
  async function executeReconciliation(invoiceId: string, input: InvoiceReconciliationInput) {
    const command = await commands.prepare(context, { kind: "invoice_reconcile", targetId: invoiceId, input });
    const result = await commands.execute(context, command.id); await commands.acknowledge(context, command.id); return result;
  }
  function sourceBill(source: Awaited<ReturnType<typeof procurementSource>>) {
    return billInput(source.invoice.totalMinor, { kind: "procurement_invoice", procurementInvoiceId: source.invoice.id,
      externalBillId: source.invoice.invoiceNumber, issuedAt: source.invoice.issuedAt });
  }
  async function receive(orderId: string, stockId: string) {
    const at = (await fixture.clock()).toISOString(), code = `PAY-${createEntityId().toUpperCase()}`;
    const standard = await incoming.publishStandard(context, { code: `${code}-STD`, stockItemId: stockId, expectedVersion: 0,
      title: "Synthetic payable actual accepted material", sourceReference: "Synthetic isolated receiving observation",
      criteria: [{ code: "WIDTH", label: "Synthetic width", kind: "numeric_range", unit: "mm", minimum: "9", maximum: "11" }], idempotencyKey: key() });
    const arrival = await incoming.recordArrival(context, orderId, { code: `${code}-ARR`, expectedPurchaseOrderVersion: 1, arrivedAt: at,
      externalReference: "Synthetic actual material arrival", lines: [{ lineKey: "LINE-1", quantity: 20, unit: "each", holdingLocationId: fixture.locationId,
        lotCode: `${code}-LOT`, expiresAt: null }], idempotencyKey: key() });
    const line = arrival.lines[0]!, inspected = await incoming.recordInspection(context, line.id, { expectedInspectionVersion: 0, standardVersionId: standard.id,
      acceptedQuantity: 20, rejectedQuantity: 0, sampleQuantity: 20, rejectionReason: null, measuredAt: at,
      readings: [{ criterionCode: "WIDTH", value: "10", unit: "mm" }], notes: null, idempotencyKey: key() });
    const reviewed = await incoming.reviewInspection(context, line.id, { expectedInspectionVersion: 1, inspectionId: inspected.inspections[0]!.id,
      decision: "approved", reason: "Synthetic actual receiving observations checked", idempotencyKey: key() });
    const posted = await incoming.postInspection(context, line.id, { expectedInspectionVersion: 1, approvalId: reviewed.inspections[0]!.review!.id,
      acceptedQuantity: 20, rejectedQuantity: 0, rejectionLocationId: null, ownershipConfirmation: "merchant_received", postedAt: at, idempotencyKey: key() });
    const [receipt] = await withTenant(database.db, context, tx => tx.select().from(inventoryProcurementReceiptLines)
      .where(and(eq(inventoryProcurementReceiptLines.receiptId, posted.postings[0]!.receiptId), eq(inventoryProcurementReceiptLines.lineKey, "LINE-1"))));
    if (!receipt) throw new Error("Synthetic payable accepted receipt missing"); return receipt;
  }
  async function procurementSource(matched = true) {
    const basis = await fixture.basis(context), order = await fixture.owner.createPurchaseOrder(context, basis.purchaseInput);
    await fixture.owner.reviewPurchaseOrder(context, order.id, { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC", idempotencyKey: key() });
    if (matched) await receive(order.id, basis.stock.id);
    const invoice = await fixture.owner.recordInvoice(context, order.id, { expectedVersion: 1, invoiceNumber: key(), currency: "USD", issuedAt: "2026-07-01T00:00:00.000Z",
      lines: [{ lineKey: "LINE-1", invoicedQuantity: 20, unitCostMinor: 123 }], idempotencyKey: key() });
    const [proof] = await withTenant(database.db, context, tx => tx.select().from(inventorySupplierInvoiceRequests).where(eq(inventorySupplierInvoiceRequests.invoiceId, invoice.id)));
    expect(proof).toBeDefined(); return { invoice, proof: proof!, order, basis };
  }
});
