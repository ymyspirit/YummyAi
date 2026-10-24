import "reflect-metadata";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { HttpException } from "@nestjs/common";
import { z } from "zod";
import { sql, eq } from "drizzle-orm";
import { SecretVault } from "@yummyai/ai-core";
import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { FULFILLMENT_COMMAND_VERSION, FulfillmentCommandListSchema, FulfillmentCommandViewSchema, PrepareFulfillmentCommandSchema } from "@yummyai/contracts/order/fulfillment-command";
import { AGENT_FULFILLMENT_COMMAND_VERSION } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { assertDatabaseMigrationsCurrent, connectDatabase, migrateDatabase, readMigrationEvidence, orderFulfillmentCommandIntents, withTenant } from "@yummyai/database";
import { assertAgentFulfillmentCommandOriginal185Graph, requireAgentFulfillmentCommandLegacyEnvironment } from "../../../../tools/testing/agent-fulfillment-command-legacy.mjs";
import { fulfillmentOwnerPorts } from "./agent-fulfillment.test-fixture.js";
import { OrderFulfillmentCommandOwner } from "../orders/order-fulfillment-command-owner.js";
import { OrderFulfillmentCommandService } from "../orders/order-fulfillment-command.service.js";
import { AgentFulfillmentCommandOwner } from "./agent-fulfillment-command-owner.js";
import { AgentFulfillmentCommandService } from "./agent-fulfillment-command.service.js";

const isolated = requireAgentFulfillmentCommandLegacyEnvironment(process.env, "pre-0186"), database = connectDatabase(isolated.url);
const workspace = fileURLToPath(new URL("../../../../", import.meta.url)), contentBytes = randomBytes(32);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const checksum = (value: unknown) => sha(canonicalJson(JSON.parse(JSON.stringify(value))));
const SourceIds = z.object({
  pending: z.object({ orderId: z.uuidv7(), productionId: z.uuidv7(), packageId: z.uuidv7(), shipmentId: z.uuidv7(), versionId: z.uuidv7() }).strict(),
  succeeded: z.object({ orderId: z.uuidv7(), productionId: z.uuidv7(), packageId: z.uuidv7() }).strict(),
}).strict();
const Common = z.object({ context: TenantContextSchema, pendingInput: PrepareFulfillmentCommandSchema, succeededInput: PrepareFulfillmentCommandSchema,
  pendingOrderId: z.uuidv7(), succeededOrderId: z.uuidv7(), pending: FulfillmentCommandViewSchema, succeeded: FulfillmentCommandViewSchema,
  pendingReceipt: FulfillmentCommandListSchema, succeededReceipt: FulfillmentCommandListSchema,
  modelCalls: z.literal(0), workerProcesses: z.literal(0), resourcesClosed: z.literal(true) });
const Seed = Common.extend({ type: z.literal("agent.fulfillment_command.seeded185"), sourceIds: SourceIds }).strict();
const AgentBoundary = z.object({ id: z.uuidv7(), status: z.literal(409), legacyEnvelopeVersionPinned: z.literal(true), rowUnchanged: z.literal(true),
  businessUnchanged: z.literal(true), auditUnchanged: z.literal(true), rowChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  businessChecksum: z.string().regex(/^[a-f0-9]{64}$/), auditChecksum: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const Read = Common.extend({ type: z.literal("agent.fulfillment_command.read185"), agentBoundary: AgentBoundary.nullable() }).strict();
type Mode = "185" | "read185";
type Child = { process: ChildProcess; mode: Mode; done: Promise<number>; forced: boolean; wait(type: string): Promise<unknown> };
const children: Child[] = [];
const proof = { nonce: isolated.nonce, scope: "genuine immutable185 owner source and original records migrated to186; no historical Agent token or lineage backfill",
  details: {} as Record<string, unknown>, cleanupFailed: false, databaseClosed: false, verified: false };
async function bounded<T>(promise: Promise<T>, message: string, ms = 150_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
function child(mode: Mode) {
  const processChild = spawn(process.execPath, ["--import", pathToFileURL(resolve(isolated.root, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
    resolve(workspace, "tools/testing/agent-fulfillment-command-legacy.mts")], { cwd: resolve(isolated.root, "apps/api"), windowsHide: true,
    stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(isolated.root, "apps/api/tsconfig.json"),
      E2E_LEGACY_SCHEMA_TARGET: "current", E2E_AGENT_FULFILLMENT_COMMAND_LEGACY_CHILD: mode,
      E2E_AGENT_FULFILLMENT_COMMAND_CONTENT_KEY: contentBytes.toString("base64url") } });
  const messages = new Map<string, unknown>(), waiting = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  let ended = false, failure: Error | undefined, startupCode: string | null = null, startupType: string | null = null;
  const reject = (error: Error) => { failure = error; for (const value of waiting.values()) value.reject(error); waiting.clear(); };
  processChild.stderr?.on("data", (bytes: Buffer) => { const text = bytes.toString("utf8");
    startupCode ??= /\b(ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)\b/.exec(text)?.[1] ?? null;
    startupType ??= /\b(SyntaxError|TypeError|ReferenceError|TransformError)\b/.exec(text)?.[1] ?? null; });
  processChild.on("message", (raw: unknown) => {
    if (!raw || typeof raw !== "object" || !("type" in raw) || typeof raw.type !== "string") { reject(new Error("agent_fulfillment_legacy_ipc_invalid")); return; }
    if (raw.type === "agent.fulfillment_command.failed185") {
      const safe = z.object({ type: z.literal("agent.fulfillment_command.failed185"), phase: z.string().regex(/^[a-z_]{1,64}$/),
        errorName: z.string().regex(/^[A-Za-z]{1,64}$/), code: z.string().regex(/^[A-Z0-9_]{1,64}$/).nullable() }).strict().safeParse(raw);
      reject(new Error(safe.success ? JSON.stringify(safe.data) : "agent_fulfillment_legacy_finite_failure_invalid")); return;
    }
    if (!["agent.fulfillment_command.seeded185", "agent.fulfillment_command.reader185.ready", "agent.fulfillment_command.read185"].includes(raw.type)
      || messages.has(raw.type) || Buffer.byteLength(JSON.stringify(raw)) > 8 * 1024 * 1024) { reject(new Error("agent_fulfillment_legacy_ipc_invalid")); return; }
    messages.set(raw.type, raw); waiting.get(raw.type)?.resolve(raw); waiting.delete(raw.type);
  });
  const done = new Promise<number>(complete => {
    processChild.once("error", () => reject(new Error("agent_fulfillment_legacy_spawn_failed")));
    processChild.once("close", (code, signal) => { ended = true;
      if (waiting.size) reject(new Error(JSON.stringify({ code: "agent_fulfillment_legacy_early_exit", mode, exitCode: code, signal, startupCode, startupType })));
      complete(code ?? -1); });
  });
  const value: Child = { process: processChild, mode, done, forced: false, wait(type) {
    if (failure) return Promise.reject(failure); if (messages.has(type)) return Promise.resolve(messages.get(type));
    if (ended) return Promise.reject(new Error("agent_fulfillment_legacy_already_exited"));
    return bounded(new Promise<unknown>((resolveMessage, rejectMessage) => waiting.set(type, { resolve: resolveMessage, reject: rejectMessage })), "agent_fulfillment_legacy_ipc_timeout");
  } }; children.push(value); return value;
}
async function send(processChild: Child, message: object) {
  await new Promise<void>((done, reject) => {
    if (!processChild.process.connected || !processChild.process.send) { reject(new Error("agent_fulfillment_legacy_ipc_closed")); return; }
    processChild.process.send(message, error => error ? reject(error) : done());
  });
}
/** Fix original columns before migration; PostgreSQL serializes timestamp
 * microseconds before JavaScript hashes them. No original row text is retained. */
async function projection(context: TenantContext) {
  const columns = await withTenant(database.db, context, tx => tx.execute<{ table_name: string; column_name: string }>(sql`
    select c.table_name,c.column_name from information_schema.columns c
    join pg_class t on t.relname=c.table_name join pg_namespace n on n.oid=t.relnamespace and n.nspname=c.table_schema
    where c.table_schema='public' and t.relkind in ('r','p') and has_table_privilege(current_user,t.oid,'SELECT') order by c.table_name,c.ordinal_position`));
  const tables = new Map<string, string[]>();
  for (const row of columns) {
    if (!/^[a-z_][a-z0-9_]*$/.test(row.table_name) || !/^[a-z_][a-z0-9_]*$/.test(row.column_name)) throw new Error("agent_fulfillment_legacy_projection_identifier_invalid");
    tables.set(row.table_name, [...tables.get(row.table_name) ?? [], row.column_name]);
  }
  return () => withTenant(database.db, context, async tx => {
    await tx.execute(sql.raw("set local time zone 'UTC'")); const values: Array<{ table: string; columns: string[]; count: number; sha256: string }> = [];
    for (const [name, fields] of tables) {
      const [row] = await tx.execute<{ count: number; canonical: string }>(sql`select count(*)::int as count,
        coalesce(string_agg(row_to_json(r)::text,E'\n' order by row_to_json(r)::text),'') as canonical
        from (select ${sql.join(fields.map(field => sql.identifier(field)), sql.raw(","))} from ${sql.identifier(name)}) r`);
      if (!row) throw new Error("agent_fulfillment_legacy_projection_missing"); values.push({ table: name, columns: fields, count: row.count, sha256: sha(row.canonical) });
    }
    return values;
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
async function protocolDenied(promise: Promise<unknown>) {
  const error = await promise.then(() => null, failure => failure); expect(error).toBeInstanceOf(HttpException);
  if (!(error instanceof HttpException)) throw new Error("agent_fulfillment_expected_protocol_refusal_missing");
  expect(error.getStatus()).toBe(409); expect(error.getResponse()).toMatchObject({ code: "agent_fulfillment_command_protocol_mismatch" });
}

describe("genuine185 to186 independent Agent fulfillment lineage", () => {
  afterAll(async () => {
    const failures: unknown[] = [];
    for (const value of children) {
      if (value.process.exitCode === null && value.process.signalCode === null) { value.forced = true; value.process.kill("SIGKILL"); }
      try { if (await bounded(value.done, "agent_fulfillment_legacy_child_close_timeout", 15_000) !== 0 || value.forced) throw new Error("agent_fulfillment_legacy_child_not_normally_closed"); }
      catch (error) { proof.cleanupFailed = true; failures.push(error); }
    }
    contentBytes.fill(0);
    try { await database.client.end(); proof.databaseClosed = true; } catch (error) { proof.cleanupFailed = true; failures.push(error); }
    await mkdir(resolve(isolated.lane, "qa"), { recursive: true });
    await writeFile(resolve(isolated.lane, "qa", `${isolated.nonce}-upgrade-proof.json`), JSON.stringify({ ...proof,
      children: children.map(value => ({ mode: value.mode, pid: value.process.pid ?? null, forced: value.forced, exitCode: value.process.exitCode, signal: value.process.signalCode })) }, null, 2) + "\n", { flag: "wx" });
    if (failures.length) throw new AggregateError(failures, "agent_fulfillment_upgrade_close_failed");
  });
  it("agent_fulfillment_genuine185_preserves_all_original_columns_and_old_receipts_without_adopting_legacy_intents_or_accepting_old_execute", async () => {
    const flags = () => ({ target: process.env.E2E_LEGACY_SCHEMA_TARGET, family: process.env.E2E_AGENT_FULFILLMENT_COMMAND_ISOLATED,
      original: process.env.E2E_FULFILLMENT_COMMAND_ISOLATED, upgrade: process.env.E2E_AGENT_FULFILLMENT_COMMAND_UPGRADE_ISOLATED,
      source: process.env.E2E_AGENT_FULFILLMENT_COMMAND_LEGACY_SOURCE });
    const parentFlags = flags(); await assertAgentFulfillmentCommandOriginal185Graph(isolated.root);
    const producer = child("185"), seed = Seed.parse(await producer.wait("agent.fulfillment_command.seeded185"));
    expect(await bounded(producer.done, "agent_fulfillment_original185_seed_close_timeout", 15_000)).toBe(0);
    expect(seed.pending.status).toBe("prepared"); expect(seed.pending.kind).toBe("shipment_review"); expect(seed.succeeded.status).toBe("succeeded");
    expect(seed.succeeded.receipt?.kind).toBe("production_milestone"); expect(flags()).toEqual(parentFlags);
    const originalColumns = await projection(seed.context), before = await originalColumns(), ledger = (await readMigrationEvidence(database)).actualRows;
    expect(ledger).toHaveLength(185); expect(before.some(value => value.table === "order_fulfillment_command_intents" && value.count === 2)).toBe(true);
    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
    const afterLedger = (await readMigrationEvidence(database)).actualRows; expect(afterLedger).toHaveLength(186); expect(afterLedger.slice(0, 185)).toEqual(ledger);
    expect(await originalColumns()).toEqual(before); expect(flags()).toEqual(parentFlags);
    const orderVault = new SecretVault(Buffer.from(contentBytes)), owners = fulfillmentOwnerPorts(database, orderVault, new SecretVault(randomBytes(32)));
    let originalExecutions = 0;
    class ObservedOriginalOwner extends OrderFulfillmentCommandOwner {
      override async execute(...args: Parameters<OrderFulfillmentCommandOwner["execute"]>) { originalExecutions++; await super.execute(...args); }
    }
    const original = new OrderFulfillmentCommandService(database, orderVault, new ObservedOriginalOwner(database, orderVault, owners.production, owners.delivery, owners.shipping), owners.audit);
    const agent = new AgentFulfillmentCommandService(database, new SecretVault(randomBytes(32)), new AgentFulfillmentCommandOwner(original), owners.audit);
    const query = (orderId: string) => ({ version: AGENT_FULFILLMENT_COMMAND_VERSION, orderId });
    expect(checksum(await original.get(seed.context, seed.pending.id))).toBe(checksum(seed.pending));
    expect(checksum(await original.get(seed.context, seed.succeeded.id))).toBe(checksum(seed.succeeded));
    for (const view of [seed.pending, seed.succeeded]) {
      const [row] = await withTenant(database.db, seed.context, tx => tx.select({ version: orderFulfillmentCommandIntents.contractVersion,
        checksum: orderFulfillmentCommandIntents.requestChecksum }).from(orderFulfillmentCommandIntents).where(eq(orderFulfillmentCommandIntents.id, view.id)));
      expect(row).toEqual({ version: FULFILLMENT_COMMAND_VERSION, checksum: view.requestChecksum });
      await protocolDenied(agent.get(seed.context, view.id, query(view.orderId)));
    }
    await protocolDenied(agent.prepare(seed.context, { ...query(seed.pendingOrderId), original: seed.pendingInput }));
    expect(await originalColumns()).toEqual(before);
    const request = { type: "agent.fulfillment_command.read185.request", context: seed.context, pendingInput: seed.pendingInput, succeededInput: seed.succeededInput,
      pendingId: seed.pending.id, succeededId: seed.succeeded.id, pendingOrderId: seed.pendingOrderId, succeededOrderId: seed.succeededOrderId };
    const reader = child("read185"); await reader.wait("agent.fulfillment_command.reader185.ready"); await send(reader, request);
    const read = Read.parse(await reader.wait("agent.fulfillment_command.read185")); expect(await bounded(reader.done, "agent_fulfillment_original185_reader_close_timeout", 15_000)).toBe(0);
    for (const key of ["pending", "succeeded", "pendingReceipt", "succeededReceipt"] as const) expect(checksum(read[key])).toBe(checksum(seed[key]));
    expect(read.agentBoundary).toBeNull(); expect(await originalColumns()).toEqual(before);
    proof.details.preservation = { tableColumns: before, migrationPrefixCount: 185, migrationCount: 186, originalReaderDTOHashes: {
      pending: checksum(read.pending), succeeded: checksum(read.succeeded), pendingReceipt: checksum(read.pendingReceipt), succeededReceipt: checksum(read.succeededReceipt) } };

    // The preservation comparison is complete. These later explicit native
    // cancel/ack operations legitimately change only the old intent/audit state.
    await original.cancel(seed.context, seed.pending.id); await original.acknowledge(seed.context, seed.pending.id); await original.acknowledge(seed.context, seed.succeeded.id);
    if (seed.pendingInput.kind !== "shipment_review") throw new Error("agent_fulfillment_old_shipment_review_required");
    const newInput = PrepareFulfillmentCommandSchema.parse({ ...seed.pendingInput, requestId: randomUUID(), input: { ...seed.pendingInput.input, idempotencyKey: randomUUID() } });
    const prepared = await agent.prepare(seed.context, { ...query(seed.pendingOrderId), original: newInput }); expect(prepared.canConfirm).toBe(true);
    const [lineage] = await withTenant(database.db, seed.context, tx => tx.select({ version: orderFulfillmentCommandIntents.contractVersion })
      .from(orderFulfillmentCommandIntents).where(eq(orderFulfillmentCommandIntents.id, prepared.native.id)));
    expect(lineage?.version).toBe(AGENT_FULFILLMENT_COMMAND_VERSION);
    const native = await original.get(seed.context, prepared.native.id); expect(native).toMatchObject({ summary: null, receipt: null, canExecute: false, canCancel: false });
    const negative = child("read185"); await negative.wait("agent.fulfillment_command.reader185.ready"); await send(negative, { ...request, agentId: prepared.native.id });
    const denied = Read.parse(await negative.wait("agent.fulfillment_command.read185"));
    expect(await bounded(negative.done, "agent_fulfillment_old_execute_refusal_close_timeout", 15_000)).toBe(0);
    expect(denied.agentBoundary).toMatchObject({ id: prepared.native.id, status: 409, legacyEnvelopeVersionPinned: true, rowUnchanged: true, businessUnchanged: true, auditUnchanged: true });
    const control = { ...query(seed.pendingOrderId), requestId: prepared.native.requestId, requestChecksum: prepared.native.requestChecksum };
    const cancelled = await agent.cancel(seed.context, prepared.native.id, { ...control, decision: "cancel_original" }); expect(cancelled.native.status).toBe("cancelled");
    const acknowledged = await agent.acknowledge(seed.context, prepared.native.id, { ...control, decision: "acknowledge_original" }); expect(acknowledged.native.status).toBe("acknowledged");
    expect(originalExecutions).toBe(0);
    proof.details.boundary = { newIntentId: prepared.native.id, newContractVersion: lineage?.version, legacyExecution: denied.agentBoundary,
      oldIntentProtocolUnchanged: true, newOriginalExecutions: originalExecutions, newPreparationExplicitlyCancelledAndAcknowledged: true };
    expect(flags()).toEqual(parentFlags); proof.verified = true;
  });
});
