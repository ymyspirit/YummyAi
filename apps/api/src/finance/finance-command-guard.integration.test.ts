import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import type { FinanceCommandResult } from "@yummyai/contracts/finance/finance-command";
import { connectDatabase, financeCommands, financeFacts, financeStatements, migrateDatabase, withTenant, type TenantTransaction } from "@yummyai/database";
import { financeCommandFixture, financeCommandKinds, financeCommandTables, requireFinanceCommandFixture,
  type FinanceCommandScenario } from "./finance-command.fixtures.js";

requireFinanceCommandFixture();
const pg = (error: unknown) => { const row = error as { code?: string; message?: string; cause?: { code?: string; message?: string } }; return row.cause?.code ? row.cause : row; };
const guard = (message: string) => (error: unknown) => pg(error).code === "23514" && pg(error).message === message;
describe.sequential("SQL proves finance originals and actual owner receipts in both transaction directions", () => {
  const database = connectDatabase(), f = financeCommandFixture(database);
  beforeAll(async () => { await migrateDatabase(database); await f.initialize(); }, 90_000);
  afterEach(async () => { await f.restoreRights(); await f.cleanupCommands(); }, 60_000);
  afterAll(async () => { try { await f.restoreRights(); await f.cleanupCommands(); } finally { f.destroy(); await database.client.end(); } }, 60_000);
  async function commandAudit(tx: TenantTransaction, s: FinanceCommandScenario, id: string, action: "prepare" | "execute", resultId: string | null,
    actor: TenantContext = s.context) {
    await f.audit.recordInTransaction(tx, actor, { action: `finance.command.${action}`, resourceType: "finance_command", resourceId: id,
      result: "success", metadata: { kind: s.original.kind, targetId: s.original.targetId, resultId } });
  }
  async function rawPreparation(tx: TenantTransaction, s: FinanceCommandScenario, authority: unknown = s.context, checksum?: string) {
    const id = createEntityId(), binding = await f.adapter.bindingInTransaction(tx, s.context, s.original);
    const encryptedInput = f.vault.encrypt(canonicalJson({ tenantId: s.context.tenantId, createdBy: s.context.userId, commandId: id, original: s.original }));
    await tx.insert(financeCommands).values({ id, tenantId: s.context.tenantId, createdBy: s.context.userId, kind: s.original.kind,
      targetId: s.original.targetId, ...binding, ownerInputChecksum: checksum ?? binding.ownerInputChecksum,
      authoritySnapshot: authority as TenantContext, encryptedInput, expiresAt: sql`clock_timestamp()+interval '7 days'` });
    await commandAudit(tx, s, id, "prepare", null); return id;
  }
  async function actual(tx: TenantTransaction, s: FinanceCommandScenario, id: string) {
    await tx.execute(sql`select set_config('app.finance_command_id',${id},true)`);
    return f.adapter.executeInTransaction(tx, s.context, s.original);
  }
  async function outcome(tx: TenantTransaction, id: string, result: FinanceCommandResult) {
    await tx.update(financeCommands).set({ status: "succeeded", resultId: result.id, completedAt: sql`clock_timestamp()` }).where(eq(financeCommands.id, id));
  }

  it("uses a non-owner, non-superuser application role with forced RLS and a SELECT-only proof table", async () => {
    const rows = await withTenant(database.db, f.cost.context, tx => tx.execute<{ name: string; superuser: boolean; bypass: boolean; forced: boolean; owns: boolean;
      can_insert: boolean; can_update: boolean; can_delete: boolean }>(sql`
      select c.relname as name,r.rolsuper as superuser,r.rolbypassrls as bypass,c.relforcerowsecurity as forced,c.relowner=r.oid as owns,
      has_table_privilege(current_user,c.oid,'INSERT') as can_insert,has_table_privilege(current_user,c.oid,'UPDATE') as can_update,
      has_table_privilege(current_user,c.oid,'DELETE') as can_delete
      from pg_roles r join pg_class c on c.relname in('finance_commands','finance_original_write_proofs')
      join pg_namespace n on n.oid=c.relnamespace and n.nspname='public' where r.rolname=current_user order by c.relname`));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ superuser: false, bypass: false, forced: true, owns: false, can_delete: false });
    expect(rows.find(row => row.name === "finance_original_write_proofs")).toMatchObject({ can_insert: false, can_update: false });
  });

  it("validates a complete real owner, proof, command and both audit domains before deliberately rolling the control transaction back", async () => {
    const s = await f.scenario("payment_record"), before = await f.state(s.context), rollback = new Error("Synthetic finance guard control rollback"); let validated = false;
    await expect(withTenant(database.db, s.context, async tx => {
      const id = await rawPreparation(tx, s), result = await actual(tx, s, id);
      await outcome(tx, id, result); await commandAudit(tx, s, id, "execute", result.id);
      await tx.execute(sql`set constraints all immediate`); validated = true; throw rollback;
    })).rejects.toBe(rollback);
    expect(validated).toBe(true); expect(await f.state(s.context)).toEqual(before);
  });

  it.each(financeCommandKinds)("rejects a real %s receipt and owner audit when its matching command outcome is omitted", async kind => {
    const s = await f.scenario(kind), pending = await f.commands.prepare(s.context, s.original), before = await f.state(s.context); let actualReturned = false;
    await expect(withTenant(database.db, s.context, async tx => {
      const result = await actual(tx, s, pending.id); expect(result.kind).toBe(kind); actualReturned = true;
      // The owner and its audit really ran. Commit must not retain a half result.
    })).rejects.toSatisfy(guard("finance_original_outcome_missing"));
    expect(actualReturned).toBe(true); expect(await f.state(s.context)).toEqual(before);
    expect((await f.commands.original(s.context, pending.id)).original).toEqual(s.original);
  }, 60_000);

  it.each(financeCommandKinds)("cannot label a new %s original succeeded using an earlier raw result or its complete creation transaction", async kind => {
    const old = await f.scenario(kind), recorded = await f.raw(old.original, old.context), oldProof = await f.proof(old.context, recorded);
    const s = await f.scenario(kind), pending = await f.commands.prepare(s.context, s.original), before = await f.state(s.context);
    expect(oldProof.command_id).toBeNull();
    await expect(withTenant(database.db, s.context, async tx => {
      await tx.execute(sql`select set_config('app.finance_command_id',${pending.id},true)`);
      await outcome(tx, pending.id, recorded); await commandAudit(tx, s, pending.id, "execute", recorded.id);
    })).rejects.toSatisfy(guard("finance_original_actual_result_missing"));
    expect(await f.state(s.context)).toEqual(before); expect((await f.proof(s.context, recorded)).creation_transaction_id).toBe(oldProof.creation_transaction_id);
  }, 60_000);

  it.each([null, {}, { tenantId: null, userId: null, permissions: [] }])("rejects missing or JSON-null original authority identities %# at the SQL boundary", async authority => {
    const s = await f.scenario("payment_record"), before = await f.state(s.context);
    await expect(withTenant(database.db, s.context, tx => rawPreparation(tx, s, authority))).rejects.toSatisfy(guard("finance_original_identity_invalid"));
    expect(await f.state(s.context)).toEqual(before);
  });

  it("rejects a valid raw command insertion around a previously recorded owner key before it can create a prepare audit", async () => {
    const s = await f.scenario("payment_record"); await f.raw(s.original, s.context); const before = await f.state(s.context);
    await expect(withTenant(database.db, s.context, tx => rawPreparation(tx, s))).rejects.toSatisfy(guard("finance_original_existing_raw"));
    expect(await f.state(s.context)).toEqual(before);
  });

  it("independently compares the actual owner body with the prepared checksum even when the private transport and its prepare audit exist", async () => {
    const s = await f.scenario("payment_record"), before = await f.state(s.context); let admitted = false;
    await expect(withTenant(database.db, s.context, async tx => {
      const id = await rawPreparation(tx, s, s.context, "b".repeat(64)); admitted = true;
      await actual(tx, s, id);
    })).rejects.toSatisfy(guard("finance_original_owner_binding_invalid"));
    expect(admitted).toBe(true); expect(await f.state(s.context)).toEqual(before);
  });

  it.each(["missing", "wrong_actor"] as const)("requires this transaction's exact successful command audit after real owner completion (%s)", async problem => {
    const s = await f.scenario("payment_record"), pending = await f.commands.prepare(s.context, s.original), before = await f.state(s.context); let actualReturned = false;
    await expect(withTenant(database.db, s.context, async tx => {
      const result = await actual(tx, s, pending.id); actualReturned = true; await outcome(tx, pending.id, result);
      if (problem === "wrong_actor") await commandAudit(tx, s, pending.id, "execute", result.id, s.coworker);
    })).rejects.toSatisfy(guard("finance_original_atomic_audit_missing"));
    expect(actualReturned).toBe(true); expect(await f.state(s.context)).toEqual(before);
  });

  it("does not disable the reverse outcome constraint after an early immediate/deferred flush", async () => {
    const s = await f.scenario("payment_record"), pending = await f.commands.prepare(s.context, s.original), before = await f.state(s.context); let actualReturned = false;
    await expect(withTenant(database.db, s.context, async tx => {
      await tx.execute(sql`set constraints all immediate`); await tx.execute(sql`set constraints all deferred`);
      await actual(tx, s, pending.id); actualReturned = true;
    })).rejects.toSatisfy(guard("finance_original_outcome_missing"));
    expect(actualReturned).toBe(true); expect(await f.state(s.context)).toEqual(before);
  });

  it("cannot directly INSERT, UPDATE or DELETE automatic proofs and cannot manufacture one by invoking its trigger function", async () => {
    const s = await f.scenario("payment_record"), actual = await f.raw(s.original, s.context), before = await f.state(s.context);
    const operations = [
      (tx: TenantTransaction) => tx.execute(sql`insert into finance_original_write_proofs select tenant_id,kind,${createEntityId()}::uuid,command_id,
        request_key||'-forged',actor_id,target_id,owner_input_checksum,creation_transaction_id,parent_id,version
        from finance_original_write_proofs where result_id=${actual.id}::uuid`),
      (tx: TenantTransaction) => tx.execute(sql`update finance_original_write_proofs set owner_input_checksum=${"c".repeat(64)} where result_id=${actual.id}::uuid`),
      (tx: TenantTransaction) => tx.execute(sql`delete from finance_original_write_proofs where result_id=${actual.id}::uuid`),
      (tx: TenantTransaction) => tx.execute(sql`select mint_finance_original_proof()`),
    ];
    for (const operation of operations) await expect(withTenant(database.db, s.context, operation)).rejects.toSatisfy((error: unknown) => pg(error).code === "42501");
    expect(await f.state(s.context)).toEqual(before);
  });

  it("preserves tenant isolation for command metadata, private input and automatic immutable proof references", async () => {
    const s = await f.scenario("payment_record"), pending = await f.commands.prepare(s.context, s.original), result = (await f.commands.execute(s.context, pending.id)).result!;
    const foreign = await withTenant(database.db, s.outsider, async tx => ({
      commands: await tx.execute(sql`select id from finance_commands where id=${pending.id}::uuid`),
      proofs: await tx.execute(sql`select result_id from finance_original_write_proofs where result_id=${result.id}::uuid`),
    }));
    expect([...foreign.commands]).toEqual([]); expect([...foreign.proofs]).toEqual([]);
    for (const table of financeCommandTables) expect((await f.state(s.outsider, [table]))[table]!.count).toBe(0);
  });

  it("source-index: denies application INSERT UPDATE and DELETE of actual automatically indexed source lines", async () => {
    const s = await f.scenario("statement_record"), actual = await f.raw(s.original, s.context), before = await f.state(s.context);
    const indexed = await withTenant(database.db, s.context, tx => tx.execute(sql`select line_key from finance_statement_source_lines where statement_id=${actual.id}::uuid`));
    expect(indexed).toHaveLength(1);
    const operations = [
      (tx: TenantTransaction) => tx.execute(sql`insert into finance_statement_source_lines(tenant_id,statement_id,line_key,input,creation_transaction_id)
        select tenant_id,statement_id,'forged-'||line_key,input,creation_transaction_id from finance_statement_source_lines where statement_id=${actual.id}::uuid`),
      (tx: TenantTransaction) => tx.execute(sql`update finance_statement_source_lines set input=jsonb_set(input,'{amountMinor}','0'::jsonb) where statement_id=${actual.id}::uuid`),
      (tx: TenantTransaction) => tx.execute(sql`delete from finance_statement_source_lines where statement_id=${actual.id}::uuid`),
    ];
    for (const operation of operations) await expect(withTenant(database.db, s.context, operation)).rejects.toSatisfy((error: unknown) => pg(error).code === "42501");
    expect(await f.state(s.context)).toEqual(before);
  });

  it("source-index: cannot append a fact to a real committed statement by reusing its retained input index", async () => {
    const s = await f.scenario("statement_record"), actual = await f.raw(s.original, s.context);
    const [line] = await withTenant(database.db, s.context, tx => tx.select().from(financeFacts).where(eq(financeFacts.statementId, actual.id)));
    if (!line) throw new Error("Actual source-index control fact missing"); const before = await f.state(s.context);
    let failure: unknown;
    try {
      await withTenant(database.db, s.context, async tx => {
        await tx.insert(financeFacts).values({ ...line, id: createEntityId(), sourceEntryId: `append-${createEntityId()}`, recordedAt: undefined });
        await f.audit.recordInTransaction(tx, s.context, { action: "finance.statement.record", resourceType: "finance_statement", resourceId: actual.id,
          result: "success", metadata: { lineCount: 1 } });
      });
    } catch (error) { failure = error; }
    expect(failure).toBeDefined();
    const actualFailure = pg(failure);
    // The existing 0152 parent seal runs before source lookup, so a retained index cannot reopen a committed import.
    expect({ code: actualFailure.code, message: actualFailure.message }).toMatchObject({ code: "23514", message: "finance_statement_is_sealed" });
    expect(await f.state(s.context)).toEqual(before);
  });

  it("source-index: still rejects actual money that differs from the exact newly indexed original and rolls the index back too", async () => {
    const s = await f.scenario("statement_record"), actual = await f.raw(s.original, s.context);
    const source = await withTenant(database.db, s.context, async tx => {
      const [header] = await tx.select().from(financeStatements).where(eq(financeStatements.id, actual.id));
      const [fact] = await tx.select().from(financeFacts).where(eq(financeFacts.statementId, actual.id));
      if (!header || !fact) throw new Error("Actual source-index control evidence missing"); return { header, fact };
    });
    const id = createEntityId(), entryId = `source-index-${createEntityId()}`, input = structuredClone(source.header.sourceInput!);
    if (!Array.isArray(input.lines) || input.lines.length !== 1) throw new Error("Actual complete source body missing");
    input.externalStatementId = `SOURCE-INDEX-${id}`;
    input.lines = [{ ...(input.lines[0] as Record<string, unknown>), sourceEntryId: entryId }];
    const checksum = createHash("sha256").update(canonicalJson(input)).digest("hex"), before = await f.state(s.context); let indexed = false;
    await expect(withTenant(database.db, s.context, async tx => {
      await tx.insert(financeStatements).values({ ...source.header, id, externalStatementId: String(input.externalStatementId),
        idempotencyKey: `source-index-${id}`, sourceInput: input, checksum, recordedAt: undefined });
      const rows = await tx.execute(sql`select line_key from finance_statement_source_lines where statement_id=${id}::uuid`); indexed = rows.length === 1;
      await tx.insert(financeFacts).values({ ...source.fact, id: createEntityId(), statementId: id, sourceEntryId: entryId,
        amountMinor: source.fact.amountMinor + 1, recordedAt: undefined });
      await f.audit.recordInTransaction(tx, s.context, { action: "finance.statement.record", resourceType: "finance_statement", resourceId: id,
        result: "success", metadata: { lineCount: 1 } });
    })).rejects.toSatisfy(guard("finance_source_line_mismatch"));
    expect(indexed).toBe(true); expect(await f.state(s.context)).toEqual(before);
  });
});
