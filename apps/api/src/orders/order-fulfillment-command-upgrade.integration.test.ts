import "reflect-metadata";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { SecretVault } from "@yummyai/ai-core";
import { EntityIdSchema, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { PrepareFulfillmentCommandSchema } from "@yummyai/contracts/order/fulfillment-command";
import { ProductionDeliveryPackageViewSchema } from "@yummyai/contracts/order/production-delivery";
import { QualityGroupsWorkspaceSchema } from "@yummyai/contracts/order/quality-groups";
import { CreateShipmentInputSchema, ReviewShipmentVersionInputSchema } from "@yummyai/contracts/order/shipment";
import { assertDatabaseMigrationsCurrent, connectDatabase, migrateDatabase, orderFulfillmentCommandIntents, readMigrationEvidence, withTenant } from "@yummyai/database";
import { assertFulfillmentCommandOriginal184Graph, requireFulfillmentCommandLegacyEnvironment } from "../../../../tools/testing/fulfillment-command-legacy.mjs";
import { fulfillmentOwnerPorts } from "../ai/agent-fulfillment.test-fixture.js";
import { OrderFulfillmentCommandOwner } from "./order-fulfillment-command-owner.js";
import { OrderFulfillmentCommandService } from "./order-fulfillment-command.service.js";

const isolated = requireFulfillmentCommandLegacyEnvironment(process.env, "pre-0185"), database = connectDatabase(isolated.url);
const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const jsonValue = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const viewChecksum = (value: unknown) => sha(canonicalJson(jsonValue(value)));
const OriginalViews = z.object({
  productionView: z.record(z.string(), z.unknown()), deliveryView: ProductionDeliveryPackageViewSchema,
  shipmentView: z.record(z.string(), z.unknown()), qualityView: QualityGroupsWorkspaceSchema,
  resourcesClosed: z.literal(true), modelCalls: z.literal(0), workerProcesses: z.literal(0),
});
const Seed = OriginalViews.extend({ type: z.literal("fulfillment.seeded184"), context: TenantContextSchema,
  orderId: EntityIdSchema, productionId: EntityIdSchema, packageId: EntityIdSchema, shipmentId: EntityIdSchema,
  shipmentInput: CreateShipmentInputSchema, reviewInput: ReviewShipmentVersionInputSchema, versionId: EntityIdSchema,
}).strict();
const Read = OriginalViews.extend({ type: z.literal("fulfillment.read184") }).strict();
const Ready = z.object({ type: z.literal("fulfillment.reader184.ready") }).strict();
const Failure = z.object({ type: z.literal("fulfillment.failed184"),
  phase: z.enum(["environment", "graph", "imports", "schema", "identity", "seed", "reader_wait", "reader_get", "cleanup"]),
  code: z.string().regex(/^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/).nullable(),
  errorName: z.enum(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AggregateError", "ZodError", "PostgresError", "DrizzleQueryError",
    "ConflictException", "ForbiddenError", "ForbiddenException", "NotFoundException", "BadRequestException"]),
}).strict();
type Mode = "184" | "read184";
type Child = { process: ChildProcess; mode: Mode; done: Promise<number>; wait(type: string): Promise<unknown>; forced: boolean };
const children: Child[] = [], contentBytes = randomBytes(32);
const proof: { nonce: string; cleanupFailed: boolean; databaseClosed: boolean; verified: boolean; details: Record<string, unknown> } = {
  nonce: isolated.nonce, cleanupFailed: false, databaseClosed: false, verified: false, details: {},
};
async function bounded<T>(operation: Promise<T>, label: string, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}
function originalChild(mode: Mode) {
  const childProcess = spawn(process.execPath, ["--import", pathToFileURL(resolve(isolated.root, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
    resolve(workspace, "tools/testing/fulfillment-command-legacy.mts")], {
    cwd: resolve(isolated.root, "apps/api"), windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(isolated.root, "apps/api/tsconfig.json"),
      E2E_LEGACY_SCHEMA_TARGET: "current", E2E_FULFILLMENT_COMMAND_LEGACY_CHILD: mode, E2E_FULFILLMENT_COMMAND_CONTENT_KEY: contentBytes.toString("base64url") },
  });
  const messages = new Map<string, unknown>(), waiting = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  let stopped = false, failure: Error | undefined, startupCode: string | null = null, startupType: string | null = null;
  const rejectWaiting = (error: Error) => { failure = error; for (const pending of waiting.values()) pending.reject(error); waiting.clear(); };
  childProcess.stderr?.on("data", (bytes: Buffer) => {
    const text = bytes.toString("utf8");
    startupCode ??= /\b(ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)\b/.exec(text)?.[1] ?? null;
    startupType ??= /\b(SyntaxError|ReferenceError|TypeError|RangeError|TransformError)\b/.exec(text)?.[1] ?? null;
  });
  childProcess.on("message", (raw: unknown) => {
    if (!raw || typeof raw !== "object" || !("type" in raw) || typeof raw.type !== "string") { rejectWaiting(new Error("fulfillment_legacy_ipc_shape_invalid")); return; }
    if (raw.type === "fulfillment.failed184") {
      const finite = Failure.safeParse(raw);
      rejectWaiting(new Error(finite.success ? JSON.stringify(finite.data) : "fulfillment_legacy_finite_failure_invalid")); return;
    }
    if (!["fulfillment.seeded184", "fulfillment.reader184.ready", "fulfillment.read184"].includes(raw.type)
      || messages.has(raw.type) || Buffer.byteLength(JSON.stringify(raw)) > 8 * 1024 * 1024) {
      rejectWaiting(new Error("fulfillment_legacy_ipc_shape_invalid")); return;
    }
    messages.set(raw.type, raw); waiting.get(raw.type)?.resolve(raw); waiting.delete(raw.type);
  });
  const done = new Promise<number>(resolveDone => {
    childProcess.once("error", () => { rejectWaiting(new Error("fulfillment_legacy_child_spawn_failed")); });
    childProcess.once("close", (code, signal) => {
      stopped = true;
      if (waiting.size) rejectWaiting(new Error(JSON.stringify({ code: "fulfillment_legacy_early_exit", mode, exitCode: code, signal, startupCode, startupType })));
      resolveDone(code ?? -1);
    });
  });
  const child: Child = { process: childProcess, mode, done, forced: false, wait(type) {
    if (failure) return Promise.reject(failure);
    if (messages.has(type)) return Promise.resolve(messages.get(type));
    if (stopped) return Promise.reject(new Error("fulfillment_legacy_already_exited"));
    return bounded(new Promise<unknown>((resolveMessage, reject) => waiting.set(type, { resolve: resolveMessage, reject })), "fulfillment_legacy_ipc_deadline", 150_000);
  } };
  children.push(child); return child;
}

/** Original SQL columns are fixed before migration. PostgreSQL row_to_json is
 * hashed before JavaScript can truncate timestamp microseconds. Tenant rows
 * remain under the non-owner application's forced RLS; no row text is retained. */
async function originalProjection(context: TenantContext) {
  const columns = await withTenant(database.db, context, tx => tx.execute<{ table_name: string; column_name: string }>(sql`
    select c.table_name,c.column_name from information_schema.columns c
    join pg_class t on t.relname=c.table_name join pg_namespace n on n.oid=t.relnamespace and n.nspname=c.table_schema
    where c.table_schema='public' and t.relkind in ('r','p') and has_table_privilege(current_user,t.oid,'SELECT')
    order by c.table_name,c.ordinal_position`), { isolationLevel: "repeatable read", accessMode: "read only" });
  const tables = new Map<string, string[]>();
  for (const row of columns) {
    if (!/^[a-z_][a-z0-9_]*$/.test(row.table_name) || !/^[a-z_][a-z0-9_]*$/.test(row.column_name)) throw new Error("fulfillment_upgrade_projection_identifier_invalid");
    tables.set(row.table_name, [...tables.get(row.table_name) ?? [], row.column_name]);
  }
  return { snapshot: () => withTenant(database.db, context, async tx => {
    await tx.execute(sql.raw("set local time zone 'UTC'"));
    const values: Array<{ table: string; columns: string[]; rows: number; sha256: string }> = [];
    for (const [name, fields] of tables) {
      const [row] = await tx.execute<{ rows: number; canonical: string }>(sql`
        select count(*)::int as rows,coalesce(string_agg(row_to_json(t)::text,E'\n' order by row_to_json(t)::text),'') as canonical
        from (select ${sql.join(fields.map(field => sql.identifier(field)), sql.raw(","))} from ${sql.identifier(name)}) t`);
      if (!row) throw new Error("fulfillment_upgrade_projection_missing");
      values.push({ table: name, columns: fields, rows: row.rows, sha256: sha(row.canonical) });
    }
    return values;
  }, { isolationLevel: "repeatable read", accessMode: "read only" }) };
}

describe("genuine184 original fulfillment owners to185 independent recovery journal", () => {
  afterAll(async () => {
    const failures: unknown[] = [];
    for (const child of children) {
      if (child.process.exitCode === null && child.process.signalCode === null) { child.forced = true; child.process.kill("SIGKILL"); }
      try {
        const exitCode = await bounded(child.done, "fulfillment_upgrade_child_close_deadline", 15_000);
        if (child.forced || exitCode !== 0) throw new Error("fulfillment_upgrade_child_not_normally_closed");
      } catch (error) { proof.cleanupFailed = true; failures.push(error); }
    }
    contentBytes.fill(0);
    try { await database.client.end(); proof.databaseClosed = true; } catch (error) { proof.cleanupFailed = true; failures.push(error); }
    await mkdir(resolve(isolated.lane, "qa"), { recursive: true });
    await writeFile(resolve(isolated.lane, "qa", `${isolated.nonce}-upgrade-proof.json`), JSON.stringify({ ...proof,
      children: children.map(child => ({ mode: child.mode, pid: child.process.pid ?? null, exitCode: child.process.exitCode, signal: child.process.signalCode, forced: child.forced })),
    }, null, 2) + "\n", { flag: "wx" });
    if (failures.length) throw new AggregateError(failures, "fulfillment_upgrade_teardown_failed");
  });
  it("fulfillment_genuine184 preserves every original visible column and NULL old milestone checksums then restores the exact old shipment without executing an owner", async () => {
    const flags = () => ({ target: process.env.E2E_LEGACY_SCHEMA_TARGET, family: process.env.E2E_FULFILLMENT_COMMAND_ISOLATED, source: process.env.E2E_FULFILLMENT_COMMAND_LEGACY_SOURCE });
    const originalFlags = flags();
    await assertFulfillmentCommandOriginal184Graph(isolated.root);
    const seedProcess = originalChild("184"), seed = Seed.parse(await seedProcess.wait("fulfillment.seeded184"));
    expect(await bounded(seedProcess.done, "fulfillment_original184_seed_close_deadline", 15_000)).toBe(0);
    expect(seedProcess.forced).toBe(false); expect(seed.deliveryView.id).toBe(seed.packageId);
    expect(seed.qualityView.productionOrderId).toBe(seed.productionId); expect(seed.qualityView.groups.some(group => group.result === "passed" && group.quantity === 3)).toBe(true);
    const projection = await originalProjection(seed.context), before = await projection.snapshot();
    const ledgerBefore = (await readMigrationEvidence(database)).actualRows;
    expect(ledgerBefore).toHaveLength(184); expect(before.some(row => row.table === "order_fulfillment_command_intents")).toBe(false);
    for (const [table, minimum] of [["production_milestone_events", 2], ["quality_inspections", 1], ["production_delivery_feedback", 3], ["shipments", 1], ["shipment_version_reviews", 1]] as const)
      expect(before.find(row => row.table === table)?.rows, table).toBeGreaterThanOrEqual(minimum);

    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
    const ledgerAfter = (await readMigrationEvidence(database)).actualRows;
    expect(ledgerAfter).toHaveLength(185); expect(ledgerAfter.slice(0, 184)).toEqual(ledgerBefore);
    expect(await projection.snapshot()).toEqual(before);
    expect(await withTenant(database.db, seed.context, tx => tx.select().from(orderFulfillmentCommandIntents))).toEqual([]);
    const [historical] = await withTenant(database.db, seed.context, tx => tx.execute<{ count: number; nonnull: number }>(sql`
      select count(*)::int as count,count(request_checksum)::int as nonnull from production_milestone_events where production_order_id=${seed.productionId}::uuid`));
    expect(historical?.count).toBeGreaterThanOrEqual(2); expect(historical?.nonnull).toBe(0); expect(flags()).toEqual(originalFlags);

    // The original process has fully exited. New readers use the same explicitly
    // supplied temporary vault, not the unrelated default seed fixture key.
    const vault = new SecretVault(Buffer.from(contentBytes)), owners = fulfillmentOwnerPorts(database, vault, new SecretVault(Buffer.from(contentBytes)));
    const currentViews = async () => ({ productionView: await owners.production.get(seed.context, seed.productionId),
      deliveryView: await owners.delivery.get(seed.context, seed.packageId), shipmentView: await owners.shipping.get(seed.context, seed.shipmentId),
      qualityView: await owners.production.qualityGroups(seed.context, seed.productionId) });
    const viewsBefore = { productionView: seed.productionView, deliveryView: seed.deliveryView, shipmentView: seed.shipmentView, qualityView: seed.qualityView };
    expect(viewChecksum(await currentViews())).toBe(viewChecksum(viewsBefore)); expect(await projection.snapshot()).toEqual(before);

    const reader = originalChild("read184"); Ready.parse(await reader.wait("fulfillment.reader184.ready"));
    await new Promise<void>((done, reject) => {
      if (!reader.process.connected || !reader.process.send) { reject(new Error("fulfillment_old_reader_ipc_closed")); return; }
      reader.process.send({ type: "fulfillment.read184.request", context: seed.context, orderId: seed.orderId,
        productionId: seed.productionId, packageId: seed.packageId, shipmentId: seed.shipmentId }, error => error ? reject(error) : done());
    });
    const read = Read.parse(await reader.wait("fulfillment.read184"));
    expect(await bounded(reader.done, "fulfillment_original184_reader_close_deadline", 15_000)).toBe(0); expect(reader.forced).toBe(false);
    expect(viewChecksum({ productionView: read.productionView, deliveryView: read.deliveryView, shipmentView: read.shipmentView, qualityView: read.qualityView })).toBe(viewChecksum(viewsBefore));
    expect(await projection.snapshot()).toEqual(before);

    let ownerExecutions = 0;
    class RecoveryOwner extends OrderFulfillmentCommandOwner {
      override async execute(...args: Parameters<OrderFulfillmentCommandOwner["execute"]>) { ownerExecutions++; await super.execute(...args); }
    }
    const owner = new RecoveryOwner(database, vault, owners.production, owners.delivery, owners.shipping);
    const service = new OrderFulfillmentCommandService(database, vault, owner, owners.audit);
    const input = PrepareFulfillmentCommandSchema.parse({ kind: "shipment_create", requestId: randomUUID(), targetId: seed.orderId, input: seed.shipmentInput });
    const adopted = await service.prepare(seed.context, input);
    expect(adopted.status).toBe("succeeded"); expect(adopted.receipt).toEqual({ kind: "shipment_create", shipmentId: seed.shipmentId, versionId: seed.versionId, versionNumber: 1 });
    const factsAfterExplicitPrepare = await projection.snapshot();
    expect(factsAfterExplicitPrepare.filter(row => row.table !== "audit_events")).toEqual(before.filter(row => row.table !== "audit_events"));
    expect(factsAfterExplicitPrepare.find(row => row.table === "audit_events")?.rows).toBe((before.find(row => row.table === "audit_events")?.rows ?? 0) + 1);
    const get = await service.get(seed.context, adopted.id), lookup = await service.list(seed.context, { orderId: seed.orderId, requestId: adopted.requestId, requestChecksum: adopted.requestChecksum });
    expect(get.receipt).toEqual(adopted.receipt); expect(lookup.items.map(row => row.id)).toEqual([adopted.id]);
    expect((await service.prepare(seed.context, input)).id).toBe(adopted.id);
    expect(await projection.snapshot()).toEqual(factsAfterExplicitPrepare); expect(ownerExecutions).toBe(0);
    expect(owners.shipmentEnqueues).toHaveLength(0); expect(owners.logisticsEnqueues).toHaveLength(0);
    expect(Object.values(owners.carrier.calls).every(count => count === 0)).toBe(true);
    expect(viewChecksum(await currentViews())).toBe(viewChecksum(viewsBefore));
    const acknowledged = await service.acknowledge(seed.context, adopted.id);
    expect(acknowledged.status).toBe("acknowledged"); expect(acknowledged.receipt).toBeNull();
    const [row] = await withTenant(database.db, seed.context, tx => tx.select().from(orderFulfillmentCommandIntents));
    expect(row?.encryptedInput).toBeNull(); expect(row?.acknowledgedAt).not.toBeNull();
    expect((await projection.snapshot()).filter(item => item.table !== "audit_events")).toEqual(before.filter(item => item.table !== "audit_events"));
    await assertFulfillmentCommandOriginal184Graph(isolated.root); expect(flags()).toEqual(originalFlags);
    proof.verified = true;
    proof.details = { sourceSchema: 184, targetSchema: 185, originalSourceFiles: 3773, originalSourceSha256: "fc598294ed6bc94426a5caaa5abc63456774698bcd236b61a3249fa30dda7ec8",
      originalDependencyLinks: 389, originalNativeRuntimeFiles: 23, projectionScope: "all_original_columns_visible_to_nonowner_application_role_with_original_seed_tenant_RLS",
      original: before, originalColumnsPreservedImmediatelyAfterMigration: true, oldMilestoneChecksumBackfilled: false, newJournalRowsBeforeExplicitPrepare: 0,
      currentOriginalReaderUnchanged: true, actualOriginal184ReaderAfter185Unchanged: true, parentEnvironmentUnchanged: true,
      recovery: { intentId: adopted.id, requestId: adopted.requestId, requestChecksum: adopted.requestChecksum, shipmentId: seed.shipmentId, versionId: seed.versionId,
        ownerExecutions, readOnlyGetAndListRecovery: true, explicitPrepareReplayPreservesOriginal: true, originalFactsRewritten: false, bodyClearedAfterAcknowledgement: true },
      carrierCalls: owners.carrier.calls, shipmentEnqueues: owners.shipmentEnqueues.length, logisticsEnqueues: owners.logisticsEnqueues.length, modelCalls: 0, workerProcesses: 0,
      scope: "Actual original184 owners with synthetic initial work and physical attestations; no model, external factory, carrier transaction or consumer",
      retainedHistory: "original184_business_rows_and_new_explicit185_recovery_index_until_outer_disposable_database_teardown" };
  });
});
