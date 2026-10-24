import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { FinanceCommandDetailSchema, FinanceCommandListSchema, FinanceCommandOriginalSchema, type PrepareFinanceCommand } from "@yummyai/contracts/finance/finance-command";
import { connectDatabase, migrateDatabase, withTenant } from "@yummyai/database";
import { FinanceCommandService } from "./finance-command.service.js";
import { FinanceCommandResultReader } from "./finance-command-result.reader.js";
import { createFinanceCommandVault } from "./finance-command-vault.js";
import { financeCommandBusinessTables, financeCommandFixture, financeCommandKey, financeCommandKinds, financeCommandPermission,
  requireFinanceCommandFixture, type FinanceCommandScenario } from "./finance-command.fixtures.js";

requireFinanceCommandFixture();
const conflict = { status: 409 }, denied = { status: 403 }, missing = { status: 404 };
const changed = (original: PrepareFinanceCommand): PrepareFinanceCommand => {
  switch (original.kind) {
    case "statement_record": return { ...original, input: { ...original.input, externalStatementId: `${original.input.externalStatementId}-CHANGED` } };
    case "fx_rate_record": return { ...original, input: { ...original.input, rateNumerator: original.input.rateNumerator + 1 } };
    case "metric_upsert": return { ...original, input: { ...original.input, name: `${original.input.name} changed` } };
    case "profit_calculate": return { ...original, input: { ...original.input, expectedMetricVersion: original.input.expectedMetricVersion + 1 } };
    case "bill_record": case "payment_record": return { ...original, input: { ...original.input, amountMinor: original.input.amountMinor + 1 } } as PrepareFinanceCommand;
    case "payment_allocate": return { ...original, input: { ...original.input, allocations: original.input.allocations.map((row, index) => ({ ...row, amountMinor: row.amountMinor + (index === 0 ? 1 : 0) })) } };
    case "allocation_release": return { ...original, input: { ...original.input, reasonCode: "OTHER_REASON" } };
    case "bill_adjustment_record": case "payment_adjustment_record": return { ...original, input: { ...original.input, expectedNetAmountMinor: original.input.expectedNetAmountMinor + 1 } } as PrepareFinanceCommand;
    case "cost_version_approve": return { ...original, input: { ...original.input, basisDescription: `${original.input.basisDescription} changed` } };
    case "allocated_profit_calculate": return { ...original, input: { ...original.input, versionIds: [] } };
  }
};

describe.sequential("durable finance originals delegate all twelve actual owners atomically", () => {
  const database = connectDatabase(), f = financeCommandFixture(database), { commands } = f;
  beforeAll(async () => { await migrateDatabase(database); await f.initialize(); }, 90_000);
  afterEach(async () => { vi.restoreAllMocks(); await f.restoreRights(); await f.cleanupCommands(); }, 60_000);
  afterAll(async () => { try { await f.restoreRights(); await f.cleanupCommands(); } finally { f.destroy(); await database.client.end(); } }, 60_000);
  async function prepared(s: FinanceCommandScenario) { return FinanceCommandDetailSchema.parse(await commands.prepare(s.context, s.original)); }
  async function original(s: FinanceCommandScenario, id: string) { return FinanceCommandOriginalSchema.parse(await commands.original(s.context, id)); }

  it.each(financeCommandKinds)("recovers %s across instances with operation-only authority, one real receipt and later Read-only access", async kind => {
    const s = await f.scenario(kind), permission = financeCommandPermission(kind), session: TenantContext = { ...s.context, permissions: [permission] };
    const before = await f.state(s.context, financeCommandBusinessTables);
    await f.rights(s.context, [permission]);
    const first = FinanceCommandDetailSchema.parse(await commands.prepare(session, s.original));
    expect(first).toMatchObject({ kind, targetId: s.original.targetId, status: "prepared", result: null, originalRetained: true, canExecute: true });
    expect(first).not.toHaveProperty("original"); expect(await f.state(s.context, financeCommandBusinessTables)).toEqual(before);
    const resumed = f.service(), fresh = structuredClone(session);
    const retained = FinanceCommandOriginalSchema.parse(await resumed.original(fresh, first.id));
    expect(retained.original).toEqual(s.original); expect(retained.contextAuthority).toBe(first.contextAuthority);
    const list = FinanceCommandListSchema.parse(await resumed.list(fresh, { kind, targetId: s.original.targetId ?? "root" }));
    expect(list.items.some(item => item.id === first.id)).toBe(true);
    for (const item of list.items) { expect(item).not.toHaveProperty("original"); expect(item).not.toHaveProperty("encryptedInput"); }
    const [a, b] = await Promise.all([resumed.execute(fresh, first.id), f.service().execute(structuredClone(fresh), first.id)]);
    const done = FinanceCommandDetailSchema.parse(a); expect(done.status).toBe("succeeded"); expect(done.result).not.toBeNull(); expect(b.result).toEqual(done.result);
    const row = await f.row(s.context, first.id), proof = await f.proof(s.context, done.result!);
    expect(proof).toMatchObject({ command_id: first.id, request_key: s.original.input.idempotencyKey, actor_id: s.context.userId,
      target_id: s.original.targetId, owner_input_checksum: row.owner_input_checksum, parent_id: done.result!.parentId, version: done.result!.version });
    expect(proof.creation_transaction_id).toMatch(/^[0-9]+$/);
    expect(row.authority_snapshot.permissions).toEqual([permission]); expect(row.request_checksum).toMatch(/^[a-f0-9]{64}$/);
    const after = await f.state(s.context);
    await f.rights(s.context, [Permission.FinanceRead]); const reader: TenantContext = { ...s.context, permissions: [Permission.FinanceRead] };
    const read = FinanceCommandDetailSchema.parse(await f.service().get(reader, first.id));
    expect(read).toMatchObject({ status: "succeeded", canExecute: false, result: done.result }); expect(read).not.toHaveProperty("original");
    expect((await f.service().execute(reader, first.id)).result).toEqual(done.result);
    expect(await f.state(s.context)).toEqual(after);
    await f.rights(s.context, f.financialRights); await commands.acknowledge(s.context, first.id);
    expect((await f.row(s.context, first.id)).encrypted_input).toBeNull();
    const acknowledged = await f.state(s.context);
    await expect(f.raw(s.original, s.context)).rejects.toMatchObject(conflict);
    expect((await f.service().get(s.context, first.id)).result).toEqual(done.result);
    expect(await f.state(s.context)).toEqual(acknowledged);
  }, 60_000);

  it.each(financeCommandKinds)("never retroactively claims an already recorded raw %s", async kind => {
    const s = await f.scenario(kind), actual = await f.raw(s.original, s.context), before = await f.state(s.context);
    expect((await f.proof(s.context, actual)).command_id).toBeNull();
    await expect(commands.prepare(s.context, s.original)).rejects.toMatchObject(conflict);
    expect(await f.state(s.context)).toEqual(before); expect(await f.raw(s.original, s.context)).toEqual(actual);
    expect((await f.proof(s.context, actual)).command_id).toBeNull();
  }, 60_000);

  it.each(financeCommandKinds)("rolls actual %s, automatic proof, owner audit and outcome back when the final command audit fails", async kind => {
    const s = await f.scenario(kind), pending = await prepared(s), before = await f.state(s.context), failure = new Error("Synthetic finance command final audit unavailable");
    const real = f.audit.recordInTransaction.bind(f.audit); let reachedOutcome = false;
    const spy = vi.spyOn(f.audit, "recordInTransaction").mockImplementation(async (tx, context, event) => {
      if (event.action === "finance.command.execute") { reachedOutcome = true; throw failure; }
      return real(tx, context, event);
    });
    await expect(commands.execute(s.context, pending.id)).rejects.toBe(failure); expect(reachedOutcome).toBe(true);
    expect(await f.state(s.context)).toEqual(before);
    expect(await original(s, pending.id)).toMatchObject({ original: s.original, blockReason: null });
    spy.mockRestore(); expect((await commands.execute(s.context, pending.id)).status).toBe("succeeded");
  }, 60_000);

  it.each(["statement_record", "metric_upsert", "payment_allocate", "bill_adjustment_record", "cost_version_approve"] as const)("keeps %s original actor, target and full input bound after a lost prepare response", async kind => {
    const s = await f.scenario(kind), first = await prepared(s), before = await f.state(s.context);
    expect((await f.service().prepare(structuredClone(s.context), s.original)).id).toBe(first.id);
    await expect(f.service().prepare(s.context, changed(s.original))).rejects.toMatchObject(conflict);
    await expect(f.service().prepare(s.coworker, s.original)).rejects.toMatchObject(conflict);
    await expect(f.service().get(s.coworker, first.id)).rejects.toMatchObject(missing);
    await expect(f.service().original(s.outsider, first.id)).rejects.toMatchObject(missing);
    expect((await original(s, first.id)).original).toEqual(s.original); expect(await f.state(s.context)).toEqual(before);
  });

  it.each(["statement_record", "fx_rate_record"] as const)("refuses same-business-identity %s under another key, including when raw wins after preparation", async kind => {
    const s = await f.scenario(kind), pending = await prepared(s);
    const other = { ...s.original, input: { ...s.original.input, idempotencyKey: financeCommandKey() } } as PrepareFinanceCommand;
    const actual = await f.raw(other, s.context), before = await f.state(s.context);
    await expect(commands.execute(s.context, pending.id)).rejects.toMatchObject(conflict);
    expect(await f.state(s.context)).toEqual(before);
    expect((await f.row(s.context, pending.id)).result_id).toBeNull(); expect((await original(s, pending.id)).original).toEqual(s.original);
    await commands.cancel(s.context, pending.id); await commands.acknowledge(s.context, pending.id);
    const newAttempt = { ...s.original, input: { ...s.original.input, idempotencyKey: financeCommandKey() } } as PrepareFinanceCommand;
    const afterCancel = await f.state(s.context);
    await expect(commands.prepare(s.context, newAttempt)).rejects.toMatchObject(conflict);
    await expect(commands.prepare(s.coworker, newAttempt)).rejects.toMatchObject(conflict);
    expect(await f.state(s.context)).toEqual(afterCancel); expect((await f.proof(s.context, actual)).command_id).toBeNull();
  });

  it.each(["statement_record", "profit_calculate", "bill_adjustment_record", "cost_version_approve"] as const)("rechecks current %s authority without borrowing tenant Read or trusting stale permission claims", async kind => {
    const s = await f.scenario(kind), pending = await prepared(s), permission = financeCommandPermission(kind), before = await f.state(s.context);
    await f.rights(s.context, [Permission.FinanceRead]);
    await expect(commands.execute(s.context, pending.id)).rejects.toMatchObject(denied);
    await expect(commands.execute({ ...s.context, permissions: [...s.context.permissions, permission] }, pending.id)).rejects.toMatchObject(denied);
    await f.rights(s.context, [Permission.FinanceRead, permission], "self");
    await expect(commands.execute(s.context, pending.id)).rejects.toMatchObject(denied);
    await f.rights(s.context, [Permission.FinanceRead, permission], "team");
    await expect(commands.execute(s.context, pending.id)).rejects.toMatchObject(denied);
    await f.restoreRights(); await f.membership(s.context, "disabled");
    await expect(commands.get(s.context, pending.id)).rejects.toMatchObject(denied);
    await f.restoreRights(); expect(await f.state(s.context)).toEqual(before);
  });

  it("rejects a self-scoped preparation before a later grant can be mistaken for retained authority", async () => {
    const s = await f.scenario("payment_record");
    // Preparation must reject an operation without tenant write authority;
    // gaining it later cannot turn the rejected request into a saved command.
    await f.rights(s.context, [Permission.FinanceWrite], "self");
    const before = await f.state(s.context);
    await expect(commands.prepare({ ...s.context, permissions: [Permission.FinanceWrite], dataScope: "self" }, s.original)).rejects.toMatchObject(denied);
    expect(await f.state(s.context)).toEqual(before);
  });

  it("retains ciphertext across a temporary key error and exposes private input only through the single original endpoint", async () => {
    const s = await f.scenario("statement_record"), pending = await prepared(s), row = await f.row(s.context, pending.id), temporary = randomBytes(32);
    try {
      const wrong = new FinanceCommandService(database, createFinanceCommandVault({ NODE_ENV: "production", FINANCE_COMMAND_ENCRYPTION_KEY: temporary.toString("base64url") }), f.adapter, f.audit, new FinanceCommandResultReader());
      expect(await wrong.original(s.context, pending.id)).toMatchObject({ id: pending.id, original: null, blockReason: "input_unavailable" });
      await expect(wrong.execute(s.context, pending.id)).rejects.toMatchObject(conflict);
      expect((await f.row(s.context, pending.id)).encrypted_input).toBe(row.encrypted_input);
      expect((await original(s, pending.id)).original).toEqual(s.original);
      expect((await f.service().execute(s.context, pending.id)).status).toBe("succeeded");
    } finally { temporary.fill(0); }
  });

  it("does not change the original net or replace a pending refund when another actual refund consumes its original basis", async () => {
    const s = await f.scenario("payment_adjustment_record"), pending = await prepared(s);
    if (s.original.kind !== "payment_adjustment_record" || s.original.input.kind !== "refund") throw new Error("Synthetic refund expected");
    await f.payable.adjustments.recordPaymentAdjustment(s.context, s.original.targetId,
      { ...s.original.input, amountMinor: 10, externalDocumentId: `OTHER-${financeCommandKey()}`, idempotencyKey: financeCommandKey() });
    const before = await f.state(s.context);
    expect(await commands.get(s.context, pending.id)).toMatchObject({ status: "prepared", canExecute: false, blockReason: "basis_changed" });
    await expect(commands.execute(s.context, pending.id)).rejects.toMatchObject(conflict);
    expect((await original(s, pending.id)).original).toEqual(s.original); expect(await f.state(s.context)).toEqual(before);
  });

  it("keeps source corrections and original allocation versions pinned instead of preparing or calculating today's replacement", async () => {
    const s = await f.scenario("cost_version_approve"), pending = await prepared(s);
    if (!s.costBasis) throw new Error("Synthetic source basis missing");
    await f.cost.correction(s.costBasis, "reversal"); const before = await f.state(s.context);
    expect(await commands.get(s.context, pending.id)).toMatchObject({ status: "prepared", canExecute: false, blockReason: "basis_changed" });
    await expect(commands.execute(s.context, pending.id)).rejects.toMatchObject(conflict);
    expect((await original(s, pending.id)).original).toEqual(s.original); expect(await f.state(s.context)).toEqual(before);
  });

  it("keeps a metric update pinned to its original version when another actual reviewed update advances the parent", async () => {
    const s = await f.scenario("metric_upsert"); if (s.original.kind !== "metric_upsert") throw new Error("Synthetic metric expected");
    const created = await f.raw(s.original, s.context), input = { ...s.original.input, metricId: created.parentId!, expectedVersion: 1, idempotencyKey: financeCommandKey() };
    const update: PrepareFinanceCommand = { kind: "metric_upsert", targetId: created.parentId!, input };
    const pending = await commands.prepare(s.context, update);
    await f.cost.finance.upsertProfitMetric(s.context, { ...input, name: `${input.name} actual next version`, idempotencyKey: financeCommandKey() });
    const before = await f.state(s.context);
    expect(await commands.get(s.context, pending.id)).toMatchObject({ status: "prepared", canExecute: false, blockReason: "basis_changed" });
    await expect(commands.execute(s.context, pending.id)).rejects.toMatchObject({ status: 409, response: { code: "finance_profit_metric_version_changed" } });
    expect((await commands.original(s.context, pending.id)).original).toEqual(update); expect(await f.state(s.context)).toEqual(before);
  });

  it("blocks a prepared allocation and a new preparation when another actual batch consumes its original payment capacity", async () => {
    const s = await f.scenario("payment_allocate"); if (s.original.kind !== "payment_allocate") throw new Error("Synthetic allocation expected");
    const pending = await prepared(s), other = await f.payable.bill(100);
    await f.payable.payables.allocate(s.context, { paymentId: s.original.targetId, allocations: [{ billId: other.id, amountMinor: 60 }], idempotencyKey: financeCommandKey() });
    const before = await f.state(s.context);
    expect(await commands.get(s.context, pending.id)).toMatchObject({ status: "prepared", canExecute: false, blockReason: "basis_changed" });
    await expect(commands.execute(s.context, pending.id)).rejects.toMatchObject({ status: 409, response: { code: "finance_payables_payment_exceeded" } });
    await expect(commands.prepare(s.coworker, { ...s.original, input: { ...s.original.input, idempotencyKey: financeCommandKey() } }))
      .rejects.toMatchObject({ status: 409, response: { code: "finance_payables_payment_exceeded" } });
    expect((await original(s, pending.id)).original).toEqual(s.original); expect(await f.state(s.context)).toEqual(before);
  });

  it("cancels only the technical original and cannot raw-bypass its permanent binding after acknowledgement", async () => {
    const s = await f.scenario("payment_record"), pending = await prepared(s), before = await f.state(s.context, financeCommandBusinessTables);
    await commands.cancel(s.context, pending.id); await commands.acknowledge(s.context, pending.id);
    expect(await commands.get(s.context, pending.id)).toMatchObject({ status: "cancelled", acknowledged: true, originalRetained: false, result: null });
    expect((await original(s, pending.id)).original).toBeNull(); await expect(f.raw(s.original, s.context)).rejects.toMatchObject(conflict);
    expect(await f.state(s.context, financeCommandBusinessTables)).toEqual(before);
  });

  it("recovers a real 20000-line Unicode report larger than one MiB without list duplication or clipped line counts", async () => {
    const s = await f.scenario("statement_record"); if (s.original.kind !== "statement_record") throw new Error("Synthetic statement expected");
    const statement = s.original;
    s.original = { ...statement, input: { ...statement.input, lines: Array.from({ length: 20_000 }, (_, index) => ({ ...statement.input.lines[0]!,
      lineKey: `line-${index}`, sourceEntryId: `synthetic-large-event-${financeCommandKey()}-${index}`, externalReference: `合成原始证据 ${index} 同一实际行不能裁剪` })) } };
    const pending = await prepared(s), row = await f.row(s.context, pending.id);
    expect(Buffer.byteLength(JSON.stringify(s.original), "utf8")).toBeGreaterThan(1024 * 1024);
    expect(row.encrypted_input).not.toContain("合成原始证据");
    const list = await commands.list(s.context, { kind: "statement_record", targetId: "root" });
    expect(JSON.stringify(list).length).toBeLessThan(64 * 1024);
    const retained = await original(s, pending.id);
    expect(retained.original).toEqual(s.original);
    const done = await f.service().execute(structuredClone(s.context), pending.id);
    const [count] = await withTenant(database.db, s.context, tx => tx.execute<{ lines: number }>(sql`
      select count(*)::int as lines from finance_facts where statement_id=${done.result!.id}::uuid`));
    expect(count!.lines).toBe(20_000);
    const before = await f.state(s.context); expect((await commands.execute(s.context, pending.id)).result).toEqual(done.result); expect(await f.state(s.context)).toEqual(before);
  }, 120_000);
});
