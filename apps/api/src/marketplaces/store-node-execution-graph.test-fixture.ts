import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "@yummyai/database";
import { requireStoreNodeExecutionEnvironment } from "../../../../tools/testing/require-store-node-execution-environment.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const legacyRoot = resolve(root, "tmp/store-node-execution-20261022-e6f2c8a1/old179-source");
const checkpoint = resolve(root, "docs/project-control/checkpoints/2026-10-22-store-node-execution-e6f2c8a1");
/** Pure filesystem preflight. Loads no current contracts, database or services at runtime. */
export async function assertStoreNodeExecutionOriginal179Graph(candidate: string) {
  if (resolve(candidate) !== legacyRoot) throw new Error("store_node_original179_root_invalid");
  const source = JSON.parse(await readFile(checkpoint + "-source-before.json", "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
  const graph = JSON.parse(await readFile(checkpoint + "-old179-source.json", "utf8")) as { operation: string; sourceRoot: string; sourceFiles: number; sourceSha256: string;
    workspaceDependenciesPinned: boolean; links: Array<{ path: string; target: string }> };
  if (graph.operation !== "e6f2c8a1" || graph.sourceFiles !== 3531 || source.files.length !== 3531 || graph.links.length !== 399 || !graph.workspaceDependenciesPinned ||
    resolve(graph.sourceRoot) !== legacyRoot || source.sha256 !== "b7e22cc41878ea9b69a5d3ca5124e5c180320f8e2d182d35b1cf60f27da9f0cd" || graph.sourceSha256 !== source.sha256)
    throw new Error("store_node_original179_manifest_invalid");
  for (const file of source.files) { const path = resolve(candidate, file.path), rel = relative(candidate, path);
    if (rel.startsWith("..") || isAbsolute(rel) || createHash("sha256").update(await readFile(path)).digest("hex") !== file.sha256) throw new Error("store_node_original179_bytes_changed"); }
  for (const link of graph.links) if (await realpath(link.path) !== await realpath(link.target)) throw new Error("store_node_original179_dependency_changed");
  for (const name of ["contracts", "database", "authz", "marketplace-connectors"])
    if (await realpath(resolve(candidate, "apps/api/node_modules/@yummyai", name)) !== await realpath(resolve(candidate, "packages", name))) throw new Error("store_node_original179_workspace_escaped");
  const contract = JSON.parse(await readFile(resolve(candidate, "packages/contracts/package.json"), "utf8")) as { exports: Record<string, unknown> };
  if (contract.exports["./marketplace/store-node-execution"]) throw new Error("store_node_new_export_reachable_from_original179");
  const journal = JSON.parse(await readFile(resolve(candidate, "packages/database/migrations/meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  if (journal.entries.length !== 179 || !journal.entries.at(-1)?.tag.startsWith("0179_")) throw new Error("store_node_original179_journal_changed");
}

/** No current runtime imports: preflight the sealed source before using its original migration reader and SQL. */
export async function migrateStoreNodeExecutionLegacyDatabase(database: DatabaseConnection, name: string, env: NodeJS.ProcessEnv) {
  const target = requireStoreNodeExecutionEnvironment(env, "pre-0180"); if (name !== target.name) throw new Error("store_node_original179_database_mismatch");
  await assertStoreNodeExecutionOriginal179Graph(env.E2E_STORE_NODE_EXECUTION_LEGACY_SOURCE!);
  const [actual] = await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== name || actual.ledger !== null || actual.populated !== false) throw new Error("store_node_original179_database_not_empty");
  const original = createRequire(pathToFileURL(resolve(legacyRoot, "packages/database/package.json")));
  const { readMigrationFiles } = original("drizzle-orm/migrator") as { readMigrationFiles(input: { migrationsFolder: string }): Array<{ sql: string[]; hash: string; folderMillis: number }> };
  const migrations = readMigrationFiles({ migrationsFolder: resolve(legacyRoot, "packages/database/migrations") }); if (migrations.length !== 179) throw new Error("store_node_original179_migrations_changed");
  await database.client.begin(async tx => { await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    await tx.unsafe("create schema drizzle"); await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) { for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at)values($1,$2)", [migration.hash, migration.folderMillis]); } });
}
