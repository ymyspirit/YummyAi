import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "../../packages/database/src/client.js";
import type * as OriginalDatabase from "../../packages/database/src/index.js";
import type * as OriginalFixture from "../../apps/api/src/ai/agent-native.test-fixture.js";
import type * as OriginalService from "../../apps/api/src/ai/agent-native.service.js";
import type * as OriginalDispatcher from "../../apps/api/src/ai/redis-agent-plan-dispatcher.js";
import type * as OriginalCore from "../../packages/ai-core/src/index.js";
import type * as OriginalJobs from "../../packages/jobs/src/index.js";
import type * as OriginalCommands from "../../packages/contracts/src/ai/agent-command.js";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

const workspace = fileURLToPath(new URL("../../", import.meta.url)), prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-22-agent-native-v2-5c82e6b4");
const expectedRoot = resolve(workspace, "tmp/agent-native-v2-20261022-5c82e6b4/old175-source");
const diagnosticPhases = new Set(["original175_entry", "original175_environment", "original175_parent", "original175_graph", "original175_imports",
  "original175_schema", "original175_initialize", "original175_sources", "original175_real_read_model_preparation", "original175_completed_receipt",
  "original175_submitted_unknown", "original175_received_before_adoption", "original175_seeded_receipt", "original175_cleanup", "original175_unhandled"]);
const diagnosticNames = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AggregateError", "ZodError", "PostgresError", "DatabaseError",
  "ConflictException", "ForbiddenError", "ForbiddenException", "NotFoundException", "BadRequestException", "UnauthorizedException"]);
const diagnosticCode = /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/;
/** Deliberately excludes error messages, SQL, environment values and raw stacks. */
export function agentNativeV2LegacyDiagnostic(error: unknown, phase: string) {
  let code: string | null = null, location: { file: string; line: number } | null = null, cause = error;
  for (let depth = 0; depth < 7 && cause && typeof cause === "object"; depth++) {
    if ("code" in cause && typeof cause.code === "string" && diagnosticCode.test(cause.code)) code ??= cause.code;
    if (!location && "stack" in cause && typeof cause.stack === "string") for (const line of cause.stack.split(/\r?\n/).slice(1, 12)) {
      const match = /((?:file:\/\/\/)?[A-Za-z]:[\\/][^()\r\n]*?\.[cm]?[jt]sx?):([1-9][0-9]*):[0-9]+\)?$/.exec(line.trim());
      if (!match) continue;
      try { const absolute = match[1]!.startsWith("file:") ? fileURLToPath(match[1]!) : match[1]!;
        const file = relative(workspace, absolute).replaceAll("\\", "/"), number = Number(match[2]);
        if (!isAbsolute(file) && !file.startsWith("../") && /^(?:(?:apps|packages|tools)\/|tmp\/agent-native-v2-20261022-5c82e6b4\/old175-source\/(?:apps|packages|tools)\/)[A-Za-z0-9_./-]+\.[cm]?[jt]sx?$/.test(file)
          && Number.isSafeInteger(number) && number > 0) { location = { file, line: number }; break; }
      } catch { /* An unrecognized stack location is not a diagnostic field. */ }
    }
    cause = "cause" in cause ? cause.cause : null;
  }
  return { type: "agent.native.v2.failed" as const, phase: diagnosticPhases.has(phase) ? phase : "original175_unhandled", code,
    errorName: error instanceof Error && diagnosticNames.has(error.name) ? error.name : "Error", location };
}
const flags = ["E2E_AGENT_NATIVE_V2_ISOLATED", "E2E_AGENT_RESOURCES_ISOLATED", "E2E_AGENT_MCP_ISOLATED", "E2E_AGENT_NATIVE_ISOLATED", "E2E_AGENT_TOOLS_ISOLATED",
  "E2E_AGENT_PLAN_ISOLATED", "E2E_AGENT_LOOP_ISOLATED", "E2E_AGENT_COMMAND_ISOLATED", "E2E_AGENT_READ_ISOLATED", "E2E_ROLE_BENCHMARK_ISOLATED",
  "E2E_BUSINESS_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_EVALUATION_ISOLATED", "E2E_ISOLATED_DAILY"];
export function requireAgentNativeV2LegacyEnvironment(environment: NodeJS.ProcessEnv, target: "pre-0176" | "current") {
  const url = new URL(requireDisposableIntegrationEnvironment(environment)), root = environment.E2E_AGENT_NATIVE_V2_LEGACY_SOURCE;
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1], redis = environment.E2E_DISPOSABLE_REDIS_URL, local = ["localhost", "127.0.0.1", "[::1]"];
  if (!nonce || flags.some(key => environment[key] !== "1") || environment.E2E_LEGACY_SCHEMA_TARGET !== target || !root || !isAbsolute(root) || resolve(root) !== expectedRoot ||
    !local.includes(url.hostname) || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !redis || environment.REDIS_URL !== redis ||
    environment.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` || !["redis:", "rediss:"].includes(new URL(redis).protocol) || !local.includes(new URL(redis).hostname))
    throw new Error("NativeV2 upgrade requires exact original175 source and every isolated nonce resource before connection");
  return { root: resolve(root), url: url.href, name: url.pathname.slice(1), nonce };
}
export async function assertAgentNativeV2Original175Graph(root: string) {
  if (resolve(root) !== expectedRoot) throw new Error("Original175 source identity mismatch");
  const source = JSON.parse(await readFile(prefix + "-source-before.json", "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
  const graph = JSON.parse(await readFile(prefix + "-old175-source.json", "utf8")) as { operation: string; sourceRoot: string; sourceFiles: number; sourceSha256: string;
    workspaceDependenciesPinned: boolean; newNativeV2ExportReachable: boolean; links: Array<{ path: string; target: string }> };
  if (source.files.length !== 3310 || source.sha256 !== "565ab46c9492f24cf5a13e1dab05c964104be871b7756207d90e47a42946309d" || graph.operation !== "5c82e6b4" ||
    resolve(graph.sourceRoot) !== expectedRoot || graph.sourceFiles !== source.files.length || graph.sourceSha256 !== source.sha256 || graph.links.length !== 361 ||
    !graph.workspaceDependenciesPinned || graph.newNativeV2ExportReachable) throw new Error("Original175 protected source manifest mismatch");
  for (const file of source.files) if (createHash("sha256").update(await readFile(resolve(root, file.path))).digest("hex") !== file.sha256)
    throw new Error("Original175 source byte mismatch: " + file.path);
  for (const link of graph.links) if (await realpath(link.path) !== await realpath(link.target)) throw new Error("Original175 dependency graph mismatch");
  const require = createRequire(pathToFileURL(resolve(root, "apps/api/package.json")));
  for (const name of ["contracts", "database", "ai-core", "authz", "jobs", "storage", "workflow-core", "catalog-core", "knowledge-core", "pod-core", "order-core"])
    if (await realpath(resolve(root, "apps/api/node_modules/@yummyai", name)) !== await realpath(resolve(root, "packages", name))) throw new Error("Original175 workspace escaped: " + name);
  let reachable = false; try { require.resolve("@yummyai/contracts/ai/agent-native-v2"); reachable = true; }
  catch (error) { if (!error || typeof error !== "object" || !("code" in error) || !["ERR_PACKAGE_PATH_NOT_EXPORTED", "MODULE_NOT_FOUND"].includes(String(error.code))) throw error; }
  if (reachable) throw new Error("New V2 export reachable from old175 graph");
  const journal = JSON.parse(await readFile(resolve(root, "packages/database/migrations/meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  if (journal.entries.length !== 175 || journal.entries.at(-1)?.tag !== "0175_agent_native") throw new Error("Real175 migration prefix required");
}
export async function migrateAgentNativeV2LegacyDatabase(database: DatabaseConnection, name: string, environment: NodeJS.ProcessEnv) {
  const target = requireAgentNativeV2LegacyEnvironment(environment, "pre-0176"); if (target.name !== name) throw new Error("Original175 database identity mismatch");
  await assertAgentNativeV2Original175Graph(target.root);
  const [actual] = await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== name || actual.ledger !== null || actual.populated !== false) throw new Error("Original175 migration refuses populated or foreign database");
  const require = createRequire(pathToFileURL(resolve(target.root, "packages/database/package.json")));
  const { readMigrationFiles } = require("drizzle-orm/migrator") as { readMigrationFiles(input: { migrationsFolder: string }): Array<{ folderMillis: number; sql: string[]; hash: string }> };
  const migrations = readMigrationFiles({ migrationsFolder: resolve(target.root, "packages/database/migrations") }); if (migrations.length !== 175) throw new Error("Real175 source required");
  await database.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))"); await tx.unsafe("create schema drizzle");
    await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) { for (const statement of migration.sql) await tx.unsafe(statement); await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]); }
  });
}

/** The old tree creates all four states using its actual provider checkpoint.
 * Exit after the authenticated response emulates a crash before adoption. */
async function seedOriginal175() {
  const send = (value: object) => new Promise<void>((done, reject) => {
    if (!process.connected || !process.send) { done(); return; }
    process.send(value, error => error ? reject(error) : done());
  });
  const cleanup: Array<() => Promise<unknown> | void> = []; let phase = "original175_entry", failure: unknown, crash = false;
  try {
    phase = "original175_environment"; const target = requireAgentNativeV2LegacyEnvironment(process.env, "current");
    phase = "original175_parent";
    if (!process.connected || process.env.E2E_AGENT_NATIVE_V2_LEGACY_CHILD !== "175") throw new Error("Original175 seed requires its IPC parent");
    phase = "original175_graph";
    await assertAgentNativeV2Original175Graph(target.root); const require = createRequire(pathToFileURL(resolve(target.root, "apps/api/package.json"))); require("reflect-metadata");
    phase = "original175_imports";
    const load = (path: string) => import(pathToFileURL(resolve(target.root, path)).href);
    const d = await load("packages/database/src/index.ts") as typeof OriginalDatabase, fixtures = await load("apps/api/src/ai/agent-native.test-fixture.ts") as typeof OriginalFixture;
    const services = await load("apps/api/src/ai/agent-native.service.ts") as typeof OriginalService, dispatch = await load("apps/api/src/ai/redis-agent-plan-dispatcher.ts") as typeof OriginalDispatcher;
    const core = await load("packages/ai-core/src/index.ts") as typeof OriginalCore, jobs = await load("packages/jobs/src/index.ts") as typeof OriginalJobs;
    const commands = await load("packages/contracts/src/ai/agent-command.ts") as typeof OriginalCommands;
    phase = "original175_schema"; const database = d.connectDatabase(target.url); cleanup.unshift(() => database.client.end()); await d.assertDatabaseMigrationsCurrent(database);
    if ((await d.readMigrationEvidence(database)).actualRows.length !== 175) throw new Error("Actual175 schema required");
    const vault = core.createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist"), f = fixtures.agentNativeFixture(database, { contentVault: vault }); cleanup.unshift(() => f.close());
    phase = "original175_initialize"; await f.initialize(); const context = await f.base.current(f.base.a);
    phase = "original175_sources"; const source = await f.source();
    const dispatcher = new dispatch.RedisAgentPlanDispatcher(); cleanup.unshift(() => dispatcher.onModuleDestroy());
    const service = new services.AgentNativeService(database, vault, f.gateway, f.owners.service(), f.owners.adapter, dispatcher);
    const queue = jobs.createQueue(jobs.QueueName.AgentPlan, process.env.E2E_DISPOSABLE_REDIS_URL); cleanup.unshift(() => queue.close());
    const jobId = async (id: string) => { const found = (await queue.getJobs(["wait", "delayed", "active", "completed", "failed", "paused"], 0, -1))
      .find(job => job.data?.payload?.runId === id && job.data?.payload?.operation === "execute"); if (!found?.id) throw new Error("Actual175 Redis execute envelope missing"); return found.id; };
    const binding = [source.bindings[1]!]; f.controls.decision = packet => fixtures.nativeSequence(packet, [source.requisition], source.query);
    const completedInput = await f.request(f.base.a, { bindings: binding, allowedCommands: [{ domain: "procurement", kind: "requisition_create" }] });
    phase = "original175_real_read_model_preparation"; const completed = await service.start(context, completedInput); await f.runtime().process(context, completed.id);
    let completedView = await service.get(context, completed.id); const proposal = completedView.result?.proposals[0];
    if (completedView.status !== "completed" || !proposal?.draft.original) throw new Error("Real175 completed proposal missing");
    const staged = await service.prepareItem(context, completed.id, proposal.id, f.prepareInput(completedView, proposal));
    if (staged.disposition !== "known" || !staged.agentCommandId || !staged.ownerCommandId) throw new Error("Real175 prepared command missing");
    phase = "original175_completed_receipt"; const preparedInput = commands.PrepareAgentCommandSchema.parse({ version: commands.AGENT_COMMAND_VERSION, requestId: proposal.id, original: proposal.draft.original });
    const prepared = await f.owners.service().get(context, staged.agentCommandId), preparedReceipt = await f.owners.service().receipt(context, { requestId: proposal.id, requestChecksum: proposal.preparationRequestChecksum });
    completedView = await service.get(context, completed.id); f.controls.decision = packet => fixtures.finishNative(packet);
    const queuedInput = await f.request(f.base.a, { bindings: binding }), queued = await service.start(context, queuedInput);
    const uncertainInput = await f.request(f.base.a, { bindings: binding }), uncertain = await service.start(context, uncertainInput);
    f.controls.beforeModel = async () => { throw new TypeError("Synthetic original175 submitted response lost"); };
    phase = "original175_submitted_unknown"; try { await f.runtime().process(context, uncertain.id); } finally { f.controls.beforeModel = undefined; }
    const uncertainView = await service.get(context, uncertain.id); if (uncertainView.status !== "uncertain") throw new Error("Actual175 unknown phase missing");
    const receivedInput = await f.request(f.base.a, { bindings: binding }), received = await service.start(context, receivedInput);
    let notify!: () => void; const saved = new Promise<void>(done => { notify = done; });
    f.controls.afterCheckpoint = async () => { notify(); await new Promise<void>(() => {}); };
    phase = "original175_received_before_adoption"; const processing = f.runtime().process(context, received.id);
    await Promise.race([saved, processing.then(() => { throw new Error("Actual175 response was unexpectedly adopted"); })]);
    const receivedView = await service.get(context, received.id);
    if (receivedView.steps.at(-1)?.phase !== "response_ready" || receivedView.steps.at(-1)?.submissionState !== "received") throw new Error("Actual175 response checkpoint missing");
    phase = "original175_seeded_receipt"; await send({ type: "agent.native.v2.seeded175", context, natives: [
      { state: "completed", input: completedInput, view: completedView, queueJobId: await jobId(completed.id) },
      { state: "queued", input: queuedInput, view: await service.get(context, queued.id), queueJobId: await jobId(queued.id) },
      { state: "response_ready", input: receivedInput, view: receivedView, queueJobId: await jobId(received.id) },
      { state: "uncertain", input: uncertainInput, view: uncertainView, queueJobId: await jobId(uncertain.id) },
    ], commandContext: context, preparedInput, prepared, preparedReceipt, originalModelCalls: f.modelCalls.length }); crash = true;
  } catch (error) { failure = error; await send(agentNativeV2LegacyDiagnostic(error, phase)); }
  const errors: unknown[] = []; for (const done of cleanup) try { await done(); } catch (error) { errors.push(error); }
  if (errors.length) await send(agentNativeV2LegacyDiagnostic(new AggregateError(errors), "original175_cleanup"));
  if (failure !== undefined || errors.length) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...errors], "Original175 seed or cleanup failed");
  if (crash) process.exit(0);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await seedOriginal175(); } catch (error) {
    if (process.connected && process.send && !(error instanceof AggregateError)) await new Promise<void>(done => {
      process.send!(agentNativeV2LegacyDiagnostic(error, "original175_unhandled"), () => done());
    });
    process.exitCode = 1;
  }
}
