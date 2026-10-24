import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "../../packages/database/src/client.js";
import type * as OriginalDatabase from "../../packages/database/src/index.js";
import type * as OriginalContracts from "../../packages/contracts/src/index.js";
import type * as OriginalCommands from "../../packages/contracts/src/ai/agent-command.js";
import type * as OriginalInvoice from "../../apps/api/src/procurement/invoice-command.fixtures.js";
import type * as OriginalOwners from "../../apps/api/src/ai/agent-command.test-fixture.js";
import type * as OriginalCore from "../../packages/ai-core/src/index.js";
import { requireAgentDependencyPlanEnvironment } from "./require-agent-dependency-plan-environment.mjs";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-23-agent-dependency-plan-3f7c2a91");
const expectedRoot = resolve(workspace, "tmp/agent-dependency-plan-20261023-3f7c2a91/old183-source");
const originalSha256 = "114ffb3661087dfcfee859550115d135653178971a18a82c7234214eb6a5a81e";
const originalFiles = 3751, originalLinks = 389;
const runtimeRelative = ".artifacts/runtime-tools/imagemagick-7.1.2-34-q16-hdri-x64";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const samePath = (left: string, right: string) => process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
const within = (root: string, path: string) => { const name = relative(root, path); return name !== "" && !isAbsolute(name) && name !== ".." && !name.startsWith("..\\") && !name.startsWith("../"); };
type SourceRecord = { algorithm: string; sha256: string; files: Array<{ path: string; sha256: string }> };
type GraphRecord = {
  operation: string; status: string; schema: number; sourceRoot: string; sourceSha256: string; sourceFiles: number;
  workspaceDependenciesPinned: boolean; allSourceBytesVerified: boolean; dependencyLockSha256: string;
  links: Array<{ path: string; target: string; resolvedTarget: string; kind: "workspace" | "external" | "runtime" }>;
  metadata: Array<{ path: string; sha256: string }>;
  nativeRuntime: Array<{ path: string; bytes: number; sha256: string }>;
};

/** All flags and exact nonce resources are checked before a connection or old business import. */
export function requireAgentDependencyPlanLegacyEnvironment(environment: NodeJS.ProcessEnv, target: "pre-0184" | "current") {
  const isolated = requireAgentDependencyPlanEnvironment(environment, target), root = environment.E2E_AGENT_DEPENDENCY_PLAN_LEGACY_SOURCE;
  if (!root || !isAbsolute(root) || !samePath(root, expectedRoot)) throw new Error("dependency_legacy_source_required");
  return { ...isolated, root: resolve(root) };
}

/** Verifies the copied original bytes, complete non-following graph and original public ABI. */
export async function assertAgentDependencyPlanOriginal183Graph(root: string): Promise<void> {
  if (!samePath(root, expectedRoot)) throw new Error("dependency_legacy_source_identity_invalid");
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("dependency_legacy_root_not_owned");
  const source = JSON.parse(await readFile(prefix + "-source-before.json", "utf8")) as SourceRecord;
  const graph = JSON.parse(await readFile(prefix + "-old183-source-graph.json", "utf8")) as GraphRecord;
  if (source.algorithm !== "runtime-source-v1" || source.sha256 !== originalSha256 || source.files.length !== originalFiles
    || sha(JSON.stringify(source.files)) !== originalSha256 || graph.operation !== "3f7c2a91" || graph.status !== "pass" || graph.schema !== 183
    || !samePath(graph.sourceRoot, root) || graph.sourceSha256 !== originalSha256 || graph.sourceFiles !== originalFiles
    || graph.workspaceDependenciesPinned !== true || graph.allSourceBytesVerified !== true || graph.links.length !== originalLinks)
    throw new Error("dependency_legacy_source_manifest_invalid");
  const files = new Set<string>();
  for (const entry of source.files) {
    const absolute = resolve(root, entry.path);
    if (!within(root, absolute) || entry.path.includes("\\") || !/^[a-f0-9]{64}$/.test(entry.sha256) || files.has(absolute.toLowerCase()))
      throw new Error("dependency_legacy_source_path_invalid");
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || !samePath(await realpath(absolute), absolute) || sha(await readFile(absolute)) !== entry.sha256)
      throw new Error("dependency_legacy_source_bytes_changed");
    files.add(absolute.toLowerCase());
  }
  if (sha(await readFile(resolve(root, "pnpm-lock.yaml"))) !== graph.dependencyLockSha256) throw new Error("dependency_legacy_lock_changed");
  for (const entry of graph.metadata) {
    if (!within(root, entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("dependency_legacy_metadata_invalid");
    const stat = await lstat(entry.path);
    if (!stat.isFile() || stat.isSymbolicLink() || !samePath(await realpath(entry.path), entry.path) || sha(await readFile(entry.path)) !== entry.sha256)
      throw new Error("dependency_legacy_metadata_changed");
    files.add(resolve(entry.path).toLowerCase());
  }
  const links = new Set<string>();
  for (const entry of graph.links) {
    if (!within(root, entry.path) || links.has(resolve(entry.path).toLowerCase()) || !["workspace", "external", "runtime"].includes(entry.kind))
      throw new Error("dependency_legacy_dependency_path_invalid");
    if (!(await lstat(entry.path)).isSymbolicLink() || !samePath(await realpath(entry.path), entry.resolvedTarget)
      || !samePath(await realpath(entry.target), entry.resolvedTarget)) throw new Error("dependency_legacy_dependency_changed");
    if (entry.kind === "workspace" && !within(root, entry.target) || entry.kind !== "workspace" && within(root, entry.target))
      throw new Error("dependency_legacy_dependency_escaped");
    links.add(resolve(entry.path).toLowerCase());
  }
  // Never traverse a dependency junction. Reject additions that could shadow the recorded original graph.
  const observedLinks = new Set<string>(), pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const name of await readdir(directory)) {
      const absolute = resolve(directory, name), stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        if (!links.has(absolute.toLowerCase())) throw new Error("dependency_legacy_unrecorded_link");
        observedLinks.add(absolute.toLowerCase());
      } else if (stat.isDirectory()) pending.push(absolute);
      else if (!stat.isFile() || !files.has(absolute.toLowerCase())) throw new Error("dependency_legacy_unrecorded_file");
    }
  }
  if (observedLinks.size !== links.size) throw new Error("dependency_legacy_dependency_missing");
  const runtime = graph.links.filter(entry => entry.kind === "runtime");
  if (runtime.length !== 1 || !samePath(runtime[0]!.path, resolve(root, runtimeRelative)) || !samePath(runtime[0]!.target, resolve(workspace, runtimeRelative))
    || graph.nativeRuntime.length !== 23) throw new Error("dependency_legacy_native_runtime_invalid");
  const nativeNames = new Set<string>();
  for (const entry of graph.nativeRuntime) {
    if (!/^[A-Za-z0-9_.-]+$/.test(entry.path) || nativeNames.has(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !/^[a-f0-9]{64}$/.test(entry.sha256))
      throw new Error("dependency_legacy_native_record_invalid");
    const content = await readFile(resolve(root, runtimeRelative, entry.path));
    if (content.byteLength !== entry.bytes || sha(content) !== entry.sha256) throw new Error("dependency_legacy_native_bytes_changed");
    nativeNames.add(entry.path);
  }
  const require = createRequire(pathToFileURL(resolve(root, "apps/api/package.json")));
  let reachable = false;
  try { require.resolve("@yummyai/contracts/ai/agent-dependency-plan"); reachable = true; }
  catch (error) { if (!error || typeof error !== "object" || !("code" in error) || !["ERR_PACKAGE_PATH_NOT_EXPORTED", "MODULE_NOT_FOUND"].includes(String(error.code))) throw error; }
  if (reachable) throw new Error("dependency_legacy_new_export_reachable");
  const journal = JSON.parse(await readFile(resolve(root, "packages/database/migrations/meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  if (journal.entries.length !== 183 || journal.entries.at(-1)?.tag !== "0183_publication_node_submit") throw new Error("dependency_legacy_journal_invalid");
}

export async function migrateAgentDependencyPlanLegacyDatabase(database: DatabaseConnection, name: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const target = requireAgentDependencyPlanLegacyEnvironment(environment, "pre-0184");
  if (target.name !== name) throw new Error("dependency_legacy_database_identity_invalid");
  await assertAgentDependencyPlanOriginal183Graph(target.root);
  const [actual] = await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== name || actual.ledger !== null || actual.populated !== false) throw new Error("dependency_legacy_database_not_empty");
  const require = createRequire(pathToFileURL(resolve(target.root, "packages/database/package.json")));
  const { readMigrationFiles } = require("drizzle-orm/migrator") as { readMigrationFiles(value: { migrationsFolder: string }): Array<{ folderMillis: number; hash: string; sql: string[] }> };
  const migrations = readMigrationFiles({ migrationsFolder: resolve(target.root, "packages/database/migrations") });
  if (migrations.length !== 183) throw new Error("dependency_legacy_migration_prefix_invalid");
  await database.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    await tx.unsafe("create schema drizzle");
    await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) {
      for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]);
    }
  });
}

const diagnosticPhases = new Set(["environment", "ipc", "graph", "imports", "schema", "identity", "basis", "pending", "succeeded", "reader_wait", "reader_get", "cleanup", "send", "unhandled"]);
const diagnosticNames = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AggregateError", "ZodError", "PostgresError", "DatabaseError", "ConflictException", "ForbiddenError", "ForbiddenException", "NotFoundException", "BadRequestException"]);
function diagnostic(error: unknown, phase: string) {
  let code: string | null = null, cause = error;
  for (let depth = 0; depth < 6 && cause && typeof cause === "object"; depth++) {
    if ("code" in cause && typeof cause.code === "string" && /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(cause.code)) code ??= cause.code;
    cause = "cause" in cause ? cause.cause : null;
  }
  return { type: "agent.dependency.failed183", phase: diagnosticPhases.has(phase) ? phase : "unhandled", code,
    errorName: error instanceof Error && diagnosticNames.has(error.name) ? error.name : "Error" };
}
function sharedContentKey(): string {
  const text = process.env.E2E_AGENT_DEPENDENCY_PLAN_CONTENT_KEY;
  if (!text || !/^[A-Za-z0-9_-]{43}$/.test(text)) throw new Error("dependency_legacy_content_key_invalid");
  const bytes = Buffer.from(text, "base64url");
  try { if (bytes.byteLength !== 32 || bytes.toString("base64url") !== text) throw new Error("dependency_legacy_content_key_invalid"); }
  finally { bytes.fill(0); }
  return text;
}
function send(value: object): Promise<void> {
  return new Promise((done, reject) => {
    if (!process.connected || !process.send) { reject(new Error("dependency_legacy_ipc_closed")); return; }
    process.send(value, error => error ? reject(error) : done());
  });
}
type ReadRequest = { type: "agent.dependency.read183.request"; context: unknown; pendingInput: unknown; succeededInput: unknown; pendingId: string; succeededId: string };
function receive(): { result: Promise<ReadRequest>; cancel: () => void } {
  let cancel = () => {};
  const result = new Promise<ReadRequest>((done, reject) => {
    const clear = () => { clearTimeout(timer); process.off("message", received); process.off("disconnect", disconnected); };
    cancel = clear;
    const disconnected = () => { clear(); reject(new Error("dependency_legacy_ipc_closed")); };
    const received = (raw: unknown) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) { clear(); reject(new Error("dependency_legacy_read_input_invalid")); return; }
      const value = raw as Record<string, unknown>, keys = ["type", "context", "pendingInput", "succeededInput", "pendingId", "succeededId"];
      if (Object.keys(value).length !== keys.length || !keys.every(key => key in value) || value.type !== "agent.dependency.read183.request"
        || typeof value.pendingId !== "string" || typeof value.succeededId !== "string" || Buffer.byteLength(JSON.stringify(value)) > 262_144) {
        clear(); reject(new Error("dependency_legacy_read_input_invalid")); return;
      }
      clear(); done(value as ReadRequest);
    };
    const timer = setTimeout(() => { clear(); reject(new Error("dependency_legacy_read_deadline")); }, 30_000);
    process.once("message", received); process.once("disconnect", disconnected);
  });
  void result.catch(() => {});
  return { result, cancel: () => cancel() };
}

/** Entrypoint imports every business module from the genuine immutable old tree. */
async function original183(): Promise<void> {
  let phase = "environment", failure: unknown, result: object | undefined;
  const cleanup: Array<() => Promise<unknown>> = [];
  try {
    const target = requireAgentDependencyPlanLegacyEnvironment(process.env, "current"), mode = process.env.E2E_AGENT_DEPENDENCY_PLAN_LEGACY_CHILD;
    phase = "ipc";
    if (!process.connected || !["183", "read183"].includes(mode ?? "")) throw new Error("dependency_legacy_ipc_required");
    const oldTsconfig = resolve(target.root, "apps/api/tsconfig.json"), configuredTsconfig = process.env.TSX_TSCONFIG_PATH;
    if (configuredTsconfig ? !isAbsolute(configuredTsconfig) || !samePath(configuredTsconfig, oldTsconfig) : !samePath(process.cwd(), resolve(target.root, "apps/api")))
      throw new Error("dependency_legacy_loader_scope_invalid");
    const contentKey = sharedContentKey();
    phase = "graph"; await assertAgentDependencyPlanOriginal183Graph(target.root);
    const require = createRequire(pathToFileURL(resolve(target.root, "apps/api/package.json"))); require("reflect-metadata");
    const load = (name: string) => import(pathToFileURL(resolve(target.root, name)).href);
    phase = "imports";
    const databaseModule = await load("packages/database/src/index.ts") as typeof OriginalDatabase;
    const contracts = await load("packages/contracts/src/index.ts") as typeof OriginalContracts;
    const commandsContract = await load("packages/contracts/src/ai/agent-command.ts") as typeof OriginalCommands;
    const fixtures = await load("apps/api/src/procurement/invoice-command.fixtures.ts") as typeof OriginalInvoice;
    const ownersModule = await load("apps/api/src/ai/agent-command.test-fixture.ts") as typeof OriginalOwners;
    const core = await load("packages/ai-core/src/index.ts") as typeof OriginalCore;
    const database = databaseModule.connectDatabase(target.url); cleanup.unshift(() => database.client.end());
    phase = "schema";
    const evidence = await databaseModule.readMigrationEvidence(database);
    if (evidence.canonicalRows.length !== 183 || evidence.actualRows.length !== (mode === "183" ? 183 : 184)
      || evidence.canonicalRows.some((row, index) => row.hash !== evidence.actualRows[index]?.hash || row.created_at !== evidence.actualRows[index]?.created_at))
      throw new Error("dependency_legacy_actual_prefix_invalid");
    if (mode === "183") await databaseModule.assertDatabaseMigrationsCurrent(database);
    const vault = core.createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist", { NODE_ENV: "production", MODEL_CREDENTIAL_ENCRYPTION_KEY: contentKey });
    const owners = ownersModule.agentCommandOwners(database, { contentVault: vault }), commands = owners.service();
    const receipt = (input: ReturnType<typeof commandsContract.PrepareAgentCommandSchema.parse>) => ({ requestId: input.requestId,
      requestChecksum: sha(commandsContract.canonicalAgentCommandRequest("prepare", input)) });
    if (mode === "183") {
      phase = "identity"; const fixture = fixtures.invoiceCommandFixture(database); await fixture.initialize();
      for (const actor of [fixture.context, fixture.coworker, fixture.outsider]) await fixture.setPermissions(actor, ownersModule.commandPermissions);
      const context = contracts.TenantContextSchema.parse({ ...fixture.context, permissions: ownersModule.commandPermissions });
      phase = "basis"; const first = await fixture.basis(), second = await fixture.basis();
      const input = (orderId: string) => commandsContract.PrepareAgentCommandSchema.parse({ version: commandsContract.AGENT_COMMAND_VERSION,
        requestId: randomUUID(), original: { domain: "procurement", command: fixture.original(orderId) } });
      const pendingInput = input(first.order.id), succeededInput = input(second.order.id);
      phase = "pending"; const pending = await commands.prepare(context, pendingInput);
      if (pending.state !== "prepared" || pending.snapshot?.native.domain !== "procurement" || pending.kind !== "invoice_record" || !pending.ownerCommandId)
        throw new Error("dependency_legacy_pending_not_original");
      phase = "succeeded"; const prepared = await commands.prepare(context, succeededInput);
      const confirmation = commandsContract.ConfirmAgentCommandSchema.parse({ version: commandsContract.AGENT_COMMAND_VERSION,
        requestId: prepared.requestId, ownerCommandId: prepared.ownerCommandId, originalChecksum: prepared.originalChecksum,
        confirmationToken: prepared.confirmationToken, decision: "execute_original" });
      const succeeded = await commands.confirm(context, prepared.id, confirmation);
      if (succeeded.state !== "succeeded" || succeeded.snapshot?.native.domain !== "procurement" || !succeeded.snapshot.native.view.invoiceResult
        || succeeded.snapshot.native.view.result?.id !== succeeded.snapshot.native.view.invoiceResult.id)
        throw new Error("dependency_legacy_success_not_original_invoice");
      result = { type: "agent.dependency.seeded183", context, pendingInput, succeededInput, pending, succeeded,
        pendingReceipt: await commands.receipt(context, receipt(pendingInput)), succeededReceipt: await commands.receipt(context, receipt(succeededInput)),
        modelCalls: 0, workerProcesses: 0, resourcesClosed: true };
    } else {
      phase = "reader_wait";
      const waiting = receive(); let raw: ReadRequest;
      try { await send({ type: "agent.dependency.reader183.ready" }); raw = await waiting.result; }
      finally { waiting.cancel(); }
      const context = contracts.TenantContextSchema.parse(raw.context), pendingInput = commandsContract.PrepareAgentCommandSchema.parse(raw.pendingInput),
        succeededInput = commandsContract.PrepareAgentCommandSchema.parse(raw.succeededInput);
      const pendingId = contracts.EntityIdSchema.parse(raw.pendingId), succeededId = contracts.EntityIdSchema.parse(raw.succeededId);
      if ([pendingInput, succeededInput].some(input => input.original.domain !== "procurement" || input.original.command.kind !== "invoice_record"))
        throw new Error("dependency_legacy_read_input_invalid");
      phase = "reader_get"; const pending = await commands.get(context, pendingId), succeeded = await commands.get(context, succeededId);
      const pendingReceipt = await commands.receipt(context, receipt(pendingInput)), succeededReceipt = await commands.receipt(context, receipt(succeededInput));
      if (pending.requestId !== pendingInput.requestId || succeeded.requestId !== succeededInput.requestId || pending.requestChecksum !== pendingReceipt.requestChecksum
        || succeeded.requestChecksum !== succeededReceipt.requestChecksum || pendingReceipt.id !== pending.id || succeededReceipt.id !== succeeded.id)
        throw new Error("dependency_legacy_read_original_mismatch");
      result = { type: "agent.dependency.read183", context, pendingInput, succeededInput, pending, succeeded, pendingReceipt, succeededReceipt,
        modelCalls: 0, workerProcesses: 0, resourcesClosed: true };
    }
  } catch (error) { failure = error; await send(diagnostic(error, phase)).catch(() => {}); }
  let cleanupFailed = false;
  for (const close of cleanup) try { await close(); } catch (error) {
    cleanupFailed = true; await send(diagnostic(error, "cleanup")).catch(() => {});
  }
  if (failure !== undefined || cleanupFailed) throw new Error("dependency_legacy_operation_failed");
  phase = "send";
  if (!result) throw new Error("dependency_legacy_result_missing");
  try { await send(result); } catch (error) { await send(diagnostic(error, phase)).catch(() => {}); throw new Error("dependency_legacy_ipc_closed"); }
}

if (process.argv[1] && samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  try { await original183(); }
  catch { process.exitCode = 1; }
  finally { if (process.connected) process.disconnect(); }
}
