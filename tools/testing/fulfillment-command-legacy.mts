import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "../../packages/database/src/client.js";
import type * as OriginalDatabase from "../../packages/database/src/index.js";
import type * as OriginalContracts from "../../packages/contracts/src/index.js";
import type * as OriginalCore from "../../packages/ai-core/src/index.js";
import type * as OriginalPorts from "../../apps/api/src/ai/agent-fulfillment.test-fixture.js";
import type * as OriginalIdentity from "../../apps/api/src/suppliers/factory-capacity.test-fixture.js";
import { requireFulfillmentCommandEnvironment } from "./require-fulfillment-command-environment.mjs";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const expectedRoot = resolve(workspace, ".artifacts/ordinary-api-source-184-3f7c2a91-r2");
const originalSha256 = "fc598294ed6bc94426a5caaa5abc63456774698bcd236b61a3249fa30dda7ec8";
const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-23-agent-dependency-plan-3f7c2a91");
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const same = (left: string, right: string) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
const inside = (root: string, path: string) => { const name = relative(root, path); return name !== "" && !isAbsolute(name) && name !== ".." && !name.startsWith("..\\") && !name.startsWith("../"); };
type Source = { algorithm: string; sha256: string; files: Array<{ path: string; sha256: string }> };
type Graph = { status: string; schema: number; sourceRoot: string; sourceSha256: string; sourceFiles: number; dependencyLockSha256: string;
  links: Array<{ path: string; target: string; kind: string }>; nativeRuntime: Array<{ path: string; bytes: number; sha256: string }> };

export function requireFulfillmentCommandLegacyEnvironment(environment: NodeJS.ProcessEnv = process.env, target: "current" | "pre-0185" = "pre-0185") {
  const isolated = requireFulfillmentCommandEnvironment(environment, target), root = environment.E2E_FULFILLMENT_COMMAND_LEGACY_SOURCE;
  if (!root || !isAbsolute(root) || !same(root, expectedRoot)) throw new Error("fulfillment_legacy_source_identity_invalid");
  return { ...isolated, root };
}

/** The already adopted immutable184 tree is read in place, never relabelled or
 * edited. Every source byte and pinned dependency/native runtime is verified. */
export async function assertFulfillmentCommandOriginal184Graph(root: string): Promise<void> {
  if (!same(root, expectedRoot)) throw new Error("fulfillment_legacy_source_identity_invalid");
  const stat = await lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("fulfillment_legacy_root_invalid");
  const source = JSON.parse(await readFile(prefix + "-source-final-r3.json", "utf8")) as Source;
  const graph = JSON.parse(await readFile(prefix + "-source-graph-r2.json", "utf8")) as Graph;
  if (source.algorithm !== "runtime-source-v1" || source.sha256 !== originalSha256 || sha(JSON.stringify(source.files)) !== originalSha256 || source.files.length !== 3773
    || graph.status !== "pass" || graph.schema !== 184 || !same(graph.sourceRoot, root) || graph.sourceSha256 !== originalSha256 || graph.sourceFiles !== 3773 || graph.links.length !== 389)
    throw new Error("fulfillment_legacy_manifest_invalid");
  const visited = new Set<string>();
  for (const entry of source.files) {
    const path = resolve(root, entry.path);
    if (!inside(root, path) || entry.path.includes("\\") || visited.has(path.toLowerCase()) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("fulfillment_legacy_source_path_invalid");
    const item = await lstat(path);
    if (!item.isFile() || item.isSymbolicLink() || !same(await realpath(path), path) || sha(await readFile(path)) !== entry.sha256) throw new Error("fulfillment_legacy_source_bytes_changed");
    visited.add(path.toLowerCase());
  }
  if (sha(await readFile(resolve(root, "pnpm-lock.yaml"))) !== graph.dependencyLockSha256) throw new Error("fulfillment_legacy_lock_changed");
  const links = new Set<string>();
  for (const entry of graph.links) {
    if (!inside(root, entry.path) || links.has(entry.path.toLowerCase()) || !["workspace", "external", "runtime"].includes(entry.kind)) throw new Error("fulfillment_legacy_link_invalid");
    if (!(await lstat(entry.path)).isSymbolicLink() || !same(await realpath(entry.path), await realpath(entry.target))) throw new Error("fulfillment_legacy_link_changed");
    if (entry.kind === "workspace" && !inside(root, entry.target)) throw new Error("fulfillment_legacy_workspace_escaped");
    links.add(entry.path.toLowerCase());
  }
  const runtime = graph.links.filter(entry => entry.kind === "runtime");
  if (runtime.length !== 1 || graph.nativeRuntime.length !== 23) throw new Error("fulfillment_legacy_runtime_invalid");
  for (const entry of graph.nativeRuntime) {
    if (!/^[A-Za-z0-9_.-]+$/.test(entry.path)) throw new Error("fulfillment_legacy_runtime_path_invalid");
    const bytes = await readFile(resolve(runtime[0]!.path, entry.path));
    if (bytes.byteLength !== entry.bytes || sha(bytes) !== entry.sha256) throw new Error("fulfillment_legacy_runtime_changed");
  }
  const require = createRequire(pathToFileURL(resolve(root, "apps/api/package.json")));
  let reachable = false;
  try { require.resolve("@yummyai/contracts/order/fulfillment-command"); reachable = true; }
  catch (error) { if (!error || typeof error !== "object" || !("code" in error) || !["ERR_PACKAGE_PATH_NOT_EXPORTED", "MODULE_NOT_FOUND"].includes(String(error.code))) throw error; }
  if (reachable) throw new Error("fulfillment_legacy_new_contract_reachable");
  const journal = JSON.parse(await readFile(resolve(root, "packages/database/migrations/meta/_journal.json"), "utf8"));
  if (journal.entries.length !== 184 || journal.entries.at(-1)?.tag !== "0184_agent_dependency_plan") throw new Error("fulfillment_legacy_journal_invalid");
}

export async function migrateFulfillmentCommandLegacyDatabase(database: DatabaseConnection, name: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const target = requireFulfillmentCommandLegacyEnvironment(environment, "pre-0185"); if (target.name !== name) throw new Error("fulfillment_legacy_database_identity_invalid");
  await assertFulfillmentCommandOriginal184Graph(target.root);
  const [actual] = await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== name || actual.ledger !== null || actual.populated !== false) throw new Error("fulfillment_legacy_database_not_empty");
  const require = createRequire(pathToFileURL(resolve(target.root, "packages/database/package.json")));
  const { readMigrationFiles } = require("drizzle-orm/migrator") as { readMigrationFiles(options: { migrationsFolder: string }): Array<{ folderMillis: number; hash: string; sql: string[] }> };
  const migrations = readMigrationFiles({ migrationsFolder: resolve(target.root, "packages/database/migrations") }); if (migrations.length !== 184) throw new Error("fulfillment_legacy_prefix_invalid");
  await database.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    await tx.unsafe("create schema drizzle"); await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) { for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]); }
  });
}

const send = (message: object) => new Promise<void>((done, reject) => {
  if (!process.connected || !process.send) { reject(new Error("fulfillment_legacy_ipc_closed")); return; }
  process.send(message, error => error ? reject(error) : done());
});
type ReadRequest = { type: "fulfillment.read184.request"; context: unknown; orderId: string; productionId: string; packageId: string; shipmentId: string };
function receive(): Promise<ReadRequest> {
  return new Promise((done, reject) => {
    const clean = () => { clearTimeout(timer); process.off("message", onMessage); process.off("disconnect", onDisconnect); };
    const onDisconnect = () => { clean(); reject(new Error("fulfillment_legacy_ipc_closed")); };
    const onMessage = (raw: unknown) => {
      const value = raw as ReadRequest, keys = ["type", "context", "orderId", "productionId", "packageId", "shipmentId"];
      if (!value || typeof value !== "object" || Object.keys(value).length !== keys.length || !keys.every(key => key in value) || value.type !== "fulfillment.read184.request"
        || [value.orderId, value.productionId, value.packageId, value.shipmentId].some(id => typeof id !== "string") || Buffer.byteLength(JSON.stringify(value)) > 65_536) {
        clean(); reject(new Error("fulfillment_legacy_read_input_invalid")); return;
      }
      clean(); done(value);
    };
    const timer = setTimeout(() => { clean(); reject(new Error("fulfillment_legacy_read_deadline")); }, 30_000);
    process.once("message", onMessage); process.once("disconnect", onDisconnect);
  });
}

async function original184(): Promise<void> {
  let phase = "environment", database: DatabaseConnection | undefined, outcome: object | undefined, contentBytes: Buffer | undefined;
  try {
    const target = requireFulfillmentCommandLegacyEnvironment(process.env, "current"), mode = process.env.E2E_FULFILLMENT_COMMAND_LEGACY_CHILD;
    if (!process.connected || !["184", "read184"].includes(mode ?? "") || !same(process.env.TSX_TSCONFIG_PATH ?? "", resolve(target.root, "apps/api/tsconfig.json"))) throw new Error("fulfillment_legacy_loader_invalid");
    const key = process.env.E2E_FULFILLMENT_COMMAND_CONTENT_KEY ?? ""; contentBytes = Buffer.from(key, "base64url");
    if (!/^[A-Za-z0-9_-]{43}$/.test(key) || contentBytes.byteLength !== 32 || contentBytes.toString("base64url") !== key) throw new Error("fulfillment_legacy_content_key_invalid");
    phase = "graph"; await assertFulfillmentCommandOriginal184Graph(target.root);
    const require = createRequire(pathToFileURL(resolve(target.root, "apps/api/package.json"))); require("reflect-metadata");
    const load = (name: string) => import(pathToFileURL(resolve(target.root, name)).href);
    phase = "imports";
    const db = await load("packages/database/src/index.ts") as typeof OriginalDatabase, contracts = await load("packages/contracts/src/index.ts") as typeof OriginalContracts;
    const core = await load("packages/ai-core/src/index.ts") as typeof OriginalCore, ports = await load("apps/api/src/ai/agent-fulfillment.test-fixture.ts") as typeof OriginalPorts;
    const identity = await load("apps/api/src/suppliers/factory-capacity.test-fixture.ts") as typeof OriginalIdentity;
    database = db.connectDatabase(target.url);
    phase = "schema"; const evidence = await db.readMigrationEvidence(database);
    if (evidence.canonicalRows.length !== 184 || evidence.actualRows.length !== (mode === "184" ? 184 : 185)
      || evidence.canonicalRows.some((row, i) => row.hash !== evidence.actualRows[i]?.hash || row.created_at !== evidence.actualRows[i]?.created_at)) throw new Error("fulfillment_legacy_actual_prefix_invalid");
    const vault = new core.SecretVault(contentBytes), owners = ports.fulfillmentOwnerPorts(database, vault, new core.SecretVault(Buffer.from(contentBytes)));
    if (mode === "184") {
      phase = "identity"; const fixture = identity.factoryCapacityFixture(database); await fixture.initialize(); const context = await fixture.current();
      phase = "seed"; const scene = await owners.seed(context, [3]); await owners.quality(context, scene, 3);
      const sources = await owners.shipping.productionSources(context, scene.order.id), source = sources.find(row => row.availableQuantity >= 3 && !row.blockers.length);
      if (!source?.qualityInspectionId) throw new Error("fulfillment_legacy_quality_source_missing");
      const shipmentInput = contracts.CreateShipmentInputSchema.parse({ shipDate: await owners.clock(context), shipFromCountryCode: "US", idempotencyKey: randomUUID(),
        packages: [{ packageReferenceId: "SYNTHETIC-ORIGINAL184", trackingNumber: "SYNTHETIC-TRACK-" + contracts.createEntityId(), carrierCode: "SYNTHETIC", carrierName: "Synthetic original184 carrier", carrierService: "Synthetic service",
          lines: [{ orderLineId: source.orderLineId, quantity: 3, productionAllocations: [{ productionOrderId: source.productionOrderId, productionVersionId: source.productionVersionId, qualityInspectionId: source.qualityInspectionId,
            qualityGroupId: source.qualityGroupId, expectedProductionProjectionVersion: source.projectionVersion, quantity: 3 }] }] }] });
      const shipment = await owners.shipping.create(context, scene.order.id, shipmentInput), versionId = shipment.versions[0]!.id;
      const reviewInput = contracts.ReviewShipmentVersionInputSchema.parse({ decision: "approved", reasonCode: "SYNTHETIC_ORIGINAL184_CHECK", reason: "Synthetic exact original184 package review", expectedCurrentVersion: 1, idempotencyKey: randomUUID() });
      await owners.shipping.reviewVersion(context, shipment.shipment.id, versionId, reviewInput);
      const productionId = scene.productions[0]!.order.id;
      outcome = { type: "fulfillment.seeded184", context, orderId: scene.order.id, productionId, packageId: scene.packet.id, shipmentId: shipment.shipment.id,
        shipmentInput, reviewInput, versionId, productionView: await owners.production.get(context, productionId), deliveryView: await owners.delivery.get(context, scene.packet.id),
        shipmentView: await owners.shipping.get(context, shipment.shipment.id), qualityView: await owners.production.qualityGroups(context, productionId), resourcesClosed: true, modelCalls: 0, workerProcesses: 0 };
    } else {
      phase = "reader_wait"; const incoming = receive(); await send({ type: "fulfillment.reader184.ready" }); const raw = await incoming;
      const context = contracts.TenantContextSchema.parse(raw.context);
      for (const id of [raw.orderId, raw.productionId, raw.packageId, raw.shipmentId]) contracts.EntityIdSchema.parse(id);
      phase = "reader_get";
      outcome = { type: "fulfillment.read184", productionView: await owners.production.get(context, raw.productionId), deliveryView: await owners.delivery.get(context, raw.packageId),
        shipmentView: await owners.shipping.get(context, raw.shipmentId), qualityView: await owners.production.qualityGroups(context, raw.productionId), resourcesClosed: true, modelCalls: 0, workerProcesses: 0 };
    }
    phase = "cleanup"; await database.client.end(); database = undefined; contentBytes.fill(0); contentBytes = undefined;
    if (!outcome) throw new Error("fulfillment_legacy_result_missing"); await send(outcome);
  } catch (error) {
    const cause = error as { code?: unknown }; const code = typeof cause?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(cause.code) ? cause.code : null;
    await send({ type: "fulfillment.failed184", phase, errorName: error instanceof Error ? error.name : "Error", code }).catch(() => {});
    throw new Error("fulfillment_legacy_operation_failed");
  } finally { contentBytes?.fill(0); await database?.client.end(); }
}
if (process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url))) {
  try { await original184(); } catch { process.exitCode = 1; } finally { if (process.connected) process.disconnect(); }
}
