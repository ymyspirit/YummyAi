import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "../../packages/database/src/client.ts";

/** Applies only the real canonical 159 prefix to an exact, empty nonce database. */
export async function migrateProductionQuantityLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  if (process.env.E2E_PRODUCTION_QUANTITY_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0160" ||
      !/^order_daily_e2e_[a-f0-9]{32}$/.test(expectedName)) throw new Error("Production quantity legacy migration requires its dedicated disposable runner");
  const [actual] = await connection.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== expectedName || actual.ledger !== null || actual.populated !== false)
    throw new Error("Production quantity legacy migration requires the exact fresh database");
  const requireDatabase = createRequire(new URL("../../packages/database/package.json", import.meta.url));
  const { readMigrationFiles } = requireDatabase("drizzle-orm/migrator");
  const migrationsFolder = fileURLToPath(new URL("../../packages/database/migrations/", import.meta.url));
  const journal = JSON.parse(await readFile(new URL("../../packages/database/migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ tag: string; when: number }> };
  const target = journal.entries.find(entry => entry.tag === "0160_production_physical_quantities");
  if (!target) throw new Error("Canonical production quantity migration missing");
  const migrations = (readMigrationFiles({ migrationsFolder }) as Array<{ folderMillis: number; sql: string[]; hash: string }>)
    .filter(migration => migration.folderMillis < target.when);
  if (migrations.length !== 159) throw new Error("Canonical original159 migration prefix required");
  await connection.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    await tx.unsafe("create schema drizzle");
    await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) {
      for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]);
    }
  });
}

async function seedLegacyProductionQuantity() {

// The only connections and business imports below use the original159 snapshot.
// Validate the complete disposable boundary before importing that database code.
const root = process.env.E2E_PRODUCTION_QUANTITY_LEGACY_SOURCE;
const value = process.env.DATABASE_URL;
if (!process.connected || !root || !isAbsolute(root) || !value || process.env.E2E_ISOLATED_DAILY !== "1" ||
    process.env.E2E_PRODUCTION_QUANTITY_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0160")
  throw new Error("Actual159 quantity IPC requires its isolated legacy source");
const url = new URL(value), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
if (!["postgres:", "postgresql:"].includes(url.protocol) || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Actual159 quantity IPC refuses an ordinary database or bucket");

const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
createRequire(pathToFileURL(resolve(root, "apps/api/package.json")))("reflect-metadata");
const d = await load("packages/database/src/index.ts") as typeof import("../../packages/database/src/index.js");
const { factoryCapacityFixture } = await load("apps/api/src/suppliers/factory-capacity.test-fixture.ts") as typeof import("../../apps/api/src/suppliers/factory-capacity.test-fixture.js");
const { ProductionCommandService } = await load("apps/api/src/orders/production-command.service.ts") as typeof import("../../apps/api/src/orders/production-command.service.js");
const database = d.connectDatabase(), fixture = factoryCapacityFixture(database);
let phase = "ledger";
const send = (message: object) => new Promise<void>((resolveSend, reject) => process.send!(message, error => error ? reject(error) : resolveSend()));

try {
  if ((await d.readMigrationEvidence(database)).actualRows.length !== 159) throw new Error("Actual159 ledger required");
  phase = "membership";
  await fixture.initialize();
  async function source(quantity = 10) {
    const site = await fixture.factory(), pool = await fixture.pool(site, quantity * 4);
    const input = await fixture.source(site, quantity, pool.pool);
    return { site, pool, ...input };
  }
  const milestone = async (id: string, type: "submitted" | "acknowledged" | "started" | "completed" | "cancel_requested" | "cancelled") => {
    const actual = await fixture.production.get(fixture.context, id);
    return fixture.production.recordMilestone(fixture.context, id, { type, expectedProjectionVersion: actual.productionOrder.projectionVersion,
      externalEventId: randomUUID(), occurredAt: (await fixture.clock()).now,
      evidence: { code: "SYNTHETIC_ACTUAL159_EVENT", note: null, assetIds: [] } });
  };
  phase = "planned";
  const planned = await source(), original = await fixture.production.create(fixture.context, planned.order.id, planned.input);
  phase = "committed";
  const started = await source(), committed = await fixture.production.create(fixture.context, started.order.id, started.input);
  for (const type of ["submitted", "acknowledged", "started"] as const) await milestone(committed.productionOrder.id, type);
  phase = "cancelled-before-start";
  const cancelSource = await source(), released = await fixture.production.create(fixture.context, cancelSource.order.id, cancelSource.input);
  for (const type of ["cancel_requested", "cancelled"] as const) await milestone(released.productionOrder.id, type);
  phase = "cancelled-after-start";
  const committedCancelSource = await source(), cancelledCommitted = await fixture.production.create(fixture.context, committedCancelSource.order.id, committedCancelSource.input);
  for (const type of ["submitted", "acknowledged", "started", "cancel_requested", "cancelled"] as const) await milestone(cancelledCommitted.productionOrder.id, type);
  phase = "old-command";
  const commands = new ProductionCommandService(database, fixture.vault, fixture.production);
  const commandSource = await source(), preparedInput = { kind: "approved_design" as const, targetId: commandSource.order.id, input: commandSource.input };
  const command = await commands.prepare(fixture.context, preparedInput), success = await commands.execute(fixture.context, command.id);
  if (success.status !== "succeeded" || !success.receipt) throw new Error("Actual159 command must succeed");
  const pendingSource = await source(), pending = await commands.prepare(fixture.context, { kind: "approved_design", targetId: pendingSource.order.id, input: pendingSource.input });
  await send({ type: "quantity.seeded159", context: fixture.context,
    planned: { id: original.productionOrder.id, orderId: planned.order.id, input: planned.input },
    committed: { id: committed.productionOrder.id }, released: { id: released.productionOrder.id },
    cancelledCommitted: { id: cancelledCommitted.productionOrder.id },
    command: { id: command.id, input: preparedInput, receipt: success.receipt },
    pending: { id: pending.id, input: { kind: "approved_design", targetId: pendingSource.order.id, input: pendingSource.input } } });
} catch (error) {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Za-z0-9_]{1,80}$/.test(error.code) ? error.code : undefined;
  await send({ type: "quantity.failed", phase, ...(code ? { code } : {}) });
  throw new Error("Synthetic original159 quantity seed failed");
} finally {
  await database.client.end();
}
}

// Importing the migration helper into the runner never seeds data or connects.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await seedLegacyProductionQuantity();
