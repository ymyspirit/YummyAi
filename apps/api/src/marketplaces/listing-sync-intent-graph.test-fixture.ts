import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "@yummyai/database";
import { requireListingSyncIntentEnvironment } from "../../../../tools/testing/require-listing-sync-intent-environment.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const legacyRoot = resolve(root, "tmp/listing-sync-intent-20261022-b7d3e8f2/old180-source");
const checkpoint = resolve(root, "docs/project-control/checkpoints/2026-10-22-listing-sync-intent-b7d3e8f2");
/** Pure filesystem preflight. Loads no current contracts, database or services at runtime. */
export async function assertListingSyncIntentOriginal180Graph(candidate: string) {
  if (resolve(candidate) !== legacyRoot) throw new Error("listing_sync_intent_original180_root_invalid");
  const source = JSON.parse(await readFile(checkpoint + "-source-before.json", "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
  const graph = JSON.parse(await readFile(checkpoint + "-old180-source.json", "utf8")) as { operation: string; sourceRoot: string; sourceFiles: number; sourceSha256: string;
    workspaceDependenciesPinned: boolean; links: Array<{ path: string; target: string }> };
  if (graph.operation !== "b7d3e8f2" || graph.sourceFiles !== 3570 || source.files.length !== 3570 || graph.links.length !== 400 || !graph.workspaceDependenciesPinned ||
    resolve(graph.sourceRoot) !== legacyRoot || source.sha256 !== "4db87f01a7534050b30e538f0c7971a11b1c0527cac700b15a9e6715837be13d" || graph.sourceSha256 !== source.sha256)
    throw new Error("listing_sync_intent_original180_manifest_invalid");
  for (const file of source.files) { const path = resolve(candidate, file.path), rel = relative(candidate, path);
    if (rel.startsWith("..") || isAbsolute(rel) || createHash("sha256").update(await readFile(path)).digest("hex") !== file.sha256) throw new Error("listing_sync_intent_original180_bytes_changed"); }
  for (const link of graph.links) if (await realpath(link.path) !== await realpath(link.target)) throw new Error("listing_sync_intent_original180_dependency_changed");
  for (const name of ["contracts", "database", "authz", "marketplace-connectors"])
    if (await realpath(resolve(candidate, "apps/api/node_modules/@yummyai", name)) !== await realpath(resolve(candidate, "packages", name))) throw new Error("listing_sync_intent_original180_workspace_escaped");
  const contract = JSON.parse(await readFile(resolve(candidate, "packages/contracts/package.json"), "utf8")) as { exports: Record<string, unknown> };
  if (contract.exports["./marketplace/listing-sync-intent"]) throw new Error("listing_sync_intent_new_export_reachable_from_original180");
  const journal = JSON.parse(await readFile(resolve(candidate, "packages/database/migrations/meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  if (journal.entries.length !== 180 || !journal.entries.at(-1)?.tag.startsWith("0180_")) throw new Error("listing_sync_intent_original180_journal_changed");
}

/** No current runtime imports: preflight the sealed source before using its original migration reader and SQL. */
export async function migrateListingSyncIntentLegacyDatabase(database: DatabaseConnection, name: string, env: NodeJS.ProcessEnv) {
  const target = requireListingSyncIntentEnvironment(env, "pre-0181"); if (name !== target.name) throw new Error("listing_sync_intent_original180_database_mismatch");
  await assertListingSyncIntentOriginal180Graph(env.E2E_LISTING_SYNC_INTENT_LEGACY_SOURCE!);
  const [actual] = await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== name || actual.ledger !== null || actual.populated !== false) throw new Error("listing_sync_intent_original180_database_not_empty");
  const original = createRequire(pathToFileURL(resolve(legacyRoot, "packages/database/package.json")));
  const { readMigrationFiles } = original("drizzle-orm/migrator") as { readMigrationFiles(input: { migrationsFolder: string }): Array<{ sql: string[]; hash: string; folderMillis: number }> };
  const migrations = readMigrationFiles({ migrationsFolder: resolve(legacyRoot, "packages/database/migrations") }); if (migrations.length !== 180) throw new Error("listing_sync_intent_original180_migrations_changed");
  await database.client.begin(async tx => { await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    await tx.unsafe("create schema drizzle"); await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) { for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at)values($1,$2)", [migration.hash, migration.folderMillis]); } });
}
