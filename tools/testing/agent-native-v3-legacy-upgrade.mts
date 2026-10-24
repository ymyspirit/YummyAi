import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "../../packages/database/src/client.js";
import type * as OriginalDatabase from "../../packages/database/src/index.js";
import type * as OriginalFixture from "../../apps/api/src/ai/agent-native-v2.test-fixture.js";
import type * as OriginalService from "../../apps/api/src/ai/agent-native-v2.service.js";
import type * as OriginalDispatcher from "../../apps/api/src/ai/redis-agent-plan-dispatcher.js";
import type * as OriginalCore from "../../packages/ai-core/src/index.js";
import type * as OriginalJobs from "../../packages/jobs/src/index.js";
import type * as OriginalCommands from "../../packages/contracts/src/ai/agent-command.js";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

const workspace = fileURLToPath(new URL("../../", import.meta.url)), prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-22-agent-native-v3-3f7a21d8");
const expectedRoot = resolve(workspace, "tmp/agent-native-v3-20261022-3f7a21d8/old176-source");
const diagnosticPhases = new Set(["original176_entry", "original176_environment", "original176_parent", "original176_graph", "original176_imports",
  "original176_schema", "original176_initialize", "original176_sources", "original176_real_read_model_preparation", "original176_completed_receipt",
  "original176_submitted_unknown", "original176_received_before_adoption", "original176_seeded_receipt", "original176_cleanup", "original176_unhandled"]);
const diagnosticNames = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AggregateError", "ZodError", "PostgresError", "DatabaseError",
  "ConflictException", "ForbiddenError", "ForbiddenException", "NotFoundException", "BadRequestException", "UnauthorizedException"]);
const diagnosticCode = /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/;
/** Deliberately excludes error messages, SQL, environment values and raw stacks. */
export function agentNativeV3LegacyDiagnostic(error: unknown, phase: string) {
  let code: string | null = null, location: { file: string; line: number } | null = null, cause = error;
  for (let depth = 0; depth < 7 && cause && typeof cause === "object"; depth++) {
    if ("code" in cause && typeof cause.code === "string" && diagnosticCode.test(cause.code)) code ??= cause.code;
    if (!location && "stack" in cause && typeof cause.stack === "string") for (const line of cause.stack.split(/\r?\n/).slice(1, 12)) {
      const match = /((?:file:\/\/\/)?[A-Za-z]:[\\/][^()\r\n]*?\.[cm]?[jt]sx?):([1-9][0-9]*):[0-9]+\)?$/.exec(line.trim());
      if (!match) continue;
      try { const absolute = match[1]!.startsWith("file:") ? fileURLToPath(match[1]!) : match[1]!;
        const file = relative(workspace, absolute).replaceAll("\\", "/"), number = Number(match[2]);
        if (!isAbsolute(file) && !file.startsWith("../") && /^(?:(?:apps|packages|tools)\/|tmp\/agent-native-v3-20261022-3f7a21d8\/old176-source\/(?:apps|packages|tools)\/)[A-Za-z0-9_./-]+\.[cm]?[jt]sx?$/.test(file)
          && Number.isSafeInteger(number) && number > 0) { location = { file, line: number }; break; }
      } catch { /* An unrecognized stack location is not a diagnostic field. */ }
    }
    cause = "cause" in cause ? cause.cause : null;
  }
  return { type: "agent.native.v3.failed" as const, phase: diagnosticPhases.has(phase) ? phase : "original176_unhandled", code,
    errorName: error instanceof Error && diagnosticNames.has(error.name) ? error.name : "Error", location };
}
const flags = ["E2E_AGENT_NATIVE_V3_ISOLATED", "E2E_AGENT_FULFILLMENT_ISOLATED", "E2E_FACTORY_ERP_IMPORT_ISOLATED", "E2E_AGENT_NATIVE_V2_ISOLATED", "E2E_AGENT_RESOURCES_ISOLATED", "E2E_AGENT_MCP_ISOLATED", "E2E_AGENT_NATIVE_ISOLATED", "E2E_AGENT_TOOLS_ISOLATED",
  "E2E_AGENT_PLAN_ISOLATED", "E2E_AGENT_LOOP_ISOLATED", "E2E_AGENT_COMMAND_ISOLATED", "E2E_AGENT_READ_ISOLATED", "E2E_ROLE_BENCHMARK_ISOLATED",
  "E2E_BUSINESS_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_EVALUATION_ISOLATED", "E2E_ISOLATED_DAILY"];
export function requireAgentNativeV3LegacyEnvironment(environment: NodeJS.ProcessEnv, target: "pre-0177" | "current") {
  const url = new URL(requireDisposableIntegrationEnvironment(environment)), root = environment.E2E_AGENT_NATIVE_V3_LEGACY_SOURCE;
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1], redis = environment.E2E_DISPOSABLE_REDIS_URL, local = ["localhost", "127.0.0.1", "[::1]"];
  if (!nonce || flags.some(key => environment[key] !== "1") || environment.E2E_LEGACY_SCHEMA_TARGET !== target || !root || !isAbsolute(root) || resolve(root) !== expectedRoot ||
    !local.includes(url.hostname) || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !redis || environment.REDIS_URL !== redis ||
    environment.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` || !["redis:", "rediss:"].includes(new URL(redis).protocol) || !local.includes(new URL(redis).hostname))
    throw new Error("NativeV3 upgrade requires exact original176 source and every isolated nonce resource before connection");
  return { root: resolve(root), url: url.href, name: url.pathname.slice(1), nonce };
}
export async function assertAgentNativeV3Original176Graph(root: string) {
  if (resolve(root) !== expectedRoot) throw new Error("Original176 source identity mismatch");
  const source = JSON.parse(await readFile(prefix + "-source-before.json", "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
  const graph = JSON.parse(await readFile(prefix + "-old176-source.json", "utf8")) as { operation: string; sourceRoot: string; sourceFiles: number; sourceSha256: string;
    workspaceDependenciesPinned: boolean; newNativeV3ExportReachable: boolean; links: Array<{ path: string; target: string }> };
  if (source.files.length !== 3384 || source.sha256 !== "4b382f6c5258afbf8dadba128678bd9dd70925e3d7b71f65351aa51d3e48215b" || graph.operation !== "3f7a21d8" ||
    resolve(graph.sourceRoot) !== expectedRoot || graph.sourceFiles !== source.files.length || graph.sourceSha256 !== source.sha256 || graph.links.length !== 389 ||
    !graph.workspaceDependenciesPinned || graph.newNativeV3ExportReachable) throw new Error("Original176 protected source manifest mismatch");
  for (const file of source.files) if (createHash("sha256").update(await readFile(resolve(root, file.path))).digest("hex") !== file.sha256)
    throw new Error("Original176 source byte mismatch: " + file.path);
  for (const link of graph.links) if (await realpath(link.path) !== await realpath(link.target)) throw new Error("Original176 dependency graph mismatch");
  const runtime = JSON.parse(await readFile(prefix + "-old176-native-runtime.json", "utf8")) as {
    operation: string; status: string; originalRuntimeIntegrityChecksPreserved: boolean; configuredBinaryOverrideUsed: boolean;
    oldAndCurrentLockSha256: string; sharedTarget: string; ownedLink: string; files: Array<{ name: string; bytes: number; sha256: string }>;
  };
  const runtimeRelative = ".artifacts/runtime-tools/imagemagick-7.1.2-34-q16-hdri-x64";
  if (runtime.operation !== "3f7a21d8" || runtime.status !== "pass" || !runtime.originalRuntimeIntegrityChecksPreserved || runtime.configuredBinaryOverrideUsed ||
    runtime.files.length !== 23 || resolve(runtime.ownedLink) !== resolve(root, runtimeRelative) || resolve(runtime.sharedTarget) !== resolve(workspace, runtimeRelative) ||
    await realpath(runtime.ownedLink) !== await realpath(runtime.sharedTarget) || runtime.oldAndCurrentLockSha256 !== "50cd91b42028c42cf9ea8c80374615811ffbc04802716d900ca32794bcd54ca7")
    throw new Error("Original176 locked native runtime identity mismatch");
  for (const file of runtime.files) {
    if (!/^[A-Za-z0-9_.-]+$/.test(file.name)) throw new Error("Original176 native runtime filename invalid");
    const bytes = await readFile(resolve(runtime.ownedLink, file.name));
    if (bytes.byteLength !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256)
      throw new Error("Original176 locked native runtime byte mismatch");
  }
  const require = createRequire(pathToFileURL(resolve(root, "apps/api/package.json")));
  for (const name of ["contracts", "database", "ai-core", "authz", "jobs", "storage", "workflow-core", "catalog-core", "knowledge-core", "pod-core", "order-core"])
    if (await realpath(resolve(root, "apps/api/node_modules/@yummyai", name)) !== await realpath(resolve(root, "packages", name))) throw new Error("Original176 workspace escaped: " + name);
  let reachable = false; try { require.resolve("@yummyai/contracts/ai/agent-native-v3"); reachable = true; }
  catch (error) { if (!error || typeof error !== "object" || !("code" in error) || !["ERR_PACKAGE_PATH_NOT_EXPORTED", "MODULE_NOT_FOUND"].includes(String(error.code))) throw error; }
  if (reachable) throw new Error("New V3 export reachable from old176 graph");
  const journal = JSON.parse(await readFile(resolve(root, "packages/database/migrations/meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  if (journal.entries.length !== 176 || journal.entries.at(-1)?.tag !== "0176_agent_native_v2") throw new Error("Real176 migration prefix required");
}
export async function migrateAgentNativeV3LegacyDatabase(database: DatabaseConnection, name: string, environment: NodeJS.ProcessEnv) {
  const target = requireAgentNativeV3LegacyEnvironment(environment, "pre-0177"); if (target.name !== name) throw new Error("Original176 database identity mismatch");
  await assertAgentNativeV3Original176Graph(target.root);
  const [actual] = await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== name || actual.ledger !== null || actual.populated !== false) throw new Error("Original176 migration refuses populated or foreign database");
  const require = createRequire(pathToFileURL(resolve(target.root, "packages/database/package.json")));
  const { readMigrationFiles } = require("drizzle-orm/migrator") as { readMigrationFiles(input: { migrationsFolder: string }): Array<{ folderMillis: number; sql: string[]; hash: string }> };
  const migrations = readMigrationFiles({ migrationsFolder: resolve(target.root, "packages/database/migrations") }); if (migrations.length !== 176) throw new Error("Real176 source required");
  await database.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))"); await tx.unsafe("create schema drizzle");
    await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) { for (const statement of migration.sql) await tx.unsafe(statement); await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]); }
  });
}

/** The old tree creates all four states using its actual provider checkpoint.
 * Exit after the authenticated response emulates a crash before adoption. */
async function seedOriginal176() {
  const send = (value: object) => new Promise<void>((done, reject) => {
    if (!process.connected || !process.send) { done(); return; }
    process.send(value, error => error ? reject(error) : done());
  });
  const cleanup: Array<() => Promise<unknown> | void> = []; let phase = "original176_entry", failure: unknown, crash = false;
  try {
    phase = "original176_environment"; const target = requireAgentNativeV3LegacyEnvironment(process.env, "current");
    phase = "original176_parent";
    if (!process.connected || process.env.E2E_AGENT_NATIVE_V3_LEGACY_CHILD !== "176") throw new Error("Original176 seed requires its IPC parent");
    phase = "original176_graph";
    await assertAgentNativeV3Original176Graph(target.root); const require = createRequire(pathToFileURL(resolve(target.root, "apps/api/package.json"))); require("reflect-metadata");
    phase = "original176_imports";
    const load = (path: string) => import(pathToFileURL(resolve(target.root, path)).href);
    const d = await load("packages/database/src/index.ts") as typeof OriginalDatabase, fixtures = await load("apps/api/src/ai/agent-native-v2.test-fixture.ts") as typeof OriginalFixture;
    const services = await load("apps/api/src/ai/agent-native-v2.service.ts") as typeof OriginalService, dispatch = await load("apps/api/src/ai/redis-agent-plan-dispatcher.ts") as typeof OriginalDispatcher;
    const core = await load("packages/ai-core/src/index.ts") as typeof OriginalCore, jobs = await load("packages/jobs/src/index.ts") as typeof OriginalJobs;
    const commands = await load("packages/contracts/src/ai/agent-command.ts") as typeof OriginalCommands;
    phase = "original176_schema"; const database = d.connectDatabase(target.url); cleanup.unshift(() => database.client.end()); await d.assertDatabaseMigrationsCurrent(database);
    if ((await d.readMigrationEvidence(database)).actualRows.length !== 176) throw new Error("Actual176 schema required");
    const vault = core.createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist"), f = fixtures.agentNativeV2Fixture(database, { contentVault: vault }); cleanup.unshift(() => f.close());
    phase = "original176_initialize"; await f.initialize(); const context = await f.base.current(f.base.a);
    phase = "original176_sources"; const source = await f.seed();
    const dispatcher = new dispatch.RedisAgentPlanDispatcher(); cleanup.unshift(() => dispatcher.onModuleDestroy());
    const service = new services.AgentNativeV2Service(database, vault, f.legacy.gateway, f.resources.service, f.legacy.owners.service(), f.legacy.owners.adapter, dispatcher);
    const queue = jobs.createQueue(jobs.QueueName.AgentPlan, process.env.E2E_DISPOSABLE_REDIS_URL); cleanup.unshift(() => queue.close());
    const jobId = async (id: string) => { const found = (await queue.getJobs(["wait", "delayed", "active", "completed", "failed", "paused"], 0, -1))
      .find(job => job.data?.payload?.runId === id && job.data?.payload?.operation === "execute"); if (!found?.id) throw new Error("Actual176 Redis execute envelope missing"); return found.id; };
    const binding = [source.bindings[1]!]; f.controls.decision = packet => fixtures.nativeV2Sequence(packet, [source.originals[0]!], source.query);
    const completedInput = await f.request(f.base.a, { bindings: binding, allowedCommands: [{ domain: "procurement", kind: "requisition_create" }] });
    phase = "original176_real_read_model_preparation"; const completed = await service.start(context, completedInput); await f.runtime().process(context, completed.id);
    let completedView = await service.get(context, completed.id); const proposal = completedView.result?.proposals[0];
    if (completedView.status !== "completed" || !proposal?.draft.original) throw new Error("Real176 completed proposal missing");
    const staged = await service.prepareItem(context, completed.id, proposal.id, f.prepareInput(completedView, proposal));
    if (staged.disposition !== "known" || !staged.agentCommandId || !staged.ownerCommandId) throw new Error("Real176 prepared command missing");
    phase = "original176_completed_receipt"; const preparedInput = commands.PrepareAgentCommandSchema.parse({ version: commands.AGENT_COMMAND_VERSION, requestId: proposal.id, original: proposal.draft.original });
    const prepared = await f.legacy.owners.service().get(context, staged.agentCommandId), preparedReceipt = await f.legacy.owners.service().receipt(context, { requestId: proposal.id, requestChecksum: proposal.preparationRequestChecksum });
    completedView = await service.get(context, completed.id); f.controls.decision = packet => fixtures.finishNativeV2(packet);
    const queuedInput = await f.request(f.base.a, { bindings: binding }), queued = await service.start(context, queuedInput);
    const uncertainInput = await f.request(f.base.a, { bindings: binding }), uncertain = await service.start(context, uncertainInput);
    f.controls.beforeModel = async () => { throw new TypeError("Synthetic original176 submitted response lost"); };
    phase = "original176_submitted_unknown"; try { await f.runtime().process(context, uncertain.id); } finally { f.controls.beforeModel = undefined; }
    const uncertainView = await service.get(context, uncertain.id); if (uncertainView.status !== "uncertain") throw new Error("Actual176 unknown phase missing");
    const receivedInput = await f.request(f.base.a, { bindings: binding }), received = await service.start(context, receivedInput);
    let notify!: () => void; const saved = new Promise<void>(done => { notify = done; });
    f.controls.afterCheckpoint = async () => { notify(); await new Promise<void>(() => {}); };
    phase = "original176_received_before_adoption"; const processing = f.runtime().process(context, received.id);
    await Promise.race([saved, processing.then(() => { throw new Error("Actual176 response was unexpectedly adopted"); })]);
    const receivedView = await service.get(context, received.id);
    if (receivedView.steps.at(-1)?.phase !== "response_ready" || receivedView.steps.at(-1)?.submissionState !== "received") throw new Error("Actual176 response checkpoint missing");
    phase = "original176_seeded_receipt"; await send({ type: "agent.native.v3.seeded176", context, natives: [
      { state: "completed", input: completedInput, view: completedView, queueJobId: await jobId(completed.id) },
      { state: "queued", input: queuedInput, view: await service.get(context, queued.id), queueJobId: await jobId(queued.id) },
      { state: "response_ready", input: receivedInput, view: receivedView, queueJobId: await jobId(received.id) },
      { state: "uncertain", input: uncertainInput, view: uncertainView, queueJobId: await jobId(uncertain.id) },
    ], commandContext: context, preparedInput, prepared, preparedReceipt, originalModelCalls: f.modelCalls.length }); crash = true;
  } catch (error) { failure = error; await send(agentNativeV3LegacyDiagnostic(error, phase)); }
  const errors: unknown[] = []; for (const done of cleanup) try { await done(); } catch (error) { errors.push(error); }
  if (errors.length) await send(agentNativeV3LegacyDiagnostic(new AggregateError(errors), "original176_cleanup"));
  if (failure !== undefined || errors.length) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...errors], "Original176 seed or cleanup failed");
  if (crash) process.exit(0);
}
/** The recovery child starts with an explicit current environment. Neither
 * parent nor historical fixture process.env is changed to bypass its guard. */
async function recoverOriginal176() {
  let phase = "original176_environment", failure: unknown; const cleanup: Array<() => Promise<unknown> | void> = [];
  try {
    const target = requireAgentNativeV3LegacyEnvironment(process.env, "current");
    if (!process.connected || process.env.E2E_AGENT_NATIVE_V3_LEGACY_CHILD !== "recover176") throw new Error("Original176 recovery requires its IPC parent");
    phase = "original176_graph"; await assertAgentNativeV3Original176Graph(target.root);
    const load = (path: string) => import(pathToFileURL(resolve(workspace, path)).href);
    const d = await load("packages/database/src/index.ts") as typeof OriginalDatabase, fixtures = await load("apps/api/src/ai/agent-native-v2.test-fixture.ts") as typeof OriginalFixture;
    const core = await load("packages/ai-core/src/index.ts") as typeof OriginalCore, jobs = await load("packages/jobs/src/index.ts") as typeof OriginalJobs;
    const transport = await load("packages/contracts/src/ai/agent-native-v2.ts") as typeof import("../../packages/contracts/src/ai/agent-native-v2.js");
    const commands = await load("packages/contracts/src/ai/agent-command.ts") as typeof OriginalCommands;
    const shared = await load("packages/contracts/src/index.ts") as typeof import("../../packages/contracts/src/index.js");
    const localRequire = createRequire(pathToFileURL(resolve(workspace, "apps/api/package.json")));
    const { z } = localRequire("zod") as typeof import("../../apps/api/node_modules/zod/index.js");
    const incoming = new Promise<unknown>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error("Original176 recovery IPC timeout")), 30_000);
      process.once("message", value => { clearTimeout(timer); accept(value); });
    });
    await new Promise<void>((done, reject) => process.send!({ type: "agent.native.v3.recovery.ready" }, error => error ? reject(error) : done()));
    const packet = z.object({ context: shared.TenantContextSchema,
      natives: z.array(z.object({ state: z.enum(["completed", "queued", "response_ready", "uncertain"]), input: transport.CreateAgentNativeV2Schema,
        view: transport.AgentNativeV2ViewSchema, queueJobId: z.string().min(1) }).strict()).length(4), commandContext: shared.TenantContextSchema,
      prepared: commands.AgentCommandViewSchema, preparedReceipt: commands.AgentCommandReceiptSchema }).strict().parse(await incoming);
    phase = "original176_schema"; const database = d.connectDatabase(target.url); cleanup.unshift(() => database.client.end()); await d.assertDatabaseMigrationsCurrent(database);
    if ((await d.readMigrationEvidence(database)).actualRows.length !== 177) throw new Error("Actual177 recovery schema required");
    const vault = core.createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist"), f = fixtures.agentNativeV2Fixture(database, { contentVault: vault });
    cleanup.unshift(() => f.close()); f.controls.decision = value => fixtures.finishNativeV2(value);
    const queue = jobs.createQueue(jobs.QueueName.AgentPlan, process.env.E2E_DISPOSABLE_REDIS_URL); cleanup.unshift(() => queue.close());
    const router = await load("apps/worker/src/agent-plan-runtime-router.ts") as typeof import("../../apps/worker/src/agent-plan-runtime-router.js");
    const worker = await load("apps/worker/src/processors/agent-plan.processor.ts") as typeof import("../../apps/worker/src/processors/agent-plan.processor.js");
    const processor = new worker.AgentPlanProcessor(router.agentPlanRuntimeRouter(database, f.legacy.prior.runtime(), f.legacy.runtime(), f.runtime(),
      { async process() { throw new Error("genuine_v2_job_misrouted_to_v3"); } }));
    const originalJobs: Array<{ id: string; runId: string; tenantId: string; requestedBy: string }> = [];
    const originalJob = async (value: (typeof packet.natives)[number]) => {
      const job = await queue.getJob(value.queueJobId); if (!job) throw new Error("Actual original176 Redis execute job missing");
      const envelope = jobs.JobEnvelopeSchema.parse(job.data), payload = z.object({ runId: z.uuidv7(), operation: z.enum(["execute", "expire"]).default("execute") }).strict().parse(envelope.payload);
      if (envelope.tenantId !== packet.context.tenantId || envelope.requestedBy !== packet.context.userId || payload.runId !== value.view.id || payload.operation !== "execute")
        throw new Error("Actual original176 Redis envelope changed");
      originalJobs.push({ id: job.id!, runId: value.view.id, tenantId: envelope.tenantId, requestedBy: envelope.requestedBy }); return processor.process(envelope);
    };
    phase = "original176_completed_receipt";
    const completed = packet.natives.find(value => value.state === "completed")!, unknown = packet.natives.find(value => value.state === "uncertain")!,
      received = packet.natives.find(value => value.state === "response_ready")!, queued = packet.natives.find(value => value.state === "queued")!;
    const completedView = await f.service().get(packet.context, completed.view.id), command = await f.legacy.owners.service().get(packet.commandContext, packet.prepared.id),
      commandReceipt = await f.legacy.owners.service().receipt(packet.commandContext, { requestId: packet.preparedReceipt.requestId, requestChecksum: packet.preparedReceipt.requestChecksum });
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const beforeUnknown = await f.rows(packet.context); await originalJob(unknown); const afterUnknown = await f.rows(packet.context), afterUnknownCalls = f.modelCalls.length;
    const response = beforeUnknown.steps.find(value => value.runId === received.view.id)!;
    await d.withTenant(database.db, packet.context, tx => tx.execute((requireSql())`update agent_plan_runs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${received.view.id}::uuid`));
    phase = "original176_received_before_adoption"; await originalJob(received); const receivedView = await f.service().get(packet.context, received.view.id), afterReceivedCalls = f.modelCalls.length;
    phase = "original176_real_read_model_preparation"; await originalJob(queued); const queuedView = await f.service().get(packet.context, queued.view.id), afterQueuedCalls = f.modelCalls.length;
    const beforeReplay = await f.rows(packet.context); await originalJob(received); await originalJob(queued); const afterReplay = await f.rows(packet.context);
    const uncertainView = await f.service().get(packet.context, unknown.view.id), responseAfter = afterReplay.steps.find(value => value.id === response.id)!;
    const unknownParent = afterReplay.runs.find(value => value.id === unknown.view.id)!, unknownLedger = afterReplay.ledgers.find(value => value.id === unknownParent.budgetLedgerId)!;
    phase = "original176_seeded_receipt";
    await new Promise<void>((done, reject) => process.send!({ type: "agent.native.v3.recovered176", completedView, uncertainView, receivedView, queuedView, command, commandReceipt,
      modelCalls: { afterUnknown: afterUnknownCalls, afterReceived: afterReceivedCalls, afterQueued: afterQueuedCalls, afterReplays: f.modelCalls.length },
      unknownRows: { before: digest(beforeUnknown), after: digest(afterUnknown) }, replayRows: { before: digest(beforeReplay), after: digest(afterReplay) },
      responseChecksum: { before: response.responseChecksum, after: responseAfter.responseChecksum }, unknownLedger: { state: unknownLedger.state, amountUsd: unknownLedger.amountUsd },
      versions: afterReplay.runs.map(value => value.version), originalJobs,
    }, error => error ? reject(error) : done()));
  } catch (error) {
    failure = error; process.send?.(agentNativeV3LegacyDiagnostic(error, phase));
  }
  const errors: unknown[] = []; for (const done of cleanup) try { await done(); } catch (error) { errors.push(error); }
  if (errors.length) process.send?.(agentNativeV3LegacyDiagnostic(new AggregateError(errors), "original176_cleanup"));
  if (failure !== undefined || errors.length) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...errors], "Original176 recovery failed or cleanup incomplete");
}
function requireSql() {
  const require = createRequire(pathToFileURL(resolve(workspace, "packages/database/package.json")));
  return (require("drizzle-orm") as typeof import("../../apps/api/node_modules/drizzle-orm/index.js")).sql;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (process.env.E2E_AGENT_NATIVE_V3_LEGACY_CHILD === "recover176") { await recoverOriginal176(); if (process.connected) process.disconnect(); } else await seedOriginal176(); } catch (error) {
    if (process.connected && process.send && !(error instanceof AggregateError)) await new Promise<void>(done => {
      process.send!(agentNativeV3LegacyDiagnostic(error, "original176_unhandled"), () => done());
    });
    process.exitCode = 1;
  }
}
