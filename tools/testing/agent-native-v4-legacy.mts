import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "../../packages/database/src/client.js";
import type * as OriginalDatabase from "../../packages/database/src/index.js";
import type * as OriginalContracts from "../../packages/contracts/src/index.js";
import type * as OriginalCore from "../../packages/ai-core/src/index.js";
import type * as OriginalNativeFixture from "../../apps/api/src/ai/agent-native-v3.test-fixture.js";
import type * as OriginalNativeContract from "../../packages/contracts/src/ai/agent-native-v3.js";
import type * as OriginalAgentContract from "../../packages/contracts/src/ai/agent-fulfillment-command.js";
import type * as OriginalFulfillmentContract from "../../packages/contracts/src/order/fulfillment-command.js";
import type * as OriginalOwner from "../../apps/api/src/orders/order-fulfillment-command-owner.js";
import type * as OriginalService from "../../apps/api/src/orders/order-fulfillment-command.service.js";
import type * as OriginalAgentOwner from "../../apps/api/src/ai/agent-fulfillment-command-owner.js";
import type * as OriginalAgentService from "../../apps/api/src/ai/agent-fulfillment-command.service.js";
import { requireAgentNativeV4Environment } from "./require-agent-native-v4-environment.mjs";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const expectedRoot = resolve(workspace, ".artifacts/ordinary-api-source-186-d6b2f901-r9");
const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-23-agent-fulfillment-command-d6b2f901");
const originalSha256 = "0ebbb79598cf547341d6800cc4c0b291710cc124602091c3b9f2552160c1fd1a";
const manifestSha256 = "43dc480c077a7c7bed59238f54ef0c32aace83eb290611e1113a94b1cca52c42";
const originalFiles = 3832, originalLinks = 389;
const pairedCandidateId = "7555de6bac4b4252830311b972de3295";
const pairedBuildId = "RARhEP0dfZT0cJ4tf4lyf";
const pairedArtifactSha256 = "de2dc52d0fc940d05b2a7532d0fea4fae09c2e6450ffde1294e84cb1a4962dc2";
const runtimeRelative = ".artifacts/runtime-tools/imagemagick-7.1.2-34-q16-hdri-x64";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const samePath = (left: string, right: string) => process.platform === "win32"
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
const inside = (root: string, path: string) => {
  const name = relative(root, path);
  return name !== "" && !isAbsolute(name) && name !== ".." && !name.startsWith("..\\") && !name.startsWith("../");
};
type Source = { algorithm: string; sha256: string; files: Array<{ path: string; sha256: string }> };
type Graph = {
  operation: string; status: string; schema: number; sourceRoot: string; sourceSha256: string; sourceFiles: number;
  workspaceDependenciesPinned: boolean; allSourceBytesVerified: boolean; dependencyLockSha256: string;
  links: Array<{ path: string; target: string; resolvedTarget: string; kind: "workspace" | "external" | "runtime" }>;
  metadata: Array<{ path: string; sha256: string }>; nativeRuntime: Array<{ path: string; bytes: number; sha256: string }>;
};
type PairedCandidate = {
  operation: string; status: string; sourceRoot: string; sourceSha256: string; candidate: string; buildId: string;
  copiedFiles: number; artifactFiles: number; artifactSha256: string;
  sourceSnapshotAndCompiledCandidatePaired: boolean; sourceFilesAndDependencyGraphVerified: boolean; noEnvironmentFilesCopied: boolean;
  links: Array<{ path: string; target: string; resolvedTarget: string }>;
};
type PairedWebVerifier = {
  verifyLocalWebCandidate(root: string, id: string): Promise<{
    target: string; web: string;
    manifest: { id: string; sourceSha256: string; sourceFiles: number; dependencyLockSha256: string;
      buildId: string; artifactsSha256: string; artifacts: Array<{ path: string; bytes: number; sha256: string }> };
  }>;
};

/** Validate exact disposable resources before a connection or old business import. */
export function requireAgentNativeV4LegacyEnvironment(environment: NodeJS.ProcessEnv, target: "pre-0187" | "current") {
  const isolated = requireAgentNativeV4Environment(environment, target);
  const root = environment.E2E_AGENT_NATIVE_V4_LEGACY_SOURCE;
  if (environment.E2E_AGENT_NATIVE_V4_UPGRADE_ISOLATED !== "1" || !root || !isAbsolute(root) || !samePath(root, expectedRoot))
    throw new Error("agent_native_v4_legacy_source_identity_invalid");
  return { ...isolated, root: resolve(root) };
}

/** Verify the genuine adopted186 source and its recorded dependency graph.
 * Inventory never follows links and excludes only the fully verified old candidate. */
export async function assertAgentNativeV4Original186Graph(root: string): Promise<void> {
  if (!samePath(root, expectedRoot)) throw new Error("agent_native_v4_legacy_source_identity_invalid");
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !samePath(await realpath(root), root))
    throw new Error("agent_native_v4_legacy_root_invalid");
  const sourceBytes = await readFile(prefix + "-source-final-r9.json");
  const source = JSON.parse(sourceBytes.toString("utf8")) as Source;
  const graph = JSON.parse(await readFile(prefix + "-source-graph-r9.json", "utf8")) as Graph;
  if (sha(sourceBytes) !== manifestSha256 || source.algorithm !== "runtime-source-v1" || source.sha256 !== originalSha256 ||
    sha(JSON.stringify(source.files)) !== originalSha256 || source.files.length !== originalFiles ||
    graph.operation !== "d6b2f901" || graph.status !== "pass" || graph.schema !== 186 || !samePath(graph.sourceRoot, root) ||
    graph.sourceSha256 !== originalSha256 || graph.sourceFiles !== originalFiles || graph.workspaceDependenciesPinned !== true ||
    graph.allSourceBytesVerified !== true || graph.links.length !== originalLinks)
    throw new Error("agent_native_v4_legacy_manifest_invalid");
  const files = new Set<string>();
  for (const entry of source.files) {
    const path = resolve(root, entry.path);
    if (!inside(root, path) || entry.path.includes("\\") || files.has(path.toLowerCase()) || !/^[a-f0-9]{64}$/.test(entry.sha256))
      throw new Error("agent_native_v4_legacy_source_path_invalid");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !samePath(await realpath(path), path) || sha(await readFile(path)) !== entry.sha256)
      throw new Error("agent_native_v4_legacy_source_bytes_changed");
    files.add(path.toLowerCase());
  }
  if (sha(await readFile(resolve(root, "pnpm-lock.yaml"))) !== graph.dependencyLockSha256)
    throw new Error("agent_native_v4_legacy_lock_changed");
  for (const entry of graph.metadata) {
    if (!inside(root, entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || files.has(resolve(entry.path).toLowerCase()))
      throw new Error("agent_native_v4_legacy_metadata_invalid");
    const stat = await lstat(entry.path);
    if (!stat.isFile() || stat.isSymbolicLink() || !samePath(await realpath(entry.path), entry.path) || sha(await readFile(entry.path)) !== entry.sha256)
      throw new Error("agent_native_v4_legacy_metadata_changed");
    files.add(resolve(entry.path).toLowerCase());
  }
  const links = new Set<string>();
  for (const entry of graph.links) {
    if (!inside(root, entry.path) || links.has(resolve(entry.path).toLowerCase()) || !["workspace", "external", "runtime"].includes(entry.kind))
      throw new Error("agent_native_v4_legacy_link_invalid");
    if (!(await lstat(entry.path)).isSymbolicLink() || !samePath(await realpath(entry.path), entry.resolvedTarget) ||
      !samePath(await realpath(entry.target), entry.resolvedTarget)) throw new Error("agent_native_v4_legacy_link_changed");
    if (entry.kind === "workspace" ? !inside(root, entry.target) : inside(root, entry.target))
      throw new Error("agent_native_v4_legacy_link_escaped");
    links.add(resolve(entry.path).toLowerCase());
  }
  const paired = JSON.parse(await readFile(prefix + "-paired-candidate-r9.json", "utf8")) as PairedCandidate;
  const candidateRoot = resolve(root, ".artifacts/local-web-releases", pairedCandidateId);
  if (paired.operation !== "d6b2f901" || paired.status !== "pass" || !samePath(paired.sourceRoot, root) || paired.sourceSha256 !== originalSha256 ||
    paired.candidate !== pairedCandidateId || paired.buildId !== pairedBuildId || paired.artifactSha256 !== pairedArtifactSha256 ||
    paired.copiedFiles !== 2076 || paired.artifactFiles !== 2068 || paired.links.length !== 3 || paired.noEnvironmentFilesCopied !== true ||
    paired.sourceSnapshotAndCompiledCandidatePaired !== true || paired.sourceFilesAndDependencyGraphVerified !== true)
    throw new Error("agent_native_v4_legacy_paired_candidate_invalid");
  const candidateStat = await lstat(candidateRoot);
  if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink() || !samePath(await realpath(candidateRoot), candidateRoot))
    throw new Error("agent_native_v4_legacy_paired_candidate_root_invalid");
  const candidateLinks = new Set<string>();
  for (const entry of paired.links) {
    const suffix = ["node_modules", "packages", "apps/web/node_modules"].find(name => samePath(entry.path, resolve(candidateRoot, name)));
    if (!suffix || candidateLinks.has(suffix) || !samePath(entry.target, resolve(root, suffix)) || !inside(root, entry.target) ||
      !(await lstat(entry.path)).isSymbolicLink() || !samePath(await realpath(entry.path), entry.resolvedTarget) ||
      !samePath(await realpath(entry.target), entry.resolvedTarget)) throw new Error("agent_native_v4_legacy_paired_candidate_link_changed");
    candidateLinks.add(suffix);
  }
  const { verifyLocalWebCandidate } = await import(pathToFileURL(resolve(root, "tools/scripts/local-web-candidate.mjs")).href) as PairedWebVerifier;
  const candidate = await verifyLocalWebCandidate(root, pairedCandidateId);
  if (!samePath(candidate.target, candidateRoot) || candidate.manifest.id !== pairedCandidateId || candidate.manifest.sourceSha256 !== originalSha256 ||
    candidate.manifest.sourceFiles !== originalFiles || candidate.manifest.dependencyLockSha256 !== graph.dependencyLockSha256 ||
    candidate.manifest.buildId !== pairedBuildId || candidate.manifest.artifactsSha256 !== pairedArtifactSha256 ||
    candidate.manifest.artifacts.length !== paired.artifactFiles) throw new Error("agent_native_v4_legacy_paired_candidate_changed");
  const observedLinks = new Set<string>(), pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const name of await readdir(directory)) {
      const path = resolve(directory, name), stat = await lstat(path);
      if (samePath(path, candidateRoot)) {
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("agent_native_v4_legacy_paired_candidate_root_invalid");
        continue;
      }
      if (stat.isSymbolicLink()) {
        if (!links.has(path.toLowerCase())) throw new Error("agent_native_v4_legacy_unrecorded_link");
        observedLinks.add(path.toLowerCase());
      } else if (stat.isDirectory()) pending.push(path);
      else if (!stat.isFile() || !files.has(path.toLowerCase())) throw new Error("agent_native_v4_legacy_unrecorded_file");
    }
  }
  if (observedLinks.size !== links.size) throw new Error("agent_native_v4_legacy_link_missing");
  const runtime = graph.links.filter(entry => entry.kind === "runtime");
  if (runtime.length !== 1 || !samePath(runtime[0]!.path, resolve(root, runtimeRelative)) ||
    !samePath(runtime[0]!.target, resolve(workspace, runtimeRelative)) || graph.nativeRuntime.length !== 23)
    throw new Error("agent_native_v4_legacy_runtime_invalid");
  const names = new Set<string>();
  for (const entry of graph.nativeRuntime) {
    if (!/^[A-Za-z0-9_.-]+$/.test(entry.path) || names.has(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !/^[a-f0-9]{64}$/.test(entry.sha256))
      throw new Error("agent_native_v4_legacy_runtime_path_invalid");
    const path = resolve(root, runtimeRelative, entry.path), stat = await lstat(path), bytes = await readFile(path);
    if (!stat.isFile() || stat.isSymbolicLink() || bytes.byteLength !== entry.bytes || sha(bytes) !== entry.sha256)
      throw new Error("agent_native_v4_legacy_runtime_changed");
    names.add(entry.path);
  }
  const require = createRequire(pathToFileURL(resolve(root, "apps/api/package.json")));
  let reachable = false;
  try { require.resolve("@yummyai/contracts/ai/agent-native-v4"); reachable = true; }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || !["ERR_PACKAGE_PATH_NOT_EXPORTED", "MODULE_NOT_FOUND"].includes(String(error.code))) throw error;
  }
  if (reachable) throw new Error("agent_native_v4_legacy_new_export_reachable");
  const journal = JSON.parse(await readFile(resolve(root, "packages/database/migrations/meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  if (journal.entries.length !== 186 || journal.entries.at(-1)?.tag !== "0186_agent_fulfillment_command")
    throw new Error("agent_native_v4_legacy_journal_invalid");
}

/** Apply exactly the 186 migrations read from the verified old source graph. */
export async function migrateAgentNativeV4LegacyDatabase(database: DatabaseConnection, name: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const target = requireAgentNativeV4LegacyEnvironment(environment, "pre-0187");
  if (target.name !== name) throw new Error("agent_native_v4_legacy_database_identity_invalid");
  await assertAgentNativeV4Original186Graph(target.root);
  const empty = "select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated";
  const [actual] = await database.client.unsafe(empty);
  if (actual?.name !== name || actual.ledger !== null || actual.populated !== false) throw new Error("agent_native_v4_legacy_database_not_empty");
  const require = createRequire(pathToFileURL(resolve(target.root, "packages/database/package.json")));
  const { readMigrationFiles } = require("drizzle-orm/migrator") as {
    readMigrationFiles(options: { migrationsFolder: string }): Array<{ folderMillis: number; hash: string; sql: string[] }>;
  };
  const migrations = readMigrationFiles({ migrationsFolder: resolve(target.root, "packages/database/migrations") });
  if (migrations.length !== 186) throw new Error("agent_native_v4_legacy_prefix_invalid");
  await database.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    const [locked] = await tx.unsafe(empty);
    if (locked?.name !== name || locked.ledger !== null || locked.populated !== false) throw new Error("agent_native_v4_legacy_database_not_empty");
    await tx.unsafe("create schema drizzle");
    await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) {
      for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]);
    }
  });
}

type AgentView = OriginalAgentContract.AgentFulfillmentCommandView;
type NativeView = OriginalNativeContract.AgentNativeV3View;
type NativeReceipt = OriginalNativeContract.AgentNativeV3Receipt;
type NativeItemReceipt = OriginalNativeContract.AgentNativeV3ItemReceipt;
type NativePrepareLookup = { version: "erp-agent-native-v3"; requestId: string; proposalChecksum: string };
type PendingSources = { orderId: string; productionId: string; packageId: string; shipmentId: string; versionId: string };
type SucceededSources = { orderId: string; productionId: string; packageId: string };

/** A comparison projection, deliberately not an executable Agent DTO. */
export type AgentNativeV4LegacyFulfillmentStable = Omit<AgentView, "confirmationToken" | "confirmationExpiresAt">;
export function projectAgentNativeV4LegacyFulfillment(view: AgentView): {
  stable: AgentNativeV4LegacyFulfillmentStable;
  confirmation: { canConfirm: boolean; hasToken: boolean; decision: AgentView["confirmationDecision"] };
} {
  const stable: AgentNativeV4LegacyFulfillmentStable = { version: view.version, contextAuthority: view.contextAuthority,
    native: view.native, original: view.original, privateAvailable: view.privateAvailable, originalChecksum: view.originalChecksum,
    confirmationDecision: view.confirmationDecision, canConfirm: view.canConfirm, canCancel: view.canCancel, canAcknowledge: view.canAcknowledge };
  return { stable, confirmation: { canConfirm: view.canConfirm, hasToken: view.confirmationToken !== null, decision: view.confirmationDecision } };
}

/** The original V3 transports contain neither confirmation tokens nor execution
 * leases. Preserve their complete stable wire rather than translating it to V4. */
export function projectAgentNativeV4LegacyV3(view: NativeView, receipt: NativeReceipt, itemReceipt: NativeItemReceipt,
  prepareReplay: NativeItemReceipt) {
  return { view, receipt, itemReceipt, prepareReplay };
}

export type AgentNativeV4LegacyV3Reference = {
  input: OriginalNativeContract.CreateAgentNativeV3;
  runId: string; itemId: string; prepareLookup: NativePrepareLookup;
};
export type AgentNativeV4LegacyFulfillmentReference<Sources> = {
  id: string; input: OriginalAgentContract.PrepareAgentFulfillmentCommand; sourceIds: Sources;
};
export type AgentNativeV4LegacyReferences = {
  context: OriginalContracts.TenantContext;
  nativeV3: { stopped: AgentNativeV4LegacyV3Reference; expired: AgentNativeV4LegacyV3Reference };
  fulfillment: {
    pending: AgentNativeV4LegacyFulfillmentReference<PendingSources>;
    succeeded: AgentNativeV4LegacyFulfillmentReference<SucceededSources>;
  };
};
export type AgentNativeV4LegacySnapshot = {
  references: AgentNativeV4LegacyReferences;
  nativeV3: {
    stopped: ReturnType<typeof projectAgentNativeV4LegacyV3>;
    expired: ReturnType<typeof projectAgentNativeV4LegacyV3>;
  };
  fulfillment: {
    pending: ReturnType<typeof projectAgentNativeV4LegacyFulfillment> & { receipt: OriginalAgentContract.AgentFulfillmentCommandReceipt };
    succeeded: ReturnType<typeof projectAgentNativeV4LegacyFulfillment> & { receipt: OriginalAgentContract.AgentFulfillmentCommandReceipt };
  };
  counts: { syntheticModelCalls: number; workerProcesses: 0; paidProviderCalls: 0 };
  resourcesClosed: true;
};
export type AgentNativeV4LegacySeedPacket = AgentNativeV4LegacySnapshot & { type: "agent.native_v4.seeded186" };
export type AgentNativeV4LegacyReadPacket = AgentNativeV4LegacySnapshot & { type: "agent.native_v4.read186" };
export type AgentNativeV4LegacyReadRequest = { type: "agent.native_v4.read186.request"; references: AgentNativeV4LegacyReferences };

const phases = new Set(["environment", "ipc", "graph", "imports", "schema", "identity", "basis", "pending", "succeeded",
  "native_stopped", "native_expiring", "native_expiry_wait", "reader_wait", "reader_get", "reader_replay", "cleanup", "send"]);
const errorNames = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AggregateError", "ZodError", "PostgresError", "DatabaseError",
  "ConflictException", "ForbiddenError", "ForbiddenException", "NotFoundException", "BadRequestException"]);
function diagnostic(error: unknown, phase: string) {
  let code: string | null = null, cause = error;
  for (let depth = 0; depth < 6 && cause && typeof cause === "object"; depth++) {
    if ("code" in cause && typeof cause.code === "string" && /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(cause.code)) code ??= cause.code;
    cause = "cause" in cause ? cause.cause : null;
  }
  return { type: "agent.native_v4.failed186", phase: phases.has(phase) ? phase : "environment", code,
    errorName: error instanceof Error && errorNames.has(error.name) ? error.name : "Error" };
}
function send(value: object): Promise<void> {
  return new Promise((done, reject) => {
    if (!process.connected || !process.send) { reject(new Error("agent_native_v4_legacy_ipc_closed")); return; }
    process.send(value, error => error ? reject(error) : done());
  });
}
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length ||
    fields.some(field => !Object.hasOwn(value, field))) throw new Error("agent_native_v4_legacy_read_input_invalid");
  return value as Record<string, unknown>;
}
function receive() {
  let cancel = () => {};
  const result = new Promise<AgentNativeV4LegacyReadRequest>((done, reject) => {
    const clear = () => { clearTimeout(timer); process.off("message", received); process.off("disconnect", disconnected); };
    cancel = clear;
    const disconnected = () => { clear(); reject(new Error("agent_native_v4_legacy_ipc_closed")); };
    const received = (raw: unknown) => {
      try {
        const value = record(raw, ["type", "references"]);
        if (value.type !== "agent.native_v4.read186.request" || Buffer.byteLength(JSON.stringify(value)) > 2_097_152)
          throw new Error("agent_native_v4_legacy_read_input_invalid");
        clear(); done(value as AgentNativeV4LegacyReadRequest);
      } catch (error) { clear(); reject(error); }
    };
    const timer = setTimeout(() => { clear(); reject(new Error("agent_native_v4_legacy_read_deadline")); }, 30_000);
    process.once("message", received); process.once("disconnect", disconnected);
  });
  void result.catch(() => {});
  return { result, cancel: () => cancel() };
}

/** Every business and schema import below resolves through the verified old186
 * tree. The only model transport is the original fixture's synthetic provider. */
async function original186(): Promise<void> {
  let phase = "environment", database: DatabaseConnection | undefined, failure: unknown;
  let outcome: AgentNativeV4LegacySeedPacket | AgentNativeV4LegacyReadPacket | undefined, contentBytes: Buffer | undefined;
  let closeNative: (() => Promise<void>) | undefined;
  try {
    const target = requireAgentNativeV4LegacyEnvironment(process.env, "current"), mode = process.env.E2E_AGENT_NATIVE_V4_LEGACY_CHILD;
    phase = "ipc";
    const configured = process.env.TSX_TSCONFIG_PATH, oldTsconfig = resolve(target.root, "apps/api/tsconfig.json");
    const loader = pathToFileURL(resolve(target.root, "apps/api/node_modules/tsx/dist/loader.mjs")).href;
    if (!process.connected || !["186", "read186"].includes(mode ?? "") || process.env.TSX_DISABLE_CACHE !== "1" ||
      !samePath(process.cwd(), resolve(target.root, "apps/api")) || !configured || !isAbsolute(configured) || !samePath(configured, oldTsconfig) ||
      Boolean(process.env.NODE_OPTIONS) || process.execArgv.length !== 2 || process.execArgv[0] !== "--import" || process.execArgv[1] !== loader)
      throw new Error("agent_native_v4_legacy_loader_invalid");
    const key = process.env.E2E_AGENT_NATIVE_V4_CONTENT_KEY ?? "";
    contentBytes = Buffer.from(key, "base64url");
    if (!/^[A-Za-z0-9_-]{43}$/.test(key) || contentBytes.byteLength !== 32 || contentBytes.toString("base64url") !== key)
      throw new Error("agent_native_v4_legacy_content_key_invalid");
    phase = "graph"; await assertAgentNativeV4Original186Graph(target.root);
    const require = createRequire(pathToFileURL(resolve(target.root, "apps/api/package.json"))); require("reflect-metadata");
    const load = (name: string) => import(pathToFileURL(resolve(target.root, name)).href);
    phase = "imports";
    const db = await load("packages/database/src/index.ts") as typeof OriginalDatabase;
    const contracts = await load("packages/contracts/src/index.ts") as typeof OriginalContracts;
    const core = await load("packages/ai-core/src/index.ts") as typeof OriginalCore;
    const nativeContract = await load("packages/contracts/src/ai/agent-native-v3.ts") as typeof OriginalNativeContract;
    const agentContract = await load("packages/contracts/src/ai/agent-fulfillment-command.ts") as typeof OriginalAgentContract;
    const fulfillmentContract = await load("packages/contracts/src/order/fulfillment-command.ts") as typeof OriginalFulfillmentContract;
    const nativeModule = await load("apps/api/src/ai/agent-native-v3.test-fixture.ts") as typeof OriginalNativeFixture;
    const ownerModule = await load("apps/api/src/orders/order-fulfillment-command-owner.ts") as typeof OriginalOwner;
    const serviceModule = await load("apps/api/src/orders/order-fulfillment-command.service.ts") as typeof OriginalService;
    const agentOwnerModule = await load("apps/api/src/ai/agent-fulfillment-command-owner.ts") as typeof OriginalAgentOwner;
    const agentServiceModule = await load("apps/api/src/ai/agent-fulfillment-command.service.ts") as typeof OriginalAgentService;
    database = db.connectDatabase(target.url);
    const connection = database;
    phase = "schema";
    const evidence = await db.readMigrationEvidence(connection);
    if (evidence.canonicalRows.length !== 186 || evidence.actualRows.length !== (mode === "186" ? 186 : 187) ||
      evidence.canonicalRows.some((row, index) => row.hash !== evidence.actualRows[index]?.hash || row.created_at !== evidence.actualRows[index]?.created_at))
      throw new Error("agent_native_v4_legacy_actual_prefix_invalid");
    if (mode === "186") await db.assertDatabaseMigrationsCurrent(connection);
    const vault = new core.SecretVault(contentBytes);
    // The original fixture initializes its own synthetic model credential with
    // base.modelVault. Preserve that pair; the shared content key is needed only
    // for original retained inputs and the separate fulfillment confirmation.
    const native = nativeModule.agentNativeV3Fixture(connection, { contentVault: vault, orderVault: vault, integrationVault: vault });
    closeNative = () => native.close();
    const owners = native.fulfillment;
    const original = new serviceModule.OrderFulfillmentCommandService(connection, vault,
      new ownerModule.OrderFulfillmentCommandOwner(connection, vault, owners.production, owners.delivery, owners.shipping), owners.audit);
    const agent = new agentServiceModule.AgentFulfillmentCommandService(connection, vault,
      new agentOwnerModule.AgentFulfillmentCommandOwner(original), owners.audit);
    const agentQuery = (orderId: string) => ({ version: agentContract.AGENT_FULFILLMENT_COMMAND_VERSION, orderId });
    const agentReceipt = (context: OriginalContracts.TenantContext, reference: AgentNativeV4LegacyFulfillmentReference<PendingSources | SucceededSources>) =>
      agent.receipt(context, { ...agentQuery(reference.input.orderId), requestId: reference.input.original.requestId,
        requestChecksum: sha(agentContract.canonicalAgentFulfillmentOriginal(reference.input.original)) });
    const readFulfillment = async <Sources extends PendingSources | SucceededSources>(context: OriginalContracts.TenantContext,
      reference: AgentNativeV4LegacyFulfillmentReference<Sources>) => {
      const view = await agent.get(context, reference.id, agentQuery(reference.input.orderId));
      if (view.native.requestId !== reference.input.original.requestId || view.native.requestChecksum !== sha(agentContract.canonicalAgentFulfillmentOriginal(reference.input.original)) ||
        !view.original || agentContract.canonicalAgentFulfillmentOriginal(view.original) !== agentContract.canonicalAgentFulfillmentOriginal(reference.input.original))
        throw new Error("agent_native_v4_legacy_fulfillment_identity_invalid");
      return { ...projectAgentNativeV4LegacyFulfillment(view), receipt: await agentReceipt(context, reference) };
    };
    const readNative = async (context: OriginalContracts.TenantContext, reference: AgentNativeV4LegacyV3Reference) => {
      const service = native.service();
      const view = await service.get(context, reference.runId), item = view.items.find(row => row.id === reference.itemId);
      if (!item?.agentCommandId || item.proposalChecksum !== reference.prepareLookup.proposalChecksum || view.requestId !== reference.input.requestId ||
        view.requestChecksum !== sha(nativeContract.canonicalAgentNativeV3Request(reference.input)) || reference.prepareLookup.requestId !== view.requestId)
        throw new Error("agent_native_v4_legacy_native_identity_invalid");
      const receipt = await service.receipt(context, { requestId: reference.input.requestId, requestChecksum: view.requestChecksum });
      const itemReceipt = await service.itemReceipt(context, reference.runId, reference.itemId, reference.prepareLookup);
      // This is the original already-linked early return, including a stopped
      // or expired parent. Never call prepare on an unlinked historical item.
      phase = "reader_replay";
      const prepareReplay = await service.prepareItem(context, reference.runId, reference.itemId, reference.prepareLookup);
      if (itemReceipt.disposition !== "known" || prepareReplay.disposition !== "known" ||
        itemReceipt.agentCommandId !== prepareReplay.agentCommandId || itemReceipt.ownerCommandId !== prepareReplay.ownerCommandId)
        throw new Error("agent_native_v4_legacy_native_replay_invalid");
      return projectAgentNativeV4LegacyV3(view, receipt, itemReceipt, prepareReplay);
    };
    let references: AgentNativeV4LegacyReferences;
    if (mode === "186") {
      phase = "identity"; await native.initialize();
      const context = contracts.TenantContextSchema.parse(await native.base.current(native.base.a));
      phase = "basis";
      const succeededScene = await owners.seed(context, [3]);
      let packet = await owners.delivery.get(context, succeededScene.packet.id);
      for (const selected of packet.items) for (const kind of ["received", "accepted"] as const) {
        const item = packet.items.find(row => row.id === selected.id);
        if (!item?.snapshot?.manufacturing) throw new Error("agent_native_v4_legacy_delivery_source_missing");
        packet = await owners.delivery.recordFeedback(context, packet.id, item.id, { kind, expectedSequence: item.sequence,
          fileChecksum: item.snapshot.file.checksum, manufacturingChecksum: item.snapshot.manufacturing.plan.checksum, idempotencyKey: randomUUID(),
          reference: "SYNTHETIC_ORIGINAL186", note: "Synthetic operator attestation for this exact original186 fixture file",
          occurredAt: await owners.clock(context), verifiedByOperator: true });
      }
      const productionId = succeededScene.productions[0]!.order.id, production = await owners.production.get(context, productionId);
      const succeededInput = agentContract.PrepareAgentFulfillmentCommandSchema.parse({ ...agentQuery(succeededScene.order.id),
        original: fulfillmentContract.normalizeFulfillmentCommand({ kind: "production_milestone", requestId: randomUUID(), targetId: productionId,
          input: { type: "started", expectedProjectionVersion: production.productionOrder.projectionVersion, externalEventId: randomUUID(),
            occurredAt: await owners.clock(context), evidence: { code: "SYNTHETIC_ORIGINAL186", note: "Synthetic original186 operator observation only", assetIds: [] } } }) });
      phase = "succeeded";
      const prepared = await agent.prepare(context, succeededInput);
      const succeeded = await agent.confirm(context, prepared.native.id, agentContract.ConfirmAgentFulfillmentCommandSchema.parse({
        ...agentQuery(succeededInput.orderId), requestId: prepared.native.requestId, requestChecksum: prepared.native.requestChecksum,
        originalChecksum: prepared.originalChecksum, confirmationToken: prepared.confirmationToken, decision: prepared.confirmationDecision }));
      if (succeeded.native.status !== "succeeded" || succeeded.native.receipt?.kind !== "production_milestone")
        throw new Error("agent_native_v4_legacy_success_missing");
      phase = "basis";
      const pendingScene = await owners.seed(context, [3]); await owners.quality(context, pendingScene, 3);
      const sources = await owners.shipping.productionSources(context, pendingScene.order.id), source = sources.find(row => row.availableQuantity >= 3 && !row.blockers.length);
      if (!source?.qualityInspectionId) throw new Error("agent_native_v4_legacy_quality_source_missing");
      const shipment = await owners.shipping.create(context, pendingScene.order.id, contracts.CreateShipmentInputSchema.parse({
        shipDate: await owners.clock(context), shipFromCountryCode: "US", idempotencyKey: randomUUID(), packages: [{
          packageReferenceId: "SYNTHETIC-ORIGINAL186", trackingNumber: "SYNTHETIC-TRACK-" + contracts.createEntityId(), carrierCode: "SYNTHETIC",
          carrierName: "Synthetic original186 carrier", carrierService: "Synthetic service", lines: [{ orderLineId: source.orderLineId, quantity: 3,
            productionAllocations: [{ productionOrderId: source.productionOrderId, productionVersionId: source.productionVersionId, qualityInspectionId: source.qualityInspectionId,
              qualityGroupId: source.qualityGroupId, expectedProductionProjectionVersion: source.projectionVersion, quantity: 3 }] }] }] }));
      const versionId = shipment.versions[0]!.id;
      const pendingInput = agentContract.PrepareAgentFulfillmentCommandSchema.parse({ ...agentQuery(pendingScene.order.id),
        original: fulfillmentContract.normalizeFulfillmentCommand({ kind: "shipment_review", requestId: randomUUID(), targetId: shipment.shipment.id, versionId,
          input: { decision: "approved", reasonCode: "SYNTHETIC_ORIGINAL186_CHECK", reason: "Synthetic original186 operator package review",
            expectedCurrentVersion: 1, idempotencyKey: randomUUID() } }) });
      phase = "pending"; const pending = await agent.prepare(context, pendingInput);
      if (pending.native.status !== "prepared" || !pending.canConfirm || !pending.confirmationToken)
        throw new Error("agent_native_v4_legacy_pending_missing");
      const oldSource = await native.prior.legacy.prior.sourceContext(context);
      const requisition = oldSource.requisition;
      if (requisition.domain !== "procurement" || requisition.command.kind !== "requisition_create")
        throw new Error("agent_native_v4_legacy_native_draft_invalid");
      const requisitionCommand = requisition.command;
      const makeNative = async (kind: "stopped" | "expired"): Promise<AgentNativeV4LegacyV3Reference> => {
        phase = kind === "stopped" ? "native_stopped" : "native_expiring";
        const originalDraft = { domain: "procurement" as const, command: { ...requisitionCommand,
          input: { ...requisitionCommand.input, code: requisitionCommand.input.code + (kind === "stopped" ? "-STOP" : "-TTL") } } };
        native.controls.decision = packet => nativeModule.nativeV3Sequence(packet, [originalDraft]);
        const defaults = nativeContract.defaultAgentNativeV3Limits();
        const input = await native.request(native.base.a, { bindings: [{ tool: "inventory.balances.page", scope: { stockItemId: oldSource.stockItemId } }],
          allowedCommands: [{ domain: "procurement", kind: "requisition_create" }],
          ...(kind === "expired" ? { limits: { ...defaults, deadlineSeconds: 30 } } : {}) });
        const service = native.service(kind === "expired" ? 31 : undefined), created = await service.start(context, input);
        await native.process(created.id);
        const view = await service.get(context, created.id), item = view.items[0];
        if (view.status !== "completed" || view.items.length !== 1 || !item?.canPrepare)
          throw new Error("agent_native_v4_legacy_native_completed_missing");
        const prepareLookup = native.prepareInput(view, item);
        const linked = await service.prepareItem(context, created.id, item.id, prepareLookup);
        if (linked.disposition !== "known" || !linked.agentCommandId || !linked.ownerCommandId)
          throw new Error("agent_native_v4_legacy_native_link_missing");
        if (kind === "stopped") {
          await service.stop(context, created.id, nativeContract.StopAgentNativeV3Schema.parse({ version: nativeContract.AGENT_NATIVE_V3_VERSION, requestId: input.requestId }));
          // Stopping a model parent never disposes its original business intent.
          // Explicitly settle this unexecuted original slot before creating the
          // second requisition. Its immutable linked IDs still recover normally.
          const adapter = native.prior.legacy.owners.adapter;
          const reference = { domain: "procurement" as const, commandId: linked.ownerCommandId, accountId: null };
          const pendingOwner = await adapter.read(context, reference);
          if (pendingOwner.native.view.status !== "prepared" || !pendingOwner.native.view.canCancel || pendingOwner.native.view.acknowledged)
            throw new Error("agent_native_v4_legacy_native_slot_invalid");
          const cancelledOwner = await adapter.cancel(context, reference);
          if (cancelledOwner.native.view.status !== "cancelled" || cancelledOwner.native.view.acknowledged)
            throw new Error("agent_native_v4_legacy_native_cancel_invalid");
          const acknowledgedOwner = await adapter.acknowledge(context, reference);
          if (acknowledgedOwner.native.view.status !== "cancelled" || !acknowledgedOwner.native.view.acknowledged)
            throw new Error("agent_native_v4_legacy_native_acknowledgement_invalid");
        } else {
          phase = "native_expiry_wait";
          const expiresAt = Date.parse(view.expiresAt), until = Date.now() + 40_000;
          for (;;) {
            const now = await owners.clock(context);
            if (Date.parse(now) >= expiresAt) break;
            if (Date.now() >= until) throw new Error("agent_native_v4_legacy_expiry_deadline");
            await new Promise<void>(done => setTimeout(done, 100));
          }
          await native.runtime().process(context, created.id, "expire");
        }
        return { input, runId: created.id, itemId: item.id, prepareLookup };
      };
      references = { context, fulfillment: {
        pending: { id: pending.native.id, input: pendingInput, sourceIds: { orderId: pendingScene.order.id,
          productionId: pendingScene.productions[0]!.order.id, packageId: pendingScene.packet.id, shipmentId: shipment.shipment.id, versionId } },
        succeeded: { id: succeeded.native.id, input: succeededInput, sourceIds: { orderId: succeededScene.order.id, productionId, packageId: succeededScene.packet.id } },
      }, nativeV3: { stopped: await makeNative("stopped"), expired: await makeNative("expired") } };
    } else {
      phase = "reader_wait"; const incoming = receive(); let raw: AgentNativeV4LegacyReadRequest;
      try { await send({ type: "agent.native_v4.reader186.ready" }); raw = await incoming.result; }
      finally { incoming.cancel(); }
      const refs = record(raw.references, ["context", "fulfillment", "nativeV3"]), fulfillmentRefs = record(refs.fulfillment, ["pending", "succeeded"]),
        nativeRefs = record(refs.nativeV3, ["stopped", "expired"]);
      const context = contracts.TenantContextSchema.parse(refs.context), id = (value: unknown) => contracts.EntityIdSchema.parse(value);
      const parseFulfillment = <Sources extends PendingSources | SucceededSources>(rawValue: unknown, fields: readonly string[], kind: "shipment_review" | "production_milestone") => {
        const value = record(rawValue, ["id", "input", "sourceIds"]), sourceFields = record(value.sourceIds, fields);
        const sourceIds = Object.fromEntries(fields.map(field => [field, id(sourceFields[field])])) as Sources;
        const input = agentContract.PrepareAgentFulfillmentCommandSchema.parse(value.input);
        if (input.original.kind !== kind || input.orderId !== sourceIds.orderId ||
          input.original.targetId !== ("shipmentId" in sourceIds ? sourceIds.shipmentId : sourceIds.productionId) ||
          input.original.kind === "shipment_review" && (!("versionId" in sourceIds) || input.original.versionId !== sourceIds.versionId))
          throw new Error("agent_native_v4_legacy_read_source_invalid");
        return { id: id(value.id), input, sourceIds };
      };
      const parseNative = (rawValue: unknown): AgentNativeV4LegacyV3Reference => {
        const value = record(rawValue, ["input", "runId", "itemId", "prepareLookup"]), input = nativeContract.CreateAgentNativeV3Schema.parse(value.input);
        const prepareLookup = nativeContract.PrepareAgentNativeV3ItemSchema.parse(value.prepareLookup);
        if (prepareLookup.requestId !== input.requestId || input.bindings.length !== 1 || input.bindings[0]?.tool !== "inventory.balances.page" ||
          input.allowedCommands.length !== 1 || input.allowedCommands[0]?.domain !== "procurement" || input.allowedCommands[0]?.kind !== "requisition_create")
          throw new Error("agent_native_v4_legacy_read_native_invalid");
        return { input, runId: id(value.runId), itemId: id(value.itemId), prepareLookup };
      };
      references = { context, fulfillment: {
        pending: parseFulfillment<PendingSources>(fulfillmentRefs.pending, ["orderId", "productionId", "packageId", "shipmentId", "versionId"], "shipment_review"),
        succeeded: parseFulfillment<SucceededSources>(fulfillmentRefs.succeeded, ["orderId", "productionId", "packageId"], "production_milestone"),
      }, nativeV3: { stopped: parseNative(nativeRefs.stopped), expired: parseNative(nativeRefs.expired) } };
    }
    phase = "reader_get";
    const result = { references, fulfillment: {
      pending: await readFulfillment(references.context, references.fulfillment.pending),
      succeeded: await readFulfillment(references.context, references.fulfillment.succeeded),
    }, nativeV3: {
      stopped: await readNative(references.context, references.nativeV3.stopped),
      expired: await readNative(references.context, references.nativeV3.expired),
    }, counts: { syntheticModelCalls: native.modelCalls.length, workerProcesses: 0 as const, paidProviderCalls: 0 as const }, resourcesClosed: true as const };
    if (!result.nativeV3.stopped.view.stopRequestedAt || result.nativeV3.expired.view.privateAvailable ||
      result.fulfillment.pending.stable.native.status !== "prepared" || result.fulfillment.succeeded.stable.native.status !== "succeeded")
      throw new Error("agent_native_v4_legacy_snapshot_invalid");
    outcome = mode === "186" ? { type: "agent.native_v4.seeded186", ...result } : { type: "agent.native_v4.read186", ...result };
  } catch (error) { failure = error; await send(diagnostic(error, phase)).catch(() => {}); }
  for (const close of [closeNative, database ? () => database!.client.end() : undefined]) {
    try { phase = "cleanup"; await close?.(); }
    catch (error) { failure ??= error; await send(diagnostic(error, phase)).catch(() => {}); }
  }
  contentBytes?.fill(0);
  if (failure !== undefined) throw new Error("agent_native_v4_legacy_operation_failed");
  if (!outcome) throw new Error("agent_native_v4_legacy_result_missing");
  phase = "send";
  try { await send(outcome); }
  catch (error) { await send(diagnostic(error, phase)).catch(() => {}); throw new Error("agent_native_v4_legacy_ipc_closed"); }
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try { await original186(); }
  catch { process.exitCode = 1; }
  finally { if (process.connected) process.disconnect(); }
}
