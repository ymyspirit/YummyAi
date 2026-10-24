import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, relative, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "@yummyai/database";
import { requirePublicationNodeSubmitEnvironment } from "../../../../tools/testing/publication-node-submit-environment.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url)), operation = "74c2e8b1";
export const original182Root = resolve(root, "tmp/publication-node-submit-20261023-74c2e8b1/old182-source");
const prefix = resolve(root, "docs/project-control/checkpoints/2026-10-23-publication-node-submit-74c2e8b1");
export const original182GraphPath = resolve(root, "tmp/publication-node-submit-20261023-74c2e8b1/qa/original182-graph.json");
const originalSha = "02209c0ebd4619715807e8dd62d39153d7c41f4fb92d86e4c2f2899b5ce126bd";
const originalGraphSha = "cb66d63d7c1c3813da97210665dc645e3c1c563d6d1e2d677139ace67c1167be";
type Source = { sha256: string; files: Array<{ path: string; sha256: string }> };
type Link = { path: string; target: string; resolvedTarget: string; kind: "workspace" | "external" | "runtime" };
type Graph = { operation: string; sourceRoot: string; sourceSha256: string; sourceFiles: number; schema: number;
  workspaceDependenciesPinned: boolean; links: Link[]; metadata: Array<{ path: string; sha256: string }>;
  nativeRuntime: Array<{ path: string; bytes: number; sha256: string }>; dependencyLockSha256: string };
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex"), fold = (value: string) => resolve(value).toLowerCase();
const within = (base: string, value: string) => fold(value).startsWith(fold(base) + sep);
const exists = async (path: string) => { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };
function owned(path: string) { const actual = resolve(path); if (!within(original182Root, actual)) throw new Error("publication_submit_original182_path_escaped"); return actual; }
async function sourceBytes() {
  const source = JSON.parse(await readFile(prefix + "-source-before.json", "utf8")) as Source,
    frozen = JSON.parse(await readFile(prefix + "-original182-frozen.json", "utf8")) as { sourceDirectory: string; sourceFiles: number; sourceSha256: string; verifiedEveryByte: boolean; schema: number };
  if (source.sha256 !== originalSha || source.files.length !== 3663 || frozen.sourceFiles !== 3663 || frozen.sourceSha256 !== originalSha ||
    frozen.schema !== 182 || !frozen.verifiedEveryByte || fold(frozen.sourceDirectory) !== fold(original182Root) || (await lstat(original182Root)).isSymbolicLink())
    throw new Error("publication_submit_original182_manifest_invalid");
  for (const file of source.files) if (!/^[a-f0-9]{64}$/.test(file.sha256) || sha(await readFile(owned(resolve(original182Root, file.path)))) !== file.sha256)
    throw new Error("publication_submit_original182_source_changed");
  return source;
}
/** Explicit filesystem-only setup. It never loads API decorators, credentials, a database or a service. */
export async function materializePublicationNodeSubmitOriginal182Graph() {
  const source = await sourceBytes();
  if (sha(await readFile(resolve(original182Root, "pnpm-lock.yaml"))) !== sha(await readFile(resolve(root, "pnpm-lock.yaml"))))
    throw new Error("publication_submit_original182_dependency_lock_changed");
  if (await exists(original182GraphPath)) { await assertPublicationNodeSubmitOriginal182Graph(original182Root); return JSON.parse(await readFile(original182GraphPath, "utf8")) as Graph; }
  const packages = new Map<string, string>(), directories = new Set<string>(), links: Link[] = [], metadata: Graph["metadata"] = [];
  for (const file of source.files.filter(row => row.path === "package.json" || row.path.endsWith("/package.json"))) {
    const directory = dirname(file.path), manifest = JSON.parse(await readFile(resolve(original182Root, file.path), "utf8")) as { name?: string };
    directories.add(directory);
    if (manifest.name?.startsWith("@yummyai/")) { if (packages.has(manifest.name)) throw new Error("publication_submit_original182_duplicate_package"); packages.set(manifest.name, directory); }
  }
  async function link(path: string, target: string, kind: Link["kind"]) {
    const destination = owned(path); await mkdir(dirname(destination), { recursive: true });
    if (await exists(destination)) {
      if (!(await lstat(destination)).isSymbolicLink() || fold(await realpath(destination)) !== fold(await realpath(target))) throw new Error("publication_submit_original182_existing_link_changed");
    } else await symlink(resolve(target), destination, "junction");
    links.push({ path: destination, target: resolve(target), resolvedTarget: await realpath(target), kind });
  }
  async function dependencies(relativePath: string) {
    const from = resolve(root, relativePath), destination = owned(resolve(original182Root, relativePath));
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if ([".cache", ".vite", ".vite-temp", ".turbo", ".next"].includes(entry.name) || entry.name.endsWith(".tsbuildinfo")) continue;
      const child = join(relativePath, entry.name), actual = resolve(from, entry.name), output = resolve(original182Root, child);
      if (entry.isSymbolicLink()) {
        const physical = await realpath(actual), workspace = /(?:^|[\\/])@yummyai[\\/]([^\\/]+)$/.exec(child);
        if (workspace) {
          const directory = packages.get("@yummyai/" + workspace[1]); if (!directory) throw new Error("publication_submit_original182_unknown_workspace");
          await link(output, resolve(original182Root, directory), "workspace");
        } else if (within(root, physical) && /^(?:apps|packages)[\\/]/.test(relative(root, physical))) await link(output, resolve(original182Root, relative(root, physical)), "workspace");
        else {
          if (!within(resolve(root, "node_modules"), physical)) throw new Error("publication_submit_original182_external_dependency_escaped");
          await link(output, physical, "external");
        }
      } else if (entry.isDirectory()) {
        if (entry.name === ".pnpm" || entry.name === ".bin") await link(output, actual, "external");
        else await dependencies(child);
      } else if (entry.isFile() && ([".modules.yaml", ".package-map.json", ".pnpm-workspace-state-v1.json"].includes(entry.name)
        || child.replaceAll("\\", "/") === "node_modules/.pnpm_patches/state.json")) {
        if (!await exists(output)) await copyFile(actual, output, constants.COPYFILE_EXCL);
        if (sha(await readFile(output)) !== sha(await readFile(actual))) throw new Error("publication_submit_original182_dependency_metadata_changed");
        metadata.push({ path: owned(output), sha256: sha(await readFile(output)) });
      } else throw new Error("publication_submit_original182_unexpected_dependency_file:" + child);
    }
  }
  for (const directory of directories) {
    const path = join(directory, "node_modules"); if (await exists(resolve(root, path))) await dependencies(path);
  }
  // The original native selector resolves this locked, shared portable runtime relative to the old source root.
  const runtime = ".artifacts/runtime-tools/imagemagick-7.1.2-34-q16-hdri-x64", nativeRuntime: Graph["nativeRuntime"] = [];
  if (await exists(resolve(root, runtime))) {
    const lock = JSON.parse(await readFile(resolve(original182Root, "packages/mockup-renderer/runtime-lock.json"), "utf8")) as { files: Record<string, string> };
    if (sha(await readFile(resolve(original182Root, "packages/mockup-renderer/runtime-lock.json"))) !== sha(await readFile(resolve(root, "packages/mockup-renderer/runtime-lock.json"))))
      throw new Error("publication_submit_original182_runtime_lock_changed");
    const lockedFiles = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name); if (entry.isSymbolicLink()) throw new Error("publication_submit_original182_runtime_link_unexpected");
        if (entry.isDirectory()) await lockedFiles(path); else if (entry.isFile()) { const bytes = await readFile(path); nativeRuntime.push({ path: relative(resolve(root, runtime), path).replaceAll("\\", "/"), bytes: bytes.length, sha256: sha(bytes) }); }
      }
    };
    await lockedFiles(resolve(root, runtime));
    if (nativeRuntime.length !== Object.keys(lock.files).length || nativeRuntime.some(entry => lock.files[entry.path] !== entry.sha256))
      throw new Error("publication_submit_original182_runtime_bytes_differ_from_lock");
    await link(resolve(original182Root, runtime), resolve(root, runtime), "runtime");
  }
  await sourceBytes();
  const graph: Graph = { operation, sourceRoot: original182Root, sourceSha256: originalSha, sourceFiles: 3663, schema: 182,
    workspaceDependenciesPinned: true, links, metadata, nativeRuntime, dependencyLockSha256: sha(await readFile(resolve(original182Root, "pnpm-lock.yaml"))) };
  await mkdir(dirname(original182GraphPath), { recursive: true }); await writeFile(original182GraphPath, JSON.stringify(graph, null, 2) + "\n", { flag: "wx" });
  await assertPublicationNodeSubmitOriginal182Graph(original182Root); return graph;
}
/** Pure preflight; every old source and workspace resolution is verified before an old process or connection. */
export async function assertPublicationNodeSubmitOriginal182Graph(candidate: string) {
  if (fold(candidate) !== fold(original182Root)) throw new Error("publication_submit_original182_root_invalid"); await sourceBytes();
  const graphBytes = await readFile(original182GraphPath);
  if (sha(graphBytes) !== originalGraphSha) throw new Error("publication_submit_original182_graph_bytes_changed");
  const graph = JSON.parse(graphBytes.toString("utf8")) as Graph;
  if (graph.operation !== operation || graph.schema !== 182 || graph.sourceFiles !== 3663 || graph.sourceSha256 !== originalSha ||
    fold(graph.sourceRoot) !== fold(original182Root) || !graph.workspaceDependenciesPinned || graph.links.length !== 389 || graph.nativeRuntime.length !== 23 ||
    graph.dependencyLockSha256 !== sha(await readFile(resolve(original182Root, "pnpm-lock.yaml")))) throw new Error("publication_submit_original182_graph_invalid");
  for (const entry of graph.links) {
    if (!(await lstat(owned(entry.path))).isSymbolicLink() || fold(await realpath(entry.path)) !== fold(entry.resolvedTarget) || fold(await realpath(entry.target)) !== fold(entry.resolvedTarget) ||
      entry.kind === "workspace" && !within(original182Root, entry.resolvedTarget)) throw new Error("publication_submit_original182_dependency_changed");
  }
  for (const entry of graph.metadata) if (sha(await readFile(owned(entry.path))) !== entry.sha256) throw new Error("publication_submit_original182_dependency_metadata_changed");
  const runtime = resolve(root, ".artifacts/runtime-tools/imagemagick-7.1.2-34-q16-hdri-x64");
  for (const entry of graph.nativeRuntime) { const path = resolve(runtime, entry.path); if (!within(runtime, path)) throw new Error("publication_submit_original182_runtime_path_invalid");
    const bytes = await readFile(path); if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) throw new Error("publication_submit_original182_runtime_changed"); }
  for (const name of ["contracts", "database", "authz", "marketplace-connectors"]) if (fold(await realpath(resolve(candidate, "apps/api/node_modules/@yummyai", name))) !== fold(resolve(candidate, "packages", name)))
    throw new Error("publication_submit_original182_workspace_escaped");
  const contract = JSON.parse(await readFile(resolve(candidate, "packages/contracts/package.json"), "utf8")) as { exports: Record<string, unknown> };
  if (contract.exports["./marketplace/publication-submit"]) throw new Error("publication_submit_new_export_reachable_from_original182");
  const journal = JSON.parse(await readFile(resolve(candidate, "packages/database/migrations/meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  if (journal.entries.length !== 182 || !journal.entries.at(-1)?.tag.startsWith("0182_")) throw new Error("publication_submit_original182_journal_changed");
}
export async function migratePublicationNodeSubmitLegacyDatabase(database: DatabaseConnection, name: string, env: NodeJS.ProcessEnv) {
  const isolated = requirePublicationNodeSubmitEnvironment(env, "pre-0183"); if (name !== isolated.name) throw new Error("publication_submit_original182_database_mismatch");
  await assertPublicationNodeSubmitOriginal182Graph(env.E2E_PUBLICATION_NODE_SUBMIT_LEGACY_SOURCE!);
  const [actual] = await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== name || actual.ledger !== null || actual.populated !== false) throw new Error("publication_submit_original182_database_not_empty");
  const original = createRequire(pathToFileURL(resolve(original182Root, "packages/database/package.json"))),
    { readMigrationFiles } = original("drizzle-orm/migrator") as { readMigrationFiles(input: { migrationsFolder: string }): Array<{ sql: string[]; hash: string; folderMillis: number }> };
  const migrations = readMigrationFiles({ migrationsFolder: resolve(original182Root, "packages/database/migrations") }); if (migrations.length !== 182) throw new Error("publication_submit_original182_migrations_changed");
  await database.client.begin(async tx => { await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    await tx.unsafe("create schema drizzle"); await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) { for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at)values($1,$2)", [migration.hash, migration.folderMillis]); } });
}
