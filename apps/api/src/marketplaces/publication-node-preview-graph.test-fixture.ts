import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "@yummyai/database";
import { requirePublicationNodePreviewEnvironment } from "../../../../tools/testing/publication-node-preview-environment.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const legacyRoot = resolve(root, "tmp/publication-node-preview-20261022-a6f4c2d9/old181-source");
const checkpoint = resolve(root, "docs/project-control/checkpoints/2026-10-22-publication-node-preview-a6f4c2d9");
/** Pure filesystem preflight. Loads no current contracts, database or services at runtime. */
export async function assertPublicationNodePreviewOriginal181Graph(candidate: string) {
  if (resolve(candidate) !== legacyRoot) throw new Error("publication_node_preview_original181_root_invalid");
  const source = JSON.parse(await readFile(checkpoint + "-source-before.json", "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
  const graph = JSON.parse(await readFile(checkpoint + "-old181-source.json", "utf8")) as { operation: string; sourceRoot: string; sourceFiles: number; sourceSha256: string;
    workspaceDependenciesPinned: boolean; links: Array<{ path: string; target: string }> };
  if (graph.operation !== "a6f4c2d9" || graph.sourceFiles !== 3599 || source.files.length !== 3599 || graph.links.length !== 400 || !graph.workspaceDependenciesPinned ||
    resolve(graph.sourceRoot) !== legacyRoot || source.sha256 !== "acc1e6a3b0d908ec31e0e9adf85d6254bece36c89df6986e98af573529f6a012" || graph.sourceSha256 !== source.sha256)
    throw new Error("publication_node_preview_original181_manifest_invalid");
  for (const file of source.files) { const path = resolve(candidate, file.path), rel = relative(candidate, path);
    if (rel.startsWith("..") || isAbsolute(rel) || createHash("sha256").update(await readFile(path)).digest("hex") !== file.sha256) throw new Error("publication_node_preview_original181_bytes_changed"); }
  for (const link of graph.links) if (await realpath(link.path) !== await realpath(link.target)) throw new Error("publication_node_preview_original181_dependency_changed");
  for (const name of ["contracts", "database", "authz", "marketplace-connectors"])
    if (await realpath(resolve(candidate, "apps/api/node_modules/@yummyai", name)) !== await realpath(resolve(candidate, "packages", name))) throw new Error("publication_node_preview_original181_workspace_escaped");
  const contract = JSON.parse(await readFile(resolve(candidate, "packages/contracts/package.json"), "utf8")) as { exports: Record<string, unknown> };
  if (contract.exports["./marketplace/publication-preview"]) throw new Error("publication_node_preview_new_export_reachable_from_original181");
  const journal = JSON.parse(await readFile(resolve(candidate, "packages/database/migrations/meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  if (journal.entries.length !== 181 || !journal.entries.at(-1)?.tag.startsWith("0181_")) throw new Error("publication_node_preview_original181_journal_changed");
}

/** No current runtime imports: preflight the sealed source before using its original migration reader and SQL. */
export async function migratePublicationNodePreviewLegacyDatabase(database: DatabaseConnection, name: string, env: NodeJS.ProcessEnv) {
  const target = requirePublicationNodePreviewEnvironment(env, "pre-0182"); if (name !== target.name) throw new Error("publication_node_preview_original181_database_mismatch");
  await assertPublicationNodePreviewOriginal181Graph(env.E2E_PUBLICATION_NODE_PREVIEW_LEGACY_SOURCE!);
  const [actual] = await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== name || actual.ledger !== null || actual.populated !== false) throw new Error("publication_node_preview_original181_database_not_empty");
  const original = createRequire(pathToFileURL(resolve(legacyRoot, "packages/database/package.json")));
  const { readMigrationFiles } = original("drizzle-orm/migrator") as { readMigrationFiles(input: { migrationsFolder: string }): Array<{ sql: string[]; hash: string; folderMillis: number }> };
  const migrations = readMigrationFiles({ migrationsFolder: resolve(legacyRoot, "packages/database/migrations") }); if (migrations.length !== 181) throw new Error("publication_node_preview_original181_migrations_changed");
  await database.client.begin(async tx => { await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    await tx.unsafe("create schema drizzle"); await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) { for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at)values($1,$2)", [migration.hash, migration.folderMillis]); } });
}
