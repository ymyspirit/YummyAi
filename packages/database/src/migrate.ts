import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

import { readMigrationFiles } from "drizzle-orm/migrator";

import { connectDatabase, type DatabaseConnection } from "./client.js";
import { inspectDatabaseSchemaShape } from "./schema-shape.js";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

export class DatabaseMigrationReadinessError extends Error {
  readonly code = "DATABASE_MIGRATIONS_NOT_READY";
  constructor() { super("Database migrations do not match the current application code"); this.name = "DatabaseMigrationReadinessError"; }
}

export async function readMigrationEvidence(connection: DatabaseConnection) {
  const expected = readMigrationFiles({ migrationsFolder });
  let actual: Array<{ hash: unknown; created_at: unknown }>;
  try { actual = await connection.client.unsafe("select hash, created_at from drizzle.__drizzle_migrations order by created_at,id"); }
  catch { throw new DatabaseMigrationReadinessError(); }
  const canonicalRows = expected.map(entry => ({ hash: entry.hash, created_at: String(entry.folderMillis) }));
  const actualRows = actual.map(entry => ({ hash: String(entry.hash), created_at: String(entry.created_at) }));
  const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    canonicalRows, actualRows,
    canonicalSha256: sha(canonicalRows), actualSha256: sha(actualRows),
    timestampsMatch: actualRows.length === canonicalRows.length && actualRows.every((row, index) => row.created_at === canonicalRows[index]?.created_at),
    drift: actualRows.flatMap((row, index) => row.hash === canonicalRows[index]?.hash ? [] : [{ index, actualHash: row.hash, expectedHash: canonicalRows[index]?.hash ?? null, createdAt: row.created_at }]),
  };
}

/** Read-only global metadata. Historical hashes remain intact. A legacy schema
 * adoption requires an immutable operational receipt and a fresh full schema
 * match; missing, stale or forged application-side evidence never grants ready. */
export async function assertDatabaseMigrationsCurrent(connection: DatabaseConnection) {
  const evidence = await readMigrationEvidence(connection);
  if (!evidence.timestampsMatch) throw new DatabaseMigrationReadinessError();
  if (evidence.drift.length) {
    try {
      const [receipt] = await connection.client.unsafe<{ schema_sha256: string }[]>(
        "select schema_sha256 from public.schema_adoption_receipts where canonical_migrations_sha256=$1 and actual_migrations_sha256=$2 and migration_count=$3 and verification_version='postgres-public-schema-v1' and evidence @> '{\"schema_matched\":true,\"original_data_matched\":true,\"objects_matched\":true}'::jsonb order by created_at desc limit 1",
        [evidence.canonicalSha256, evidence.actualSha256, evidence.canonicalRows.length],
      );
      if (!receipt || (await inspectDatabaseSchemaShape(connection.client)).sha256 !== receipt.schema_sha256) throw new DatabaseMigrationReadinessError();
    } catch { throw new DatabaseMigrationReadinessError(); }
  }
  return { migrations: evidence.canonicalRows.length };
}

export async function migrateDatabase(connection: DatabaseConnection): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder });
  // Drizzle's journal, statement splitting, checksums and ledger format remain
  // authoritative. Run their statements in one postgres.js transaction so the
  // migration and its transaction-scoped lock use one physical connection.
  await connection.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations', 0))");
    await tx.unsafe("create schema if not exists drizzle");
    await tx.unsafe("create table if not exists drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    const [latest] = await tx.unsafe("select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1");
    for (const migration of migrations) {
      if (latest && Number(latest.created_at) >= migration.folderMillis) continue;
      for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]);
    }
  });
}

async function main(): Promise<void> {
  const connection = connectDatabase();

  try {
    if (process.argv.includes("--check")) {
      const readiness = await assertDatabaseMigrationsCurrent(connection);
      process.stdout.write(JSON.stringify({ databaseReady: true, ...readiness }) + "\n");
    } else {
      await migrateDatabase(connection);
    }
  } finally {
    await connection.client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
