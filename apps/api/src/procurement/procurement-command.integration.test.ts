import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { PrepareProcurementCommandSchema, ProcurementCommandViewSchema, type PrepareProcurementCommand } from "@yummyai/contracts/procurement/procurement-command";
import { connectDatabase, migrateDatabase, withTenant, memberships, membershipRoles, roles, inventoryProcurementWriteRequests,
  inventoryProcurementRequisitions, inventoryProcurementRequisitionVersions, expireProcurementCommandInputs, type TenantTransaction } from "@yummyai/database";
import { ProcurementCommandService } from "./procurement-command.service.js";
import { procurementCommandBinding } from "./procurement-original-request.js";
import { procurementCommandFixture, procurementFixtureKey, procurementFixturePermissions, requireProcurementCommandFixture } from "./procurement-command.fixtures.js";

requireProcurementCommandFixture();

describe.sequential("recoverable actual procurement commands", () => {
  const database = connectDatabase(), fixture = procurementCommandFixture(database), { context, coworker, outsider, owner, audit } = fixture;
  const key = randomBytes(32), vault = new SecretVault(key), commands = new ProcurementCommandService(database, vault, owner, audit);
  const owned = new Map<string, TenantContext>();
  const restarted = () => new ProcurementCommandService(database, new SecretVault(key), owner, audit);

  beforeAll(async () => { await migrateDatabase(database); await fixture.initialize(); });
  afterEach(async () => {
    await fixture.setPermissions(context, procurementFixturePermissions);
    await fixture.setPermissions(coworker, procurementFixturePermissions);
    for (const [id, current] of owned) {
      const row = await commands.get(current, id);
      if (row.status === "prepared") await commands.cancel(current, id);
      await commands.acknowledge(current, id);
      expect((await commands.get(current, id)).acknowledged).toBe(true);
    }
    owned.clear();
  }, 60_000);
  afterAll(async () => { key.fill(0); await database.client.end(); });

  async function prepare(raw: PrepareProcurementCommand, current = context) {
    const prepared = await commands.prepare(current, raw);
    owned.set(prepared.id, current);
    return ProcurementCommandViewSchema.parse(prepared);
  }
  async function actual(raw: PrepareProcurementCommand, current = context) {
    const original = PrepareProcurementCommandSchema.parse(raw), saved = await prepare(original, current);
    expect(saved).toMatchObject({ status: "prepared", original, canExecute: true, result: null });
    expect((await restarted().get(current, saved.id)).original).toEqual(original);
    const results = await Promise.all([commands.execute(current, saved.id), restarted().execute(current, saved.id)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ status: "succeeded", canExecute: false, canCancel: false, result: { kind: original.kind } });
    return results[0]!;
  }
  async function facts() {
    const tables = ["inventory_procurement_requisitions", "inventory_procurement_requisition_versions", "inventory_procurement_rfqs", "inventory_supplier_quote_versions",
      "inventory_purchase_orders", "inventory_purchase_order_versions", "inventory_purchase_order_events", "inventory_procurement_write_requests", "inventory_procurement_commands", "audit_events"];
    return withTenant(database.db, context, async tx => {
      const state: Record<string, { count: number; checksum: string }> = {};
      for (const table of tables) {
        const rows = await tx.execute<{ id: string }>(sql`select * from ${sql.identifier(table)} order by id`);
        state[table] = { count: rows.length, checksum: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
      }
      return state;
    });
  }

  async function expectSqlGuard(attempt: Promise<unknown>, constraint?: string) {
    try { await attempt; }
    catch (error) {
      let item: unknown = error;
      const seen = new Set<unknown>();
      while (item && typeof item === "object" && !seen.has(item)) {
        seen.add(item);
        const details = item as { code?: unknown; constraint_name?: unknown; cause?: unknown };
        if (details.code === "23514") {
          if (constraint) expect(details.constraint_name).toBe(constraint);
          return;
        }
        item = details.cause;
      }
      throw error;
    }
    expect.fail("The actual SQL guard accepted an invalid procurement transaction");
  }

  async function rawPreparation(tx: TenantTransaction, original: PrepareProcurementCommand, commandId: string, authority: unknown = context) {
    const binding = procurementCommandBinding(original);
    await tx.execute(sql`insert into inventory_procurement_commands
      (id,tenant_id,created_by,kind,operation,target_id,request_key,request_checksum,authority_snapshot,encrypted_input,expires_at)
      values(${commandId}::uuid,${context.tenantId}::uuid,${context.userId}::uuid,${original.kind},${binding.operation},${original.targetId}::uuid,
        ${binding.idempotencyKey},${binding.requestChecksum},${JSON.stringify(authority)}::jsonb,${vault.encrypt(JSON.stringify(original))},clock_timestamp()+interval '7 days')`);
  }

  /** Application-role SQL fixture intentionally omits the service advisory lock.
   * Real same-transaction facts are required by 0146; 0147 must serialize this
   * path too rather than relying on its caller taking a JavaScript lock. */
  async function rawRequisitionFact(tx: TenantTransaction, original: Extract<PrepareProcurementCommand, { kind: "requisition_create" }>) {
    const binding = procurementCommandBinding(original), id = createEntityId(), versionId = createEntityId(), proofId = createEntityId();
    if (binding.operation === "invoice_record" || binding.operation === "invoice_reconcile") throw new Error("A requisition requires the original 0146 proof domain");
    await tx.insert(inventoryProcurementRequisitions).values({ id, tenantId: context.tenantId, createdBy: context.userId,
      code: original.input.code, idempotencyKey: original.input.idempotencyKey });
    await tx.insert(inventoryProcurementRequisitionVersions).values({ id: versionId, tenantId: context.tenantId, requisitionId: id,
      versionNumber: 1, reasonCode: original.input.reasonCode, lineSnapshot: original.input.lines,
      checksum: createHash("sha256").update(JSON.stringify(original.input.lines)).digest("hex"), createdBy: context.userId });
    await tx.insert(inventoryProcurementWriteRequests).values({ id: proofId, tenantId: context.tenantId, createdBy: context.userId,
      operation: binding.operation, targetId: null, idempotencyKey: binding.idempotencyKey, requestChecksum: binding.requestChecksum, requisitionId: id });
    return { id, versionId, proofId };
  }

  function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
    return { promise, resolve, reject };
  }
  async function observedSqlBlock(blockedPid: number, blockerPid: number) {
    const deadline = performance.now() + 5_000;
    while (performance.now() < deadline) {
      const [row] = await database.client.unsafe("select $1::int=any(pg_blocking_pids($2::int)) as blocked", [blockerPid, blockedPid]);
      if (row!.blocked) return;
      await delay(20);
    }
    expect.fail("The second actual SQL transaction never waited for the first operation/key");
  }

  async function permissionScopes(scopes: Record<string, "self" | "team" | "tenant">) {
    const added: string[] = [];
    await withTenant(database.db, context, async tx => {
      const [member] = await tx.select().from(memberships).where(eq(memberships.userId, context.userId));
      expect(member).toBeDefined();
      // The real membership loader derives per-permission scopes from separate
      // role grants. There is no permissionScopes column on an individual role.
      await tx.update(roles).set({ permissions: procurementFixturePermissions.filter(permission => !(permission in scopes)), dataScope: "tenant" })
        .where(eq(roles.id, fixture.roleIds.get(context.userId)!));
      for (const [permission, dataScope] of Object.entries(scopes)) {
        const id = createEntityId(); added.push(id);
        await tx.insert(roles).values({ id, tenantId: context.tenantId, name: `Synthetic permission-specific ${id}`, permissions: [permission], dataScope });
        await tx.insert(membershipRoles).values({ tenantId: context.tenantId, membershipId: member!.id, roleId: id });
      }
    });
    return () => withTenant(database.db, context, async tx => {
      for (const id of added) {
        await tx.delete(membershipRoles).where(eq(membershipRoles.roleId, id));
        await tx.delete(roles).where(eq(roles.id, id));
      }
      await tx.update(roles).set({ permissions: [...procurementFixturePermissions], dataScope: "tenant" })
        .where(eq(roles.id, fixture.roleIds.get(context.userId)!));
    });
  }

  it("recovers all seven original transports and binds each actual owner once", async () => {
    const b = await fixture.basis();
    const req = await actual({ kind: "requisition_create", targetId: null, input: b.requisitionInput });
    const requisitionId = req.result!.id;
    const rfq = await actual({ kind: "rfq_create", targetId: requisitionId, input: { expectedRequisitionVersion: 1, supplierIds: [fixture.supplierId], responseDueAt: b.future, idempotencyKey: procurementFixtureKey() } });
    const quote = await actual({ kind: "quote_record", targetId: rfq.result!.id, input: { supplierId: fixture.supplierId, currency: "USD", validUntil: b.future,
      lines: [{ lineKey: b.line.lineKey, unitCostMinor: 123, minimumOrderQuantity: 10, leadTimeDays: 2 }], idempotencyKey: procurementFixtureKey() } });
    const purchase = await actual({ kind: "purchase_create", targetId: null, input: { ...b.purchaseInput, requisitionId, quoteId: quote.result!.id } });
    const revised = await actual({ kind: "purchase_revise", targetId: purchase.result!.id, input: { expectedVersion: 1, currency: "USD", expectedAt: b.future,
      lines: b.purchaseInput.lines, idempotencyKey: procurementFixtureKey() } });
    expect(revised.result).toMatchObject({ id: purchase.result!.id, version: 2 });
    const reviewed = await actual({ kind: "purchase_review", targetId: purchase.result!.id, input: { expectedVersion: 2, decision: "approved", reasonCode: "SYNTHETIC", idempotencyKey: procurementFixtureKey() } });
    expect(reviewed.result).toMatchObject({ id: purchase.result!.id, version: 2 });
    // Free only the completed null-target slot before preparing another PO.
    await commands.acknowledge(context, purchase.id);
    const supplied = await fixture.supplied();
    const supplyPurchase = await actual({ kind: "supply_purchase_create", targetId: supplied.link.id, input: supplied.input });
    const workspace = await owner.workspace(context);
    expect(workspace.purchaseOrders.find(row => row.id === purchase.result!.id)).toMatchObject({ status: "approved", currentVersion: 2, quoteId: quote.result!.id, requisitionId });
    const [supplyVersion] = await fixture.supply.history(context, supplied.link.id);
    expect(workspace.purchaseOrders.find(row => row.id === supplyPurchase.result!.id)).toMatchObject({ sourceSupplyVersionId: supplyVersion!.id, purpose: "custom_order" });
    const requests = await withTenant(database.db, context, tx => tx.select().from(inventoryProcurementWriteRequests));
    expect(requests).toHaveLength(7);
    expect(requests.filter(row => row.operation === "purchase_create")).toHaveLength(2);
  });

  it("retains the original key after prepare response loss and hides another actor's private input", async () => {
    const b = await fixture.basis(), original: PrepareProcurementCommand = { kind: "purchase_create", targetId: null, input: b.purchaseInput };
    const [first, duplicate] = await Promise.all([prepare(original), prepare(original)]);
    expect(first.id).toBe(duplicate.id);
    const restored = (await restarted().list(context, {})).items.find(row => row.id === first.id)!;
    expect(restored.original).toEqual(original);
    expect((await owner.workspace(context)).purchaseOrders.filter(row => row.code === b.purchaseInput.code)).toEqual([]);
    await expect(commands.prepare(context, { ...original, input: { ...b.purchaseInput, currency: "CNY" } })).rejects.toMatchObject({ status: 409 });
    await expect(commands.prepare(coworker, original)).rejects.toMatchObject({ status: 409 });
    await expect(commands.get(coworker, first.id)).rejects.toMatchObject({ status: 404 });
    await expect(commands.get(outsider, first.id)).rejects.toMatchObject({ status: 404 });
    expect((await commands.list(coworker, {})).items).toEqual([]);
    await expect(commands.prepare(context, { ...original, input: { ...b.purchaseInput, code: "OTHER-PENDING", idempotencyKey: procurementFixtureKey() } })).rejects.toMatchObject({ status: 409 });
  });

  it("does not duplicate actual work after an unknown execute response or a new service instance", async () => {
    const b = await fixture.basis(), saved = await prepare({ kind: "requisition_create", targetId: null, input: b.requisitionInput });
    // The caller intentionally discards this result, as after a dropped response.
    await commands.execute(context, saved.id);
    const before = await facts();
    const recovered = await restarted().get(context, saved.id), replay = await restarted().execute(context, saved.id);
    expect(recovered.status).toBe("succeeded"); expect(replay.result).toEqual(recovered.result);
    expect(await facts()).toEqual(before);
  });

  it("does not manufacture a durable preparation or success around a previously completed raw owner call", async () => {
    const b = await fixture.basis();
    const prior = await owner.createRequisition(context, b.requisitionInput), before = await facts();
    await expect(commands.prepare(context, { kind: "requisition_create", targetId: null, input: b.requisitionInput })).rejects.toMatchObject({ status: 409 });
    expect(await facts()).toEqual(before);
    expect((await owner.workspace(context)).requisitions.find(row => row.id === prior.id)).toBeTruthy();
  });

  it("rolls actual facts, immutable request proof, command outcome and audit back together", async () => {
    const b = await fixture.basis(), saved = await prepare({ kind: "purchase_create", targetId: null, input: b.purchaseInput });
    const before = await facts(), record = audit.recordInTransaction.bind(audit);
    const failure = vi.spyOn(audit, "recordInTransaction").mockImplementation(async (tx, current, event) => {
      if (event.action === "procurement.command.execute") throw new Error("Synthetic procurement command outcome audit failure");
      return record(tx, current, event);
    });
    try { await expect(commands.execute(context, saved.id)).rejects.toThrow("Synthetic procurement command outcome audit failure"); }
    finally { failure.mockRestore(); }
    expect(await facts()).toEqual(before);
    expect(await commands.get(context, saved.id)).toMatchObject({ status: "prepared", original: saved.original, result: null, canExecute: true });
    expect((await commands.execute(context, saved.id)).status).toBe("succeeded");
  });

  it("requires the prepared command and its actual immutable proof in one transaction", async () => {
    const b = await fixture.basis(), saved = await prepare({ kind: "purchase_create", targetId: null, input: b.purchaseInput });
    const before = await facts();
    // The ordinary owner remains useful for legacy calls, but a prepared key is
    // already bound to its durable outcome and cannot bypass that outcome.
    await expect(owner.createPurchaseOrder(context, b.purchaseInput)).rejects.toThrow();
    expect(await facts()).toEqual(before);
    await expect(withTenant(database.db, context, tx => tx.execute(sql`update inventory_procurement_commands
      set status='succeeded',result_proof_id=${createEntityId()}::uuid,completed_at=clock_timestamp() where id=${saved.id}::uuid`))).rejects.toThrow();
    await expect(withTenant(database.db, context, tx => tx.execute(sql`update inventory_procurement_commands
      set encrypted_input=${vault.encrypt(JSON.stringify({ ...saved.original, changed: true }))} where id=${saved.id}::uuid`))).rejects.toThrow();
    expect(await facts()).toEqual(before);
    const succeeded = await commands.execute(context, saved.id);
    const rows = await withTenant(database.db, context, tx => tx.execute<{ result_proof_id: string; operation: string; target_id: string | null;
      created_by: string; idempotency_key: string; purchase_order_id: string }>(sql`select c.result_proof_id,p.operation,p.target_id,p.created_by,p.idempotency_key,p.purchase_order_id
      from inventory_procurement_commands c join inventory_procurement_write_requests p on p.tenant_id=c.tenant_id and p.id=c.result_proof_id
      where c.id=${saved.id}::uuid`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation: "purchase_create", target_id: null, created_by: context.userId,
      idempotency_key: b.purchaseInput.idempotencyKey, purchase_order_id: succeeded.result!.id });
  });

  it("rejects absent or null authority identities in SQL without relying on application validation", async () => {
    const b = await fixture.basis(), before = await facts();
    for (const authority of [{}, { tenantId: context.tenantId }, { userId: context.userId },
      { tenantId: null, userId: context.userId }, { ...context, tenantId: outsider.tenantId }]) {
      const id = createEntityId(), original: PrepareProcurementCommand = { kind: "requisition_create", targetId: null,
        input: { ...b.requisitionInput, idempotencyKey: procurementFixtureKey() } };
      const attempt = withTenant(database.db, context, tx => rawPreparation(tx, original, id, authority)).then(() => { owned.set(id, context); });
      await expectSqlGuard(attempt, "procurement_commands_authority");
    }
    expect(await facts()).toEqual(before);
  });

  it("rolls back an admitted actual owner call when its command outcome is omitted", async () => {
    const b = await fixture.basis(), original: PrepareProcurementCommand = { kind: "requisition_create", targetId: null, input: b.requisitionInput };
    const saved = await prepare(original), before = await facts();
    await expectSqlGuard(withTenant(database.db, context, async tx => {
      await tx.execute(sql`select set_config('app.procurement_command_id',${saved.id},true)`);
      await owner.executeCommandInTransaction(tx, context, original);
      // Deliberately do not update the retained command. The deferred reverse
      // constraint must reject commit and all of the actual owner's facts.
    }));
    expect(await facts()).toEqual(before);
    expect(await commands.get(context, saved.id)).toMatchObject({ status: "prepared", original, result: null, canExecute: true });
  });

  it.each(["fact", "command"] as const)("serializes raw same-key inserts when %s is admitted first", async first => {
    const b = await fixture.basis(), original: Extract<PrepareProcurementCommand, { kind: "requisition_create" }> = { kind: "requisition_create", targetId: null, input: b.requisitionInput };
    const commandId = createEntityId(), firstInserted = deferred<number>(), secondStarted = deferred<number>(), releaseFirst = deferred<void>(), releaseSecond = deferred<void>();
    const settle = <T,>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    const firstAttempt = settle(withTenant(database.db, context, async tx => {
      const [pid] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      if (first === "fact") await rawRequisitionFact(tx, original);
      else await rawPreparation(tx, original, commandId);
      firstInserted.resolve(pid!.pid);
      await releaseFirst.promise;
    }).catch(error => { firstInserted.reject(error); throw error; }).then(() => { if (first === "command") owned.set(commandId, context); }));
    let secondAttempt: ReturnType<typeof settle<void>> | undefined;
    try {
      const blocker = await firstInserted.promise;
      secondAttempt = settle(withTenant(database.db, context, async tx => {
        const [pid] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`); secondStarted.resolve(pid!.pid);
        if (first === "fact") await rawPreparation(tx, original, commandId);
        else await rawRequisitionFact(tx, original);
        await releaseSecond.promise;
      }).catch(error => { secondStarted.reject(error); throw error; }).then(() => { if (first === "fact") owned.set(commandId, context); }));
      await observedSqlBlock(await secondStarted.promise, blocker);
      releaseFirst.resolve();
      const firstResult = await firstAttempt;
      expect(firstResult.ok).toBe(true);
      releaseSecond.resolve();
      const secondResult = await secondAttempt;
      expect(secondResult.ok).toBe(false);
      if (!secondResult.ok) await expectSqlGuard(Promise.reject(secondResult.error));
      const requests = await withTenant(database.db, context, tx => tx.select().from(inventoryProcurementWriteRequests)
        .where(eq(inventoryProcurementWriteRequests.idempotencyKey, original.input.idempotencyKey)));
      expect(requests).toHaveLength(first === "fact" ? 1 : 0);
      if (first === "command") expect(await commands.get(context, commandId)).toMatchObject({ status: "prepared", result: null, original });
    } finally {
      releaseFirst.resolve(); releaseSecond.resolve();
      await firstAttempt;
      if (secondAttempt) await secondAttempt;
    }
  });

  it("expires only due private inputs under zero business permissions and preserves actual successful facts", async () => {
    const b = await fixture.basis(), done = await actual({ kind: "requisition_create", targetId: null, input: b.requisitionInput });
    const pending = await prepare({ kind: "purchase_create", targetId: null, input: b.purchaseInput });
    const live = await prepare({ kind: "rfq_create", targetId: done.result!.id, input: { expectedRequisitionVersion: 1,
      supplierIds: [fixture.supplierId], responseDueAt: b.future, idempotencyKey: procurementFixtureKey() } });
    const [lifetime] = await withTenant(database.db, context, tx => tx.execute<{ exact: boolean }>(sql`select expires_at=created_at+interval '7 days' as exact
      from inventory_procurement_commands where id=${pending.id}::uuid`));
    expect(lifetime!.exact).toBe(true);
    requireProcurementCommandFixture();
    await database.client.begin(async synthetic => {
      await synthetic.unsafe("set local session_replication_role=replica");
      await synthetic.unsafe("update inventory_procurement_commands set created_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 day' where tenant_id=$1 and id in ($2,$3)",
        [context.tenantId, done.id, pending.id]);
    });
    const maintenance: TenantContext = { tenantId: context.tenantId, userId: "00000000-0000-7000-8000-000000000006", permissions: [], dataScope: "tenant" };
    const before = await facts();
    expect(await withTenant(database.db, { ...maintenance, tenantId: outsider.tenantId }, tx => expireProcurementCommandInputs(tx))).toBe(0);
    expect(await withTenant(database.db, maintenance, tx => expireProcurementCommandInputs(tx, { limit: 1 }))).toBe(1);
    expect(await withTenant(database.db, maintenance, tx => expireProcurementCommandInputs(tx, { limit: 1 }))).toBe(1);
    expect(await withTenant(database.db, maintenance, tx => expireProcurementCommandInputs(tx))).toBe(0);
    expect(await commands.get(context, done.id)).toMatchObject({ status: "succeeded", original: null, result: done.result });
    expect(await commands.execute(context, pending.id)).toMatchObject({ status: "expired", original: null, result: null, canExecute: false });
    expect(await commands.get(context, live.id)).toMatchObject({ status: "prepared", original: live.original, canExecute: true });
    const after = await facts();
    for (const table of Object.keys(before).filter(name => name !== "inventory_procurement_commands")) expect(after[table]).toEqual(before[table]);
  });

  it("binds manual and supply purchase transports to the same actual operation key domain", async () => {
    const b = await fixture.supplied(), manual: PrepareProcurementCommand = { kind: "purchase_create", targetId: null, input: b.purchaseInput };
    const saved = await prepare(manual), before = await facts();
    await expect(commands.prepare(context, { kind: "supply_purchase_create", targetId: b.link.id,
      input: { ...b.input, idempotencyKey: b.purchaseInput.idempotencyKey } })).rejects.toMatchObject({ status: 409 });
    expect(await facts()).toEqual(before);
    expect((await commands.get(context, saved.id)).original).toEqual(manual);
  });

  it("uses the owner's canonical UUID and time proof without replacing the first encrypted original", async () => {
    const b = await fixture.quoted(), original: PrepareProcurementCommand = { kind: "quote_record", targetId: b.rfq.id,
      input: { ...b.quoteInput, idempotencyKey: procurementFixtureKey() } };
    const saved = await prepare(original);
    const replay = await commands.prepare(context, { ...original, targetId: b.rfq.id.toUpperCase(),
      input: { ...original.input, supplierId: fixture.supplierId.toUpperCase(), validUntil: b.quoteInput.validUntil.replace("Z", "0Z") } });
    expect(replay.id).toBe(saved.id); expect(replay.original).toEqual(saved.original);
    const supplied = await fixture.supplied(), supplyOriginal: PrepareProcurementCommand = { kind: "supply_purchase_create", targetId: supplied.link.id, input: supplied.input };
    const supplySaved = await prepare(supplyOriginal);
    const supplyReplay = await commands.prepare(context, { ...supplyOriginal, targetId: supplied.link.id.toUpperCase(), input: { ...supplied.input,
      destinationLocationId: supplied.input.destinationLocationId.toUpperCase(), expectedAt: supplied.input.expectedAt.replace("Z", "0Z") } });
    expect(supplyReplay.id).toBe(supplySaved.id); expect(supplyReplay.original).toEqual(supplySaved.original);
  });

  it("preserves ciphertext on a temporary wrong key and recovers only with the original key", async () => {
    const b = await fixture.basis(), saved = await prepare({ kind: "requisition_create", targetId: null, input: b.requisitionInput });
    const wrong = new ProcurementCommandService(database, new SecretVault(randomBytes(32)), owner, audit), before = await facts();
    expect(await wrong.get(context, saved.id)).toMatchObject({ status: "prepared", original: null, canExecute: false, blockReason: "input_unavailable" });
    await expect(wrong.execute(context, saved.id)).rejects.toMatchObject({ status: 409 });
    expect(await facts()).toEqual(before);
    expect(await restarted().get(context, saved.id)).toMatchObject({ original: saved.original, canExecute: true });
    expect((await restarted().execute(context, saved.id)).status).toBe("succeeded");
  });

  it("rechecks current write rights and retains actual success when only write permission is later lost", async () => {
    const b = await fixture.basis(), saved = await prepare({ kind: "purchase_create", targetId: null, input: b.purchaseInput });
    try {
      await fixture.setPermissions(context, procurementFixturePermissions.filter(permission => permission !== Permission.ProcurementWrite));
      expect(await commands.get(context, saved.id)).toMatchObject({ status: "prepared", canExecute: false, blockReason: "permission_denied" });
      await expect(commands.execute(context, saved.id)).rejects.toMatchObject({ permission: Permission.ProcurementWrite });
      expect((await owner.workspace(context)).purchaseOrders.filter(row => row.code === b.purchaseInput.code)).toEqual([]);
      await fixture.setPermissions(context, procurementFixturePermissions);
      const succeeded = await commands.execute(context, saved.id);
      await fixture.setPermissions(context, procurementFixturePermissions.filter(permission => permission !== Permission.ProcurementWrite));
      expect(await restarted().get(context, saved.id)).toMatchObject({ status: "succeeded", result: succeeded.result, canExecute: false });
      expect((await commands.execute(context, saved.id)).result).toEqual(succeeded.result);
      await fixture.setPermissions(context, procurementFixturePermissions.filter(permission => permission !== Permission.ProcurementRead));
      await expect(commands.get(context, saved.id)).rejects.toMatchObject({ permission: Permission.ProcurementRead });
    } finally { await fixture.setPermissions(context, procurementFixturePermissions); }
  });

  it("keeps a pending original when a newer RFQ quote replaces its business basis", async () => {
    const b = await fixture.quoted(), original: PrepareProcurementCommand = { kind: "purchase_create", targetId: null, input: b.quotedPurchaseInput };
    const saved = await prepare(original);
    await owner.recordSupplierQuote(context, b.rfq.id, { ...b.quoteInput, lines: b.quoteInput.lines.map(row => ({ ...row, unitCostMinor: 456 })), idempotencyKey: procurementFixtureKey() });
    expect(await commands.get(context, saved.id)).toMatchObject({ status: "prepared", original, canExecute: false, canCancel: true, blockReason: "basis_changed" });
    const before = await facts();
    await expect(commands.execute(context, saved.id)).rejects.toMatchObject({ status: 409 });
    expect(await facts()).toEqual(before);
    await expect(commands.acknowledge(context, saved.id)).rejects.toMatchObject({ status: 409 });
    expect(await commands.cancel(context, saved.id)).toMatchObject({ status: "cancelled", original: null, result: null });
  });

  it("keeps a pending supply purchase pinned when the supplier terms are revised", async () => {
    const b = await fixture.supplied(), original: PrepareProcurementCommand = { kind: "supply_purchase_create", targetId: b.link.id, input: b.input };
    const saved = await prepare(original);
    await fixture.supply.revise(context, b.link.id, { expectedVersion: 1, terms: { ...b.terms, unitCostMinor: 456 }, idempotencyKey: procurementFixtureKey() });
    expect(await commands.get(context, saved.id)).toMatchObject({ status: "prepared", original, canExecute: false, blockReason: "basis_changed" });
    const before = await facts();
    await expect(commands.execute(context, saved.id)).rejects.toMatchObject({ status: 409 });
    expect(await facts()).toEqual(before);
  });

  it.each(["rfq", "supply"] as const)("reads a prepared %s original without waiting for an unrelated source-write lock", async source => {
    let original: PrepareProcurementCommand, sourceLock: string;
    if (source === "rfq") {
      const b = await fixture.quoted();
      original = { kind: "purchase_create", targetId: null, input: b.quotedPurchaseInput };
      sourceLock = `procurement-quote-version:${context.tenantId}:${b.rfq.id}:${fixture.supplierId}`;
    } else {
      const b = await fixture.supplied();
      original = { kind: "supply_purchase_create", targetId: b.link.id, input: b.input };
      const link = (await fixture.supply.workspace(context)).links.find(row => row.id === b.link.id)!;
      sourceLock = `product-supply:${context.tenantId}:${link.productPlanId}`;
    }
    const saved = await prepare(original), locked = deferred<void>(), release = deferred<void>();
    const blocker = withTenant(database.db, context, async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${sourceLock},0))`);
      locked.resolve(); await release.promise;
    });
    let read: Promise<Awaited<ReturnType<typeof commands.get>>> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await locked.promise;
      read = commands.get(context, saved.id);
      const result = await Promise.race([read, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Read-only command validation waited for a source-write lock")), 2_000);
      })]);
      expect(result).toMatchObject({ status: "prepared", original: saved.original, result: null, canExecute: true });
    } finally {
      if (timeout) clearTimeout(timeout);
      release.resolve(); await blocker;
      if (read) await Promise.allSettled([read]);
    }
  });

  it("finishes concurrent command and raw purchases from one quote with two explicit immutable outcomes", async () => {
    const b = await fixture.quoted(), saved = await prepare({ kind: "purchase_create", targetId: null, input: b.quotedPurchaseInput });
    const raw = { ...b.quotedPurchaseInput, code: `${b.purchaseInput.code}-RAW`, idempotencyKey: procurementFixtureKey() };
    const [retained, direct] = await Promise.all([commands.execute(context, saved.id), owner.createPurchaseOrder(coworker, raw)]);
    expect(retained).toMatchObject({ status: "succeeded", result: { kind: "purchase_create" } });
    expect(direct).toMatchObject({ status: "draft", quoteId: b.quote.id });
    expect(retained.result!.id).not.toBe(direct.id);
    const before = await facts();
    expect((await commands.execute(context, saved.id)).result).toEqual(retained.result);
    expect((await owner.createPurchaseOrder(coworker, raw)).id).toBe(direct.id);
    expect(await facts()).toEqual(before);
  });

  it("does not let a broader tenant read widen an independently self-scoped RFQ write", async () => {
    const b = await fixture.quoted(coworker);
    const original: PrepareProcurementCommand = { kind: "quote_record", targetId: b.rfq.id, input: { ...b.quoteInput, idempotencyKey: procurementFixtureKey() } };
    const saved = await prepare(original);
    const restore = await permissionScopes({ [Permission.ProcurementRead]: "tenant", [Permission.ProcurementWrite]: "self", [Permission.InventoryRead]: "tenant" });
    try {
      expect(await commands.get(context, saved.id)).toMatchObject({ canExecute: false, blockReason: "permission_denied" });
      const before = await facts();
      await expect(commands.execute(context, saved.id)).rejects.toMatchObject({ permission: Permission.ProcurementWrite });
      expect(await facts()).toEqual(before);
    } finally { await restore(); }
  });

  it("finds older originals beyond workspace limits without letting unreadable targets starve recovery", async () => {
    const b = await fixture.basis();
    let accessibleId = "", oldestRfqId = "";
    for (let index = 0; index < 106; index++) {
      const sourceOwner = index === 0 ? context : coworker;
      const request = await owner.createRequisition(sourceOwner, { ...b.requisitionInput, code: `PAGE-REQ-${index}`, idempotencyKey: procurementFixtureKey() });
      const rfq = await owner.createRfq(sourceOwner, request.id, { expectedRequisitionVersion: 1, supplierIds: [fixture.supplierId],
        responseDueAt: b.future, idempotencyKey: procurementFixtureKey() });
      const saved = await prepare({ kind: "quote_record", targetId: rfq.id, input: { supplierId: fixture.supplierId, currency: "USD", validUntil: b.future,
        lines: [{ lineKey: b.line.lineKey, unitCostMinor: 123, minimumOrderQuantity: 10, leadTimeDays: 2 }], idempotencyKey: procurementFixtureKey() } });
      if (index === 0) { accessibleId = saved.id; oldestRfqId = rfq.id; }
    }
    expect((await owner.workspace(context)).rfqs.map(row => row.id)).not.toContain(oldestRfqId);
    const restore = await permissionScopes({ [Permission.ProcurementRead]: "self", [Permission.ProcurementWrite]: "tenant", [Permission.InventoryRead]: "tenant" });
    try {
      const found: string[] = [], seen = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 8; page++) {
        const result = await restarted().list(context, cursor ? { before: cursor } : {});
        expect(result.items.length).toBeLessThanOrEqual(50);
        expect(result.items.every(row => row.id === accessibleId)).toBe(true);
        found.push(...result.items.map(row => row.id));
        if (!result.nextCursor) { cursor = undefined; break; }
        expect(seen.has(result.nextCursor)).toBe(false);
        seen.add(result.nextCursor); cursor = result.nextCursor;
      }
      expect(cursor).toBeUndefined();
      expect(found).toEqual([accessibleId]);
      expect((await restarted().get(context, accessibleId)).original).not.toBeNull();
    } finally { await restore(); }
  });
});
