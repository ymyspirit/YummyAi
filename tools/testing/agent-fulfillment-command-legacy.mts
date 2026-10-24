import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "../../packages/database/src/client.js";
import type * as OriginalDatabase from "../../packages/database/src/index.js";
import type * as OriginalContracts from "../../packages/contracts/src/index.js";
import type * as OriginalCommandContract from "../../packages/contracts/src/order/fulfillment-command.js";
import type * as OriginalCore from "../../packages/ai-core/src/index.js";
import type * as OriginalPorts from "../../apps/api/src/ai/agent-fulfillment.test-fixture.js";
import type * as OriginalIdentity from "../../apps/api/src/suppliers/factory-capacity.test-fixture.js";
import type * as OriginalOwner from "../../apps/api/src/orders/order-fulfillment-command-owner.js";
import type * as OriginalService from "../../apps/api/src/orders/order-fulfillment-command.service.js";
import { requireAgentFulfillmentCommandEnvironment } from "./require-agent-fulfillment-command-environment.mjs";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const expectedRoot = resolve(workspace, ".artifacts/ordinary-api-source-185-a4d9e821-r6");
const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-23-order-summary-state-a4d9e821");
const originalSha256 = "131bbbb76735c29eda94bb70ffe80e17bc6124c6e912c0760626c97d953094ba";
const originalFiles = 3808, originalLinks = 389;
const pairedCandidateId = "1df616ec946c417c931c3ef850721a5d";
const pairedBuildId = "dFtHa4UbXvP3llNy0Lox5";
const pairedArtifactSha256 = "12e24dc7f4c1f0cc77cc1e971c8fbbc00fe3ece63c3883cf45f14aed6a14a056";
const runtimeRelative = ".artifacts/runtime-tools/imagemagick-7.1.2-34-q16-hdri-x64";
const agentProtocol = "erp-agent-fulfillment-command-v1";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const samePath = (left: string, right: string) => process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
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
    target: string;
    web: string;
    manifest: {
      id: string; sourceSha256: string; sourceFiles: number; dependencyLockSha256: string;
      buildId: string; artifactsSha256: string; artifacts: Array<{ path: string; bytes: number; sha256: string }>;
    };
  }>;
};
type LegacyQuery = Parameters<OriginalDatabase.TenantTransaction["execute"]>[0];
type LegacySql = { (parts: TemplateStringsArray, ...values: unknown[]): LegacyQuery; identifier(name: string): LegacyQuery };

/** Check exact disposable resources before any connection or old business import. */
export function requireAgentFulfillmentCommandLegacyEnvironment(environment: NodeJS.ProcessEnv, target: "pre-0186" | "current") {
  const isolated = requireAgentFulfillmentCommandEnvironment(environment, false, target);
  const root = environment.E2E_AGENT_FULFILLMENT_COMMAND_LEGACY_SOURCE;
  if (environment.E2E_AGENT_FULFILLMENT_COMMAND_UPGRADE_ISOLATED !== "1" || !root || !isAbsolute(root) || !samePath(root, expectedRoot))
    throw new Error("agent_fulfillment_legacy_source_identity_invalid");
  return { ...isolated, root: resolve(root) };
}

/** Read the genuine already-adopted185 tree in place. Never follow graph links
 * during inventory, rewrite the old tree, or substitute today's migrations. */
export async function assertAgentFulfillmentCommandOriginal185Graph(root: string): Promise<void> {
  if (!samePath(root, expectedRoot)) throw new Error("agent_fulfillment_legacy_source_identity_invalid");
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("agent_fulfillment_legacy_root_invalid");
  const source = JSON.parse(await readFile(prefix + "-source-final-r6.json", "utf8")) as Source;
  const graph = JSON.parse(await readFile(prefix + "-source-graph-r6.json", "utf8")) as Graph;
  if (source.algorithm !== "runtime-source-v1" || source.sha256 !== originalSha256 || sha(JSON.stringify(source.files)) !== originalSha256 || source.files.length !== originalFiles ||
    graph.operation !== "a4d9e821" || graph.status !== "pass" || graph.schema !== 185 || !samePath(graph.sourceRoot, root) ||
    graph.sourceSha256 !== originalSha256 || graph.sourceFiles !== originalFiles || graph.workspaceDependenciesPinned !== true ||
    graph.allSourceBytesVerified !== true || graph.links.length !== originalLinks)
    throw new Error("agent_fulfillment_legacy_manifest_invalid");
  const files = new Set<string>();
  for (const entry of source.files) {
    const path = resolve(root, entry.path);
    if (!inside(root, path) || entry.path.includes("\\") || files.has(path.toLowerCase()) || !/^[a-f0-9]{64}$/.test(entry.sha256))
      throw new Error("agent_fulfillment_legacy_source_path_invalid");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !samePath(await realpath(path), path) || sha(await readFile(path)) !== entry.sha256)
      throw new Error("agent_fulfillment_legacy_source_bytes_changed");
    files.add(path.toLowerCase());
  }
  if (sha(await readFile(resolve(root, "pnpm-lock.yaml"))) !== graph.dependencyLockSha256) throw new Error("agent_fulfillment_legacy_lock_changed");
  for (const entry of graph.metadata) {
    if (!inside(root, entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || files.has(resolve(entry.path).toLowerCase()))
      throw new Error("agent_fulfillment_legacy_metadata_invalid");
    const stat = await lstat(entry.path);
    if (!stat.isFile() || stat.isSymbolicLink() || !samePath(await realpath(entry.path), entry.path) || sha(await readFile(entry.path)) !== entry.sha256)
      throw new Error("agent_fulfillment_legacy_metadata_changed");
    files.add(resolve(entry.path).toLowerCase());
  }
  const links = new Set<string>();
  for (const entry of graph.links) {
    if (!inside(root, entry.path) || links.has(resolve(entry.path).toLowerCase()) || !["workspace", "external", "runtime"].includes(entry.kind))
      throw new Error("agent_fulfillment_legacy_link_invalid");
    if (!(await lstat(entry.path)).isSymbolicLink() || !samePath(await realpath(entry.path), entry.resolvedTarget) || !samePath(await realpath(entry.target), entry.resolvedTarget))
      throw new Error("agent_fulfillment_legacy_link_changed");
    if (entry.kind === "workspace" ? !inside(root, entry.target) : inside(root, entry.target)) throw new Error("agent_fulfillment_legacy_link_escaped");
    links.add(resolve(entry.path).toLowerCase());
  }
  // This exact paired Web candidate is part of the retained running185 graph,
  // not an unrecorded source addition. Verify it before excluding its subtree.
  const paired = JSON.parse(await readFile(prefix + "-paired-candidate-r6.json", "utf8")) as PairedCandidate;
  const candidateRoot = resolve(root, ".artifacts/local-web-releases", pairedCandidateId);
  if (paired.operation !== "a4d9e821" || paired.status !== "pass" || !samePath(paired.sourceRoot, root) || paired.sourceSha256 !== originalSha256 ||
    paired.candidate !== pairedCandidateId || paired.buildId !== pairedBuildId || paired.artifactSha256 !== pairedArtifactSha256 ||
    paired.copiedFiles !== 2063 || paired.artifactFiles !== 2055 || paired.links.length !== 3 || paired.noEnvironmentFilesCopied !== true ||
    paired.sourceSnapshotAndCompiledCandidatePaired !== true || paired.sourceFilesAndDependencyGraphVerified !== true)
    throw new Error("agent_fulfillment_legacy_paired_candidate_invalid");
  const candidateStat = await lstat(candidateRoot);
  if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink() || !samePath(await realpath(candidateRoot), candidateRoot))
    throw new Error("agent_fulfillment_legacy_paired_candidate_root_invalid");
  const candidateLinks = new Set<string>();
  for (const entry of paired.links) {
    const suffix = ["node_modules", "packages", "apps/web/node_modules"].find(name => samePath(entry.path, resolve(candidateRoot, name)));
    if (!suffix || candidateLinks.has(suffix) || !samePath(entry.target, resolve(root, suffix)) || !inside(root, entry.target) ||
      !(await lstat(entry.path)).isSymbolicLink() || !samePath(await realpath(entry.path), entry.resolvedTarget) ||
      !samePath(await realpath(entry.target), entry.resolvedTarget)) throw new Error("agent_fulfillment_legacy_paired_candidate_link_changed");
    candidateLinks.add(suffix);
  }
  const { verifyLocalWebCandidate } = await import(pathToFileURL(resolve(root, "tools/scripts/local-web-candidate.mjs")).href) as PairedWebVerifier;
  const candidate = await verifyLocalWebCandidate(root, pairedCandidateId);
  if (!samePath(candidate.target, candidateRoot) || candidate.manifest.sourceSha256 !== originalSha256 || candidate.manifest.sourceFiles !== originalFiles ||
    candidate.manifest.dependencyLockSha256 !== graph.dependencyLockSha256 || candidate.manifest.buildId !== pairedBuildId ||
    candidate.manifest.artifactsSha256 !== pairedArtifactSha256 || candidate.manifest.artifacts.length !== paired.artifactFiles)
    throw new Error("agent_fulfillment_legacy_paired_candidate_changed");
  const observedLinks = new Set<string>(), pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const name of await readdir(directory)) {
      const path = resolve(directory, name), stat = await lstat(path);
      if (samePath(path, candidateRoot)) {
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("agent_fulfillment_legacy_paired_candidate_root_invalid");
        continue;
      }
      if (stat.isSymbolicLink()) {
        if (!links.has(path.toLowerCase())) throw new Error("agent_fulfillment_legacy_unrecorded_link");
        observedLinks.add(path.toLowerCase());
      } else if (stat.isDirectory()) pending.push(path);
      else if (!stat.isFile() || !files.has(path.toLowerCase())) throw new Error("agent_fulfillment_legacy_unrecorded_file");
    }
  }
  if (observedLinks.size !== links.size) throw new Error("agent_fulfillment_legacy_link_missing");
  const runtime = graph.links.filter(entry => entry.kind === "runtime");
  if (runtime.length !== 1 || !samePath(runtime[0]!.path, resolve(root, runtimeRelative)) || !samePath(runtime[0]!.target, resolve(workspace, runtimeRelative)) || graph.nativeRuntime.length !== 23)
    throw new Error("agent_fulfillment_legacy_runtime_invalid");
  const names = new Set<string>();
  for (const entry of graph.nativeRuntime) {
    if (!/^[A-Za-z0-9_.-]+$/.test(entry.path) || names.has(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !/^[a-f0-9]{64}$/.test(entry.sha256))
      throw new Error("agent_fulfillment_legacy_runtime_path_invalid");
    const bytes = await readFile(resolve(root, runtimeRelative, entry.path));
    if (bytes.byteLength !== entry.bytes || sha(bytes) !== entry.sha256) throw new Error("agent_fulfillment_legacy_runtime_changed");
    names.add(entry.path);
  }
  const require = createRequire(pathToFileURL(resolve(root, "apps/api/package.json")));
  let reachable = false;
  try { require.resolve("@yummyai/contracts/ai/agent-fulfillment-command"); reachable = true; }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || !["ERR_PACKAGE_PATH_NOT_EXPORTED", "MODULE_NOT_FOUND"].includes(String(error.code))) throw error;
  }
  if (reachable) throw new Error("agent_fulfillment_legacy_new_export_reachable");
  const journal = JSON.parse(await readFile(resolve(root, "packages/database/migrations/meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  if (journal.entries.length !== 185 || journal.entries.at(-1)?.tag !== "0185_order_fulfillment_command") throw new Error("agent_fulfillment_legacy_journal_invalid");
}

export async function migrateAgentFulfillmentCommandLegacyDatabase(database: DatabaseConnection, name: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const target = requireAgentFulfillmentCommandLegacyEnvironment(environment, "pre-0186");
  if (target.name !== name) throw new Error("agent_fulfillment_legacy_database_identity_invalid");
  await assertAgentFulfillmentCommandOriginal185Graph(target.root);
  const empty = "select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated";
  const [actual] = await database.client.unsafe(empty);
  if (actual?.name !== name || actual.ledger !== null || actual.populated !== false) throw new Error("agent_fulfillment_legacy_database_not_empty");
  const require = createRequire(pathToFileURL(resolve(target.root, "packages/database/package.json")));
  const { readMigrationFiles } = require("drizzle-orm/migrator") as { readMigrationFiles(options: { migrationsFolder: string }): Array<{ folderMillis: number; hash: string; sql: string[] }> };
  const migrations = readMigrationFiles({ migrationsFolder: resolve(target.root, "packages/database/migrations") });
  if (migrations.length !== 185) throw new Error("agent_fulfillment_legacy_prefix_invalid");
  await database.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    const [locked] = await tx.unsafe(empty);
    if (locked?.name !== name || locked.ledger !== null || locked.populated !== false) throw new Error("agent_fulfillment_legacy_database_not_empty");
    await tx.unsafe("create schema drizzle");
    await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) {
      for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]);
    }
  });
}

const phases = new Set(["environment", "ipc", "graph", "imports", "schema", "identity", "basis", "pending", "succeeded", "reader_wait", "reader_get", "reader_boundary", "cleanup", "send"]);
const errorNames = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AggregateError", "ZodError", "PostgresError", "DatabaseError", "ConflictException", "ForbiddenError", "ForbiddenException", "NotFoundException", "BadRequestException"]);
function diagnostic(error: unknown, phase: string) {
  let code: string | null = null, cause = error;
  for (let depth = 0; depth < 6 && cause && typeof cause === "object"; depth++) {
    if ("code" in cause && typeof cause.code === "string" && /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(cause.code)) code ??= cause.code;
    cause = "cause" in cause ? cause.cause : null;
  }
  return { type: "agent.fulfillment_command.failed185", phase: phases.has(phase) ? phase : "unhandled", code,
    errorName: error instanceof Error && errorNames.has(error.name) ? error.name : "Error" };
}
function send(value: object): Promise<void> {
  return new Promise((done, reject) => {
    if (!process.connected || !process.send) { reject(new Error("agent_fulfillment_legacy_ipc_closed")); return; }
    process.send(value, error => error ? reject(error) : done());
  });
}

export type AgentFulfillmentCommandLegacyReadRequest = {
  type: "agent.fulfillment_command.read185.request";
  context: unknown; pendingInput: unknown; succeededInput: unknown;
  pendingId: string; succeededId: string; pendingOrderId: string; succeededOrderId: string;
  agentId?: string;
};
function receive() {
  let cancel = () => {};
  const result = new Promise<AgentFulfillmentCommandLegacyReadRequest>((done, reject) => {
    const clear = () => { clearTimeout(timer); process.off("message", received); process.off("disconnect", disconnected); };
    cancel = clear;
    const disconnected = () => { clear(); reject(new Error("agent_fulfillment_legacy_ipc_closed")); };
    const received = (raw: unknown) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) { clear(); reject(new Error("agent_fulfillment_legacy_read_input_invalid")); return; }
      const value = raw as Record<string, unknown>, required = ["type", "context", "pendingInput", "succeededInput", "pendingId", "succeededId", "pendingOrderId", "succeededOrderId"];
      if (!required.every(key => key in value) || Object.keys(value).some(key => ![...required, "agentId"].includes(key)) || value.type !== "agent.fulfillment_command.read185.request" ||
        [value.pendingId, value.succeededId, value.pendingOrderId, value.succeededOrderId, ...(value.agentId === undefined ? [] : [value.agentId])].some(id => typeof id !== "string") || Buffer.byteLength(JSON.stringify(value)) > 262_144) {
        clear(); reject(new Error("agent_fulfillment_legacy_read_input_invalid")); return;
      }
      clear(); done(value as AgentFulfillmentCommandLegacyReadRequest);
    };
    const timer = setTimeout(() => { clear(); reject(new Error("agent_fulfillment_legacy_read_deadline")); }, 30_000);
    process.once("message", received); process.once("disconnect", disconnected);
  });
  void result.catch(() => {});
  return { result, cancel: () => cancel() };
}

/** Every runtime business import below is resolved through the immutable185 graph. */
async function original185(): Promise<void> {
  let phase = "environment", database: DatabaseConnection | undefined, failure: unknown, outcome: object | undefined, contentBytes: Buffer | undefined;
  try {
    const target = requireAgentFulfillmentCommandLegacyEnvironment(process.env, "current"), mode = process.env.E2E_AGENT_FULFILLMENT_COMMAND_LEGACY_CHILD;
    phase = "ipc";
    const configured = process.env.TSX_TSCONFIG_PATH, oldTsconfig = resolve(target.root, "apps/api/tsconfig.json");
    if (!process.connected || !["185", "read185"].includes(mode ?? "") || process.env.TSX_DISABLE_CACHE !== "1" ||
      (configured ? !isAbsolute(configured) || !samePath(configured, oldTsconfig) : !samePath(process.cwd(), resolve(target.root, "apps/api"))))
      throw new Error("agent_fulfillment_legacy_loader_invalid");
    const key = process.env.E2E_AGENT_FULFILLMENT_COMMAND_CONTENT_KEY ?? "";
    contentBytes = Buffer.from(key, "base64url");
    if (!/^[A-Za-z0-9_-]{43}$/.test(key) || contentBytes.byteLength !== 32 || contentBytes.toString("base64url") !== key)
      throw new Error("agent_fulfillment_legacy_content_key_invalid");
    phase = "graph"; await assertAgentFulfillmentCommandOriginal185Graph(target.root);
    const require = createRequire(pathToFileURL(resolve(target.root, "apps/api/package.json"))); require("reflect-metadata");
    const load = (name: string) => import(pathToFileURL(resolve(target.root, name)).href);
    phase = "imports";
    const db = await load("packages/database/src/index.ts") as typeof OriginalDatabase;
    const contracts = await load("packages/contracts/src/index.ts") as typeof OriginalContracts;
    const contract = await load("packages/contracts/src/order/fulfillment-command.ts") as typeof OriginalCommandContract;
    const core = await load("packages/ai-core/src/index.ts") as typeof OriginalCore;
    const ports = await load("apps/api/src/ai/agent-fulfillment.test-fixture.ts") as typeof OriginalPorts;
    const identity = await load("apps/api/src/suppliers/factory-capacity.test-fixture.ts") as typeof OriginalIdentity;
    const ownerModule = await load("apps/api/src/orders/order-fulfillment-command-owner.ts") as typeof OriginalOwner;
    const serviceModule = await load("apps/api/src/orders/order-fulfillment-command.service.ts") as typeof OriginalService;
    const { sql } = require("drizzle-orm") as { sql: LegacySql };
    database = db.connectDatabase(target.url);
    const connection = database;
    phase = "schema";
    const evidence = await db.readMigrationEvidence(connection);
    if (evidence.canonicalRows.length !== 185 || evidence.actualRows.length !== (mode === "185" ? 185 : 186) ||
      evidence.canonicalRows.some((row, index) => row.hash !== evidence.actualRows[index]?.hash || row.created_at !== evidence.actualRows[index]?.created_at))
      throw new Error("agent_fulfillment_legacy_actual_prefix_invalid");
    if (mode === "185") await db.assertDatabaseMigrationsCurrent(connection);
    const vault = new core.SecretVault(contentBytes);
    const owners = ports.fulfillmentOwnerPorts(connection, vault, new core.SecretVault(contentBytes));
    const owner = new ownerModule.OrderFulfillmentCommandOwner(connection, vault, owners.production, owners.delivery, owners.shipping);
    const commands = new serviceModule.OrderFulfillmentCommandService(connection, vault, owner, owners.audit);
    const receipt = (context: OriginalContracts.TenantContext, orderId: string, input: OriginalCommandContract.PrepareFulfillmentCommand) => commands.list(context,
      { orderId, requestId: input.requestId, requestChecksum: sha(contract.fulfillmentCommandCanonicalJson(input)) });
    if (mode === "185") {
      phase = "identity"; const fixture = identity.factoryCapacityFixture(connection); await fixture.initialize();
      const context = contracts.TenantContextSchema.parse(await fixture.current());
      phase = "basis";
      const succeededScene = await owners.seed(context, [3]);
      let packet = await owners.delivery.get(context, succeededScene.packet.id);
      for (const selected of packet.items) for (const kind of ["received", "accepted"] as const) {
        const item = packet.items.find(row => row.id === selected.id);
        if (!item?.snapshot?.manufacturing) throw new Error("agent_fulfillment_legacy_delivery_source_missing");
        packet = await owners.delivery.recordFeedback(context, packet.id, item.id, { kind, expectedSequence: item.sequence,
          fileChecksum: item.snapshot.file.checksum, manufacturingChecksum: item.snapshot.manufacturing.plan.checksum, idempotencyKey: randomUUID(),
          reference: "SYNTHETIC_ORIGINAL185", note: "Synthetic operator attestation for this exact original185 fixture file",
          occurredAt: await owners.clock(context), verifiedByOperator: true });
      }
      const productionId = succeededScene.productions[0]!.order.id, production = await owners.production.get(context, productionId);
      const succeededInput = contract.normalizeFulfillmentCommand({ kind: "production_milestone", requestId: randomUUID(), targetId: productionId,
        input: { type: "started", expectedProjectionVersion: production.productionOrder.projectionVersion, externalEventId: randomUUID(), occurredAt: await owners.clock(context),
          evidence: { code: "SYNTHETIC_ORIGINAL185", note: "Synthetic original185 operator observation only", assetIds: [] } } });
      phase = "succeeded";
      const prepared = await commands.prepare(context, succeededInput), succeeded = await commands.execute(context, prepared.id);
      if (succeeded.status !== "succeeded" || succeeded.receipt?.kind !== "production_milestone") throw new Error("agent_fulfillment_legacy_success_missing");
      phase = "basis";
      const pendingScene = await owners.seed(context, [3]); await owners.quality(context, pendingScene, 3);
      const sources = await owners.shipping.productionSources(context, pendingScene.order.id), source = sources.find(row => row.availableQuantity >= 3 && !row.blockers.length);
      if (!source?.qualityInspectionId) throw new Error("agent_fulfillment_legacy_quality_source_missing");
      const shipmentInput = contracts.CreateShipmentInputSchema.parse({ shipDate: await owners.clock(context), shipFromCountryCode: "US", idempotencyKey: randomUUID(),
        packages: [{ packageReferenceId: "SYNTHETIC-ORIGINAL185", trackingNumber: "SYNTHETIC-TRACK-" + contracts.createEntityId(), carrierCode: "SYNTHETIC",
          carrierName: "Synthetic original185 carrier", carrierService: "Synthetic service", lines: [{ orderLineId: source.orderLineId, quantity: 3,
            productionAllocations: [{ productionOrderId: source.productionOrderId, productionVersionId: source.productionVersionId, qualityInspectionId: source.qualityInspectionId,
              qualityGroupId: source.qualityGroupId, expectedProductionProjectionVersion: source.projectionVersion, quantity: 3 }] }] }] });
      const shipment = await owners.shipping.create(context, pendingScene.order.id, shipmentInput), versionId = shipment.versions[0]!.id;
      const pendingInput = contract.normalizeFulfillmentCommand({ kind: "shipment_review", requestId: randomUUID(), targetId: shipment.shipment.id, versionId,
        input: { decision: "approved", reasonCode: "SYNTHETIC_ORIGINAL185_CHECK", reason: "Synthetic original185 operator package review", expectedCurrentVersion: 1, idempotencyKey: randomUUID() } });
      phase = "pending"; const pending = await commands.prepare(context, pendingInput);
      if (pending.status !== "prepared" || pending.receipt !== null || !pending.canExecute) throw new Error("agent_fulfillment_legacy_pending_missing");
      outcome = { type: "agent.fulfillment_command.seeded185", context, pendingInput, succeededInput, pendingOrderId: pendingScene.order.id, succeededOrderId: succeededScene.order.id,
        pending, succeeded, pendingReceipt: await receipt(context, pendingScene.order.id, pendingInput), succeededReceipt: await receipt(context, succeededScene.order.id, succeededInput),
        sourceIds: { pending: { orderId: pendingScene.order.id, productionId: pendingScene.productions[0]!.order.id, packageId: pendingScene.packet.id, shipmentId: shipment.shipment.id, versionId },
          succeeded: { orderId: succeededScene.order.id, productionId, packageId: succeededScene.packet.id } }, modelCalls: 0, workerProcesses: 0, resourcesClosed: true };
    } else {
      phase = "reader_wait"; const incoming = receive(); let raw: AgentFulfillmentCommandLegacyReadRequest;
      try { await send({ type: "agent.fulfillment_command.reader185.ready" }); raw = await incoming.result; }
      finally { incoming.cancel(); }
      const context = contracts.TenantContextSchema.parse(raw.context), pendingInput = contract.normalizeFulfillmentCommand(raw.pendingInput), succeededInput = contract.normalizeFulfillmentCommand(raw.succeededInput);
      const [pendingId, succeededId, pendingOrderId, succeededOrderId] = [raw.pendingId, raw.succeededId, raw.pendingOrderId, raw.succeededOrderId].map(value => contracts.EntityIdSchema.parse(value));
      if (pendingInput.kind !== "shipment_review" || succeededInput.kind !== "production_milestone" || !pendingId || !succeededId || !pendingOrderId || !succeededOrderId)
        throw new Error("agent_fulfillment_legacy_read_input_invalid");
      phase = "reader_get";
      const pending = await commands.get(context, pendingId), succeeded = await commands.get(context, succeededId);
      const pendingReceipt = await receipt(context, pendingOrderId, pendingInput), succeededReceipt = await receipt(context, succeededOrderId, succeededInput);
      for (const [view, input, orderId, recovered] of [[pending, pendingInput, pendingOrderId, pendingReceipt], [succeeded, succeededInput, succeededOrderId, succeededReceipt]] as const)
        if (view.orderId !== orderId || view.requestId !== input.requestId || view.requestChecksum !== sha(contract.fulfillmentCommandCanonicalJson(input)) ||
          recovered.truncated || recovered.items.length !== 1 || recovered.items[0]?.id !== view.id) throw new Error("agent_fulfillment_legacy_read_original_mismatch");
      let agentBoundary: { id: string; status: 409; legacyEnvelopeVersionPinned: true; rowUnchanged: true; businessUnchanged: true; auditUnchanged: true;
        rowChecksum: string; businessChecksum: string; auditChecksum: string } | null = null;
      if (raw.agentId !== undefined) {
        phase = "reader_boundary";
        const id = contracts.EntityIdSchema.parse(raw.agentId), text = await readFile(resolve(target.root, "apps/api/src/orders/order-fulfillment-command.service.ts"), "utf8");
        const execute = text.slice(text.indexOf("  async execute("), text.indexOf("  async cancel("));
        if (!text.includes("row.contractVersion !== FULFILLMENT_COMMAND_VERSION") || contract.FULFILLMENT_COMMAND_VERSION !== "fulfillment-command-v1" ||
          execute.indexOf("this.view(tx, context, row)") < 0 || execute.indexOf("this.view(tx, context, row)") > execute.indexOf("tx.update(intents)") ||
          execute.indexOf("this.owner.execute") < execute.indexOf("tx.update(intents)")) throw new Error("agent_fulfillment_legacy_envelope_pin_invalid");
        const snapshot = () => db.withTenant(connection.db, context, async tx => {
          const [metadata] = await tx.execute<{ tenantId: string; userId: string; version: string; status: string; usable: boolean; rowChecksum: string }>(sql`
            select c.tenant_id as "tenantId",c.created_by as "userId",c.contract_version as version,c.status,
              (c.encrypted_input is not null and c.acknowledged_at is null and c.redacted_at is null and c.generation=0 and c.lease_token is null
                and c.expires_at>clock_timestamp() and order_fulfillment_command_source_available(c)) as usable,
              encode(sha256(convert_to(row_to_json(c)::text,'UTF8')),'hex') as "rowChecksum"
            from order_fulfillment_command_intents c where c.id=${id}::uuid`);
          const digest = async (name: string) => {
            const [row] = await tx.execute<{ digest: string }>(sql`select encode(sha256(convert_to(coalesce(string_agg(row_to_json(item)::text,'' order by row_to_json(item)::text),''),'UTF8')),'hex') as digest from ${sql.identifier(name)} item`);
            if (!row?.digest) throw new Error("agent_fulfillment_legacy_boundary_digest_missing");
            return row.digest;
          };
          const business: Array<{ table: string; sha256: string }> = [];
          for (const name of ports.fulfillmentBusinessTables) business.push({ table: name, sha256: await digest(name) });
          return { metadata, businessChecksum: sha(JSON.stringify(business)), auditChecksum: await digest("audit_events") };
        }, { isolationLevel: "repeatable read", accessMode: "read only" });
        const before = await snapshot();
        if (!before.metadata || before.metadata.tenantId !== context.tenantId || before.metadata.userId !== context.userId ||
          before.metadata.version !== agentProtocol || before.metadata.status !== "prepared" || !before.metadata.usable)
          throw new Error("agent_fulfillment_legacy_boundary_identity_invalid");
        let refused = false;
        try { await commands.execute(context, id); }
        catch (error) {
          if (error && typeof error === "object" && "getStatus" in error && typeof error.getStatus === "function" && error.getStatus() === 409 &&
            error instanceof Error && error.message === "原履约提交完整性校验失败") refused = true;
          else throw error;
        }
        if (!refused) throw new Error("agent_fulfillment_legacy_boundary_not_rejected");
        const after = await snapshot();
        if (before.metadata.rowChecksum !== after.metadata?.rowChecksum || before.businessChecksum !== after.businessChecksum || before.auditChecksum !== after.auditChecksum)
          throw new Error("agent_fulfillment_legacy_boundary_changed");
        agentBoundary = { id, status: 409, legacyEnvelopeVersionPinned: true, rowUnchanged: true, businessUnchanged: true, auditUnchanged: true,
          rowChecksum: before.metadata.rowChecksum, businessChecksum: before.businessChecksum, auditChecksum: before.auditChecksum };
      }
      outcome = { type: "agent.fulfillment_command.read185", context, pendingInput, succeededInput, pendingOrderId, succeededOrderId,
        pending, succeeded, pendingReceipt, succeededReceipt, agentBoundary, modelCalls: 0, workerProcesses: 0, resourcesClosed: true };
    }
  } catch (error) { failure = error; await send(diagnostic(error, phase)).catch(() => {}); }
  try { phase = "cleanup"; await database?.client.end(); database = undefined; }
  catch (error) { failure ??= error; await send(diagnostic(error, phase)).catch(() => {}); }
  finally { contentBytes?.fill(0); }
  if (failure !== undefined) throw new Error("agent_fulfillment_legacy_operation_failed");
  if (!outcome) throw new Error("agent_fulfillment_legacy_result_missing");
  phase = "send";
  try { await send(outcome); }
  catch (error) { await send(diagnostic(error, phase)).catch(() => {}); throw new Error("agent_fulfillment_legacy_ipc_closed"); }
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try { await original185(); }
  catch { process.exitCode = 1; }
  finally { if (process.connected) process.disconnect(); }
}
