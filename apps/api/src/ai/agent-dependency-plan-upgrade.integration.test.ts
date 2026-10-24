import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { createEnvironmentSecretVault } from "@yummyai/ai-core";
import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { AGENT_COMMAND_VERSION, AgentCommandReceiptSchema, AgentCommandViewSchema, PrepareAgentCommandSchema, ConfirmAgentCommandSchema } from "@yummyai/contracts/ai/agent-command";
import { AGENT_DEPENDENCY_PLAN_KIND, AGENT_DEPENDENCY_PLAN_VERSION, AgentDependencyPlanViewSchema, CreateAgentDependencyPlanSchema } from "@yummyai/contracts/ai/agent-dependency-plan";
import { agentDependencyPlans, assertDatabaseMigrationsCurrent, connectDatabase, migrateDatabase, readMigrationEvidence, withTenant } from "@yummyai/database";
import { assertAgentDependencyPlanOriginal183Graph, requireAgentDependencyPlanLegacyEnvironment } from "../../../../tools/testing/agent-dependency-plan-legacy.mjs";
import { agentCommandOwners } from "./agent-command.test-fixture.js";
import { AgentDependencyPlanSource } from "./agent-dependency-plan-source.js";
import { AgentDependencyPlanService } from "./agent-dependency-plan.service.js";

const isolated = requireAgentDependencyPlanLegacyEnvironment(process.env, "pre-0184"), database = connectDatabase(isolated.url);
const root = fileURLToPath(new URL("../../../../", import.meta.url)), sha = (value: string) => createHash("sha256").update(value).digest("hex");
const Results = z.object({ context: TenantContextSchema, pendingInput: PrepareAgentCommandSchema, succeededInput: PrepareAgentCommandSchema,
  pending: AgentCommandViewSchema, succeeded: AgentCommandViewSchema, pendingReceipt: AgentCommandReceiptSchema, succeededReceipt: AgentCommandReceiptSchema,
  modelCalls: z.literal(0), workerProcesses: z.literal(0), resourcesClosed: z.literal(true) });
const Seed = Results.extend({ type: z.literal("agent.dependency.seeded183") }).strict(), Read = Results.extend({ type: z.literal("agent.dependency.read183") }).strict();
const Failure = z.object({ type: z.literal("agent.dependency.failed183"), phase: z.enum(["environment", "ipc", "graph", "imports", "schema", "identity", "basis", "pending", "succeeded", "reader_wait", "reader_get", "cleanup", "send", "unhandled"]),
  code: z.string().regex(/^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/).nullable(),
  errorName: z.enum(["Error", "TypeError", "RangeError", "SyntaxError", "AggregateError", "ZodError", "PostgresError", "DatabaseError", "ConflictException", "ForbiddenError", "ForbiddenException", "NotFoundException", "BadRequestException"]) }).strict();
const withoutFreshConfirmation = (value: z.infer<typeof AgentCommandViewSchema>) => {
  const { confirmationToken, confirmationExpiresAt, ...stable } = value; void confirmationToken; void confirmationExpiresAt; return stable;
};
type Child = { process: ChildProcess; mode: "183" | "read183"; exit: Promise<number>; wait(type: string): Promise<unknown>; forced: boolean };
const children: Child[] = [];
async function bounded<T>(operation: Promise<T>, label: string, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}
function oldChild(mode: Child["mode"], contentKey: string) {
  const processChild = spawn(process.execPath, ["--import", pathToFileURL(resolve(isolated.root, "apps/api/node_modules/tsx/dist/loader.mjs")).href, resolve(root, "tools/testing/agent-dependency-plan-legacy.mts")], {
    cwd: resolve(isolated.root, "apps/api"), windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(isolated.root, "apps/api/tsconfig.json"),
      E2E_LEGACY_SCHEMA_TARGET: "current", E2E_AGENT_DEPENDENCY_PLAN_LEGACY_CHILD: mode, E2E_AGENT_DEPENDENCY_PLAN_CONTENT_KEY: contentKey },
  });
  const received = new Map<string, unknown>(), waiting = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  let failure: Error | undefined, stopped = false, startupCode: string | null = null, startupType: string | null = null;
  processChild.stderr?.on("data", (bytes: Buffer) => { const text = bytes.toString("utf8"); startupCode ??= /\b(ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)\b/.exec(text)?.[1] ?? null;
    startupType ??= /\b(SyntaxError|ReferenceError|TypeError|RangeError|TransformError)\b/.exec(text)?.[1] ?? null; });
  processChild.on("message", raw => {
    const bad = Failure.safeParse(raw);
    if (bad.success) { failure = new Error(JSON.stringify(bad.data)); for (const waiter of waiting.values()) waiter.reject(failure); waiting.clear(); return; }
    if (!raw || typeof raw !== "object" || !("type" in raw) || typeof raw.type !== "string" || !["agent.dependency.seeded183", "agent.dependency.reader183.ready", "agent.dependency.read183"].includes(raw.type)) return;
    received.set(raw.type, raw); waiting.get(raw.type)?.resolve(raw); waiting.delete(raw.type);
  });
  const exit = new Promise<number>(done => {
    processChild.once("error", () => { stopped = true; failure = new Error("dependency_legacy_spawn_failed"); for (const waiter of waiting.values()) waiter.reject(failure); waiting.clear(); done(-1); });
    processChild.once("exit", (code, signal) => { stopped = true; if (waiting.size) { const finite = new Error(JSON.stringify({ code: "dependency_legacy_early_exit", mode, exitCode: code, signal, startupCode, startupType }));
      for (const waiter of waiting.values()) waiter.reject(finite); waiting.clear(); } done(code ?? -1); });
  });
  const child: Child = { process: processChild, mode, exit, forced: false, wait(type) {
    if (failure) return Promise.reject(failure); if (received.has(type)) return Promise.resolve(received.get(type)); if (stopped) return Promise.reject(new Error("dependency_legacy_already_exited"));
    return bounded(new Promise<unknown>((resolve, reject) => waiting.set(type, { resolve, reject })), "dependency_legacy_ipc_deadline", 120_000);
  } }; children.push(child); return child;
}

/** The application role, original tenant and all original visible columns are
 * fixed before migration. PG row_to_json preserves SQL timestamp precision;
 * only a checksum and count leave this RR/read-only projection. */
async function originalProjection(context: TenantContext) {
  const columns = await withTenant(database.db, context, async tx => tx.execute<{ table_name: string; column_name: string }>(sql`select c.table_name,c.column_name from information_schema.columns c
    join pg_class t on t.relname=c.table_name join pg_namespace n on n.oid=t.relnamespace and n.nspname=c.table_schema
    where c.table_schema='public' and t.relkind in ('r','p') and has_table_privilege(current_user,t.oid,'SELECT') order by c.table_name,c.ordinal_position`), { isolationLevel: "repeatable read", accessMode: "read only" });
  const tables = new Map<string, string[]>();
  for (const row of columns) {
    if (!/^[a-z_][a-z0-9_]*$/.test(row.table_name) || !/^[a-z_][a-z0-9_]*$/.test(row.column_name)) throw new Error("dependency_legacy_projection_identifier_invalid");
    tables.set(row.table_name, [...tables.get(row.table_name) ?? [], row.column_name]);
  }
  const snapshot = () => withTenant(database.db, context, async tx => {
    await tx.execute(sql.raw("set local time zone 'UTC'"));
    const values: Array<{ table: string; columns: string[]; rows: number; sha256: string }> = [];
    for (const [name, fields] of tables) {
      const [row] = await tx.execute<{ rows: number; canonical: string }>(sql`select count(*)::int as rows,coalesce(string_agg(row_to_json(t)::text,E'\n' order by row_to_json(t)::text),'') as canonical
        from (select ${sql.join(fields.map(field => sql.identifier(field)), sql.raw(","))} from ${sql.identifier(name)}) t`);
      if (!row) throw new Error("dependency_legacy_projection_missing"); values.push({ table: name, columns: fields, rows: row.rows, sha256: sha(row.canonical) });
    }
    return values;
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
  return { snapshot };
}

describe("genuine183 original invoice commands to184 independent dependency coordination", () => {
  afterAll(async () => {
    const failures: unknown[] = [];
    for (const child of children) {
      if (child.process.exitCode === null && child.process.signalCode === null) { child.forced = true; child.process.kill("SIGKILL"); }
      try { await bounded(child.exit, "dependency_legacy_child_teardown_deadline", 10_000); } catch (error) { failures.push(error); }
    }
    try { await database.client.end(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "dependency_genuine183_teardown_failed");
  });
  it("dependency_genuine183 preserves original columns invoices receipts and pending work without backfill then explicitly coordinates the real old invoice into one new bill", async () => {
    const flagsBefore = { target: process.env.E2E_LEGACY_SCHEMA_TARGET, family: process.env.E2E_AGENT_DEPENDENCY_PLAN_ISOLATED, source: process.env.E2E_AGENT_DEPENDENCY_PLAN_LEGACY_SOURCE };
    await assertAgentDependencyPlanOriginal183Graph(isolated.root);
    const contentKey = randomBytes(32).toString("base64url"), seedChild = oldChild("183", contentKey), seed = Seed.parse(await seedChild.wait("agent.dependency.seeded183"));
    expect(await bounded(seedChild.exit, "dependency_original183_seed_exit_deadline", 15_000)).toBe(0); expect(seedChild.forced).toBe(false);
    expect(seed.pending.state).toBe("prepared"); expect(seed.succeeded.state).toBe("succeeded");
    const originalInvoice = seed.succeeded.snapshot?.native;
    if (!originalInvoice || originalInvoice.domain !== "procurement" || originalInvoice.view.kind !== "invoice_record" || !originalInvoice.view.invoiceResult)
      throw new Error("dependency_legacy_original_invoice_result_missing");
    expect(originalInvoice.view.result?.id).toBe(originalInvoice.view.invoiceResult.id);
    expect(seed.pendingReceipt.id).toBe(seed.pending.id); expect(seed.succeededReceipt.id).toBe(seed.succeeded.id);
    const beforeLedger = (await readMigrationEvidence(database)).actualRows; expect(beforeLedger).toHaveLength(183);
    const projection = await originalProjection(seed.context), before = await projection.snapshot();
    expect(before.find(row => row.table === "agent_command_requests")?.rows).toBe(2); expect(before.find(row => row.table === "inventory_supplier_invoices")?.rows).toBe(1);
    expect(before.some(row => row.table === "agent_dependency_plans")).toBe(false);
    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
    const afterLedger = (await readMigrationEvidence(database)).actualRows; expect(afterLedger).toHaveLength(184); expect(afterLedger.slice(0, 183)).toEqual(beforeLedger);
    expect(await projection.snapshot()).toEqual(before);
    expect(await withTenant(database.db, seed.context, tx => tx.select().from(agentDependencyPlans))).toEqual([]);
    expect({ target: process.env.E2E_LEGACY_SCHEMA_TARGET, family: process.env.E2E_AGENT_DEPENDENCY_PLAN_ISOLATED, source: process.env.E2E_AGENT_DEPENDENCY_PLAN_LEGACY_SOURCE }).toEqual(flagsBefore);

    const priorTarget = process.env.E2E_LEGACY_SCHEMA_TARGET; let owners!: ReturnType<typeof agentCommandOwners>;
    try {
      process.env.E2E_LEGACY_SCHEMA_TARGET = "current";
      owners = agentCommandOwners(database, { contentVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist", { NODE_ENV: "production", MODEL_CREDENTIAL_ENCRYPTION_KEY: contentKey }) });
    } finally { if (priorTarget === undefined) delete process.env.E2E_LEGACY_SCHEMA_TARGET; else process.env.E2E_LEGACY_SCHEMA_TARGET = priorTarget; }
    const commands = owners.service(), source = new AgentDependencyPlanSource(database, commands, owners.procurementOwner), service = new AgentDependencyPlanService(database, commands, source, owners.audit);
    expect(withoutFreshConfirmation(await commands.get(seed.context, seed.pending.id))).toEqual(withoutFreshConfirmation(seed.pending));
    expect(await commands.get(seed.context, seed.succeeded.id)).toEqual(seed.succeeded);
    expect(await commands.receipt(seed.context, { requestId: seed.pendingReceipt.requestId, requestChecksum: seed.pendingReceipt.requestChecksum })).toEqual(seed.pendingReceipt);
    expect(await commands.receipt(seed.context, { requestId: seed.succeededReceipt.requestId, requestChecksum: seed.succeededReceipt.requestChecksum })).toEqual(seed.succeededReceipt);
    expect(await projection.snapshot()).toEqual(before);

    const reader = oldChild("read183", contentKey); await reader.wait("agent.dependency.reader183.ready");
    await new Promise<void>((done, reject) => reader.process.send!({ type: "agent.dependency.read183.request", context: seed.context, pendingInput: seed.pendingInput, succeededInput: seed.succeededInput,
      pendingId: seed.pending.id, succeededId: seed.succeeded.id }, error => error ? reject(error) : done()));
    const oldRead = Read.parse(await reader.wait("agent.dependency.read183")); expect(await bounded(reader.exit, "dependency_original183_reader_exit_deadline", 15_000)).toBe(0); expect(reader.forced).toBe(false);
    expect(withoutFreshConfirmation(oldRead.pending)).toEqual(withoutFreshConfirmation(seed.pending)); expect(oldRead.succeeded).toEqual(seed.succeeded);
    expect(oldRead.pendingReceipt).toEqual(seed.pendingReceipt); expect(oldRead.succeededReceipt).toEqual(seed.succeededReceipt); expect(await projection.snapshot()).toEqual(before);

    const input = (parentAgentCommandId: string) => CreateAgentDependencyPlanSchema.parse({ version: AGENT_DEPENDENCY_PLAN_VERSION, kind: AGENT_DEPENDENCY_PLAN_KIND, requestId: randomUUID(), parentAgentCommandId, dueAt: null });
    const pending = await service.create(seed.context, input(seed.pending.id)); expect(pending.state).toBe("waiting_predecessor"); expect(pending.source).toBeNull(); expect(pending.childAgentCommandId).toBeNull();
    const ready = AgentDependencyPlanViewSchema.parse(await service.create(seed.context, input(seed.succeeded.id)));
    expect(ready.state).toBe("ready_to_prepare"); expect(ready.source?.invoiceId).toBe(originalInvoice.view.invoiceResult.id);
    expect(ready.childDraft?.command.input.kind).toBe("procurement_invoice"); expect(ready.childDraft?.command.input.amountMinor).toBe(ready.source?.totalMinor);
    const originalFactsBefore = await projection.snapshot(), prepared = await service.prepare(seed.context, ready.id, { version: AGENT_DEPENDENCY_PLAN_VERSION, requestId: ready.requestId, sourceChecksum: ready.source!.sourceChecksum });
    expect(prepared.child?.state).toBe("prepared"); expect(prepared.child?.resultId).toBeNull();
    expect((await projection.snapshot()).filter(row => ["inventory_supplier_invoices", "inventory_supplier_invoice_allocations", "finance_payable_bills", "finance_original_write_proofs"].includes(row.table)))
      .toEqual(originalFactsBefore.filter(row => ["inventory_supplier_invoices", "inventory_supplier_invoice_allocations", "finance_payable_bills", "finance_original_write_proofs"].includes(row.table)));
    const child = await commands.get(seed.context, prepared.childAgentCommandId!), confirm = ConfirmAgentCommandSchema.parse({ version: AGENT_COMMAND_VERSION, requestId: child.requestId, ownerCommandId: child.ownerCommandId,
      originalChecksum: child.originalChecksum, confirmationToken: child.confirmationToken, decision: "execute_original" });
    const completed = await commands.confirm(seed.context, child.id, confirm); expect(completed.state).toBe("succeeded");
    const originalBill = completed.snapshot?.native;
    if (!originalBill || originalBill.domain !== "finance" || originalBill.view.kind !== "bill_record" || originalBill.view.result?.kind !== "bill_record")
      throw new Error("dependency_upgrade_original_finance_result_missing");
    const actual = await service.get(seed.context, prepared.id); expect(actual.state).toBe("succeeded"); expect(actual.parent.resultId).toBe(ready.source!.invoiceId);
    expect(actual.child?.resultId).toBe(originalBill.view.result.id);
    const final = await projection.snapshot(); expect(final.find(row => row.table === "finance_payable_bills")?.rows).toBe((before.find(row => row.table === "finance_payable_bills")?.rows ?? 0) + 1);
    for (const name of ["inventory_supplier_invoices", "inventory_supplier_invoice_requests", "inventory_supplier_invoice_allocations", "inventory_movements", "orders", "production_orders", "ai_budget_ledger"])
      expect(final.find(row => row.table === name), name).toEqual(before.find(row => row.table === name));
    expect((await service.get(seed.context, pending.id)).state).toBe("waiting_predecessor");
    await assertAgentDependencyPlanOriginal183Graph(isolated.root);
    expect({ target: process.env.E2E_LEGACY_SCHEMA_TARGET, family: process.env.E2E_AGENT_DEPENDENCY_PLAN_ISOLATED, source: process.env.E2E_AGENT_DEPENDENCY_PLAN_LEGACY_SOURCE }).toEqual(flagsBefore);
    await mkdir(resolve(isolated.lane, "qa"), { recursive: true });
    await writeFile(resolve(isolated.lane, "qa", isolated.nonce + "-upgrade-proof.json"), JSON.stringify({ operation: "3f7c2a91", nonce: isolated.nonce, sourceSchema: 183, targetSchema: 184,
      originalSourceSha256: "114ffb3661087dfcfee859550115d135653178971a18a82c7234214eb6a5a81e", originalSourceFiles: 3751, originalLinks: 389, nativeRuntimeFiles: 23,
      projectionScope: "all_original_columns_visible_to_nonowner_application_role_for_original_seed_tenant", original: before, originalColumnsAndRowsPreservedImmediatelyAfterMigration: true,
      originalLedgerPrefixPreserved: true, newDependencyRowsBeforeExplicitAction: 0, currentOriginalReaderUnchanged: true, genuineOriginal183ReaderAfter184Unchanged: true,
      readerFreshConfirmationExcludedFromEquality: ["confirmationToken", "confirmationExpiresAt"], originalParentInputsUnchanged: true,
      ids: { pendingParentId: seed.pending.id, succeededParentId: seed.succeeded.id, invoiceId: ready.source!.invoiceId, waitingPlanId: pending.id, planId: actual.id, childId: completed.id, billId: actual.child!.resultId },
      parentEnvironmentFlagsUnchanged: true, explicitNewChildPreparation: true, explicitOriginalFinanceConfirmation: true, modelCalls: 0, providerCalls: 0, workerProcesses: 0, queueDispatches: 0,
      children: children.map(child => ({ mode: child.mode, exitCode: child.process.exitCode, signal: child.process.signalCode, forced: child.forced, databaseClosedBeforeReceipt: true })),
      retainedHistory: "real_original183_pending_and_succeeded_commands_and_explicit_new184_results_until_outer_disposable_database_teardown" }, null, 2));
  });
});
