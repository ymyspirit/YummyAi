import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "../../packages/database/src/client.js";
import type * as OriginalDatabase from "../../packages/database/src/index.js";
import type * as OriginalLoop from "../../apps/api/src/ai/agent-loop.test-fixture.js";
import type * as OriginalLoopService from "../../apps/api/src/ai/agent-loop.service.js";
import type * as OriginalDispatcher from "../../apps/api/src/ai/redis-agent-loop-dispatcher.js";
import type * as OriginalProcurement from "../../apps/api/src/procurement/procurement-command.fixtures.js";
import type * as OriginalCommands from "../../apps/api/src/procurement/procurement-command.service.js";
import type * as OriginalVault from "../../apps/api/src/procurement/procurement-command-vault.js";
import type * as OriginalCore from "../../packages/ai-core/src/index.js";
import type * as OriginalJobs from "../../packages/jobs/src/index.js";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

const expectedRoot = fileURLToPath(new URL("../../tmp/agent-command-20261022-6f2d9a84/old172-source", import.meta.url));
export function requireAgentCommandLegacyEnvironment(environment: NodeJS.ProcessEnv, target: "pre-0173" | "current") {
  const url = new URL(requireDisposableIntegrationEnvironment(environment)), root = environment.E2E_AGENT_COMMAND_LEGACY_SOURCE;
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1], redis = environment.E2E_DISPOSABLE_REDIS_URL;
  const local = ["localhost", "127.0.0.1", "[::1]"];
  if (!nonce || environment.E2E_AGENT_COMMAND_ISOLATED !== "1" || environment.E2E_ISOLATED_DAILY !== "1" || environment.E2E_LEGACY_SCHEMA_TARGET !== target ||
    environment.E2E_AGENT_LOOP_ISOLATED !== "1" || environment.E2E_AGENT_READ_ISOLATED !== "1" || !root || !isAbsolute(root) || resolve(root) !== resolve(expectedRoot) ||
    !local.includes(url.hostname) || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !redis || environment.REDIS_URL !== redis ||
    environment.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` || !["redis:", "rediss:"].includes(new URL(redis).protocol) || !local.includes(new URL(redis).hostname))
    throw new Error("Agent command upgrade requires exact frozen172 source and every isolated nonce resource before connection");
  return { root: resolve(root), url: url.href, name: url.pathname.slice(1), nonce };
}
export async function assertAgentCommandOriginal172Graph(root: string) {
  if (resolve(root) !== resolve(expectedRoot)) throw new Error("Agent command old172 source identity differs");
  const require = createRequire(pathToFileURL(resolve(root, "apps/api/package.json")));
  for (const name of ["contracts", "database", "ai-core", "authz", "jobs", "storage", "workflow-core"])
    if (await realpath(resolve(root, "apps/api/node_modules/@yummyai", name)) !== await realpath(resolve(root, "packages", name)))
      throw new Error("Agent command old172 workspace dependency escaped: " + name);
  let reachable = false;
  try { require.resolve("@yummyai/contracts/ai/agent-command"); reachable = true; } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || !["ERR_PACKAGE_PATH_NOT_EXPORTED", "MODULE_NOT_FOUND"].includes(String(error.code))) throw error;
  }
  if (reachable) throw new Error("New173 command export reached from old172 graph");
  const journal = JSON.parse(await readFile(resolve(root, "packages/database/migrations/meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  if (journal.entries.length !== 172 || !journal.entries.at(-1)?.tag.startsWith("0172_")) throw new Error("Actual original172 migration journal required");
}
export async function migrateAgentCommandLegacyDatabase(database: DatabaseConnection, name: string, environment: NodeJS.ProcessEnv) {
  const target = requireAgentCommandLegacyEnvironment(environment, "pre-0173");
  if (target.name !== name) throw new Error("Agent command legacy database identity mismatch");
  await assertAgentCommandOriginal172Graph(target.root);
  const [actual] = await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== name || actual.ledger !== null || actual.populated !== false) throw new Error("Legacy migration refuses a populated or foreign database");
  const require = createRequire(pathToFileURL(resolve(target.root, "packages/database/package.json")));
  const { readMigrationFiles } = require("drizzle-orm/migrator") as { readMigrationFiles(input: { migrationsFolder: string }): Array<{ folderMillis: number; sql: string[]; hash: string }> };
  const migrations = readMigrationFiles({ migrationsFolder: resolve(target.root, "packages/database/migrations") });
  if (migrations.length !== 172) throw new Error("Real172 migration prefix required");
  await database.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    await tx.unsafe("create schema drizzle"); await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) {
      for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]);
    }
  });
}

async function seedOriginal172() {
  const target = requireAgentCommandLegacyEnvironment(process.env, "current");
  if (!process.connected || process.env.E2E_AGENT_COMMAND_LEGACY_CHILD !== "172") throw new Error("Genuine172 seed requires its exact IPC parent");
  const send = (value: object) => new Promise<void>((done, reject) => process.send!(value, error => error ? reject(error) : done()));
  const cleanup: Array<() => Promise<unknown> | void> = []; let phase = "graph", failure: unknown;
  try {
    await assertAgentCommandOriginal172Graph(target.root);
    const require = createRequire(pathToFileURL(resolve(target.root, "apps/api/package.json"))); require("reflect-metadata");
    const load = (path: string) => import(pathToFileURL(resolve(target.root, path)).href);
    phase = "old172-esm-modules";
    const d = await load("packages/database/src/index.ts") as typeof OriginalDatabase;
    const loopOwner = await load("apps/api/src/ai/agent-loop.test-fixture.ts") as typeof OriginalLoop;
    const loopService = await load("apps/api/src/ai/agent-loop.service.ts") as typeof OriginalLoopService;
    const dispatchModule = await load("apps/api/src/ai/redis-agent-loop-dispatcher.ts") as typeof OriginalDispatcher;
    const p = await load("apps/api/src/procurement/procurement-command.fixtures.ts") as typeof OriginalProcurement;
    const c = await load("apps/api/src/procurement/procurement-command.service.ts") as typeof OriginalCommands;
    const vaultModule = await load("apps/api/src/procurement/procurement-command-vault.ts") as typeof OriginalVault;
    const core = await load("packages/ai-core/src/index.ts") as typeof OriginalCore;
    const jobs = await load("packages/jobs/src/index.ts") as typeof OriginalJobs;
    const database = d.connectDatabase(target.url); cleanup.unshift(() => database.client.end());
    await d.assertDatabaseMigrationsCurrent(database);
    if ((await d.readMigrationEvidence(database)).actualRows.length !== 172) throw new Error("Seed must use genuine172 schema");
    const contentVault = core.createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist");
    const f = loopOwner.agentLoopFixture(database, { contentVault }); cleanup.unshift(() => f.close());
    phase = "old172-identity-provider"; await f.initialize();
    const dispatcher = new dispatchModule.RedisAgentLoopDispatcher(); cleanup.unshift(() => dispatcher.onModuleDestroy());
    const service = new loopService.AgentLoopService(database, contentVault, f.gateway, dispatcher);
    const completedInput = await f.request(), completed = await service.start(f.base.a.context, completedInput);
    phase = "old172-real-model-and-owner-read"; await f.runtime().process(f.base.a.context, completed.id);
    const unknownInput = await f.request(), unknown = await service.start(f.base.a.context, unknownInput);
    f.controls.beforeModel = async () => { throw new DOMException("Synthetic172 submitted response lost", "TimeoutError"); };
    try { await f.runtime().process(f.base.a.context, unknown.id); } finally { f.controls.beforeModel = undefined; }
    const completedView = await service.get(f.base.a.context, completed.id), unknownView = await service.get(f.base.a.context, unknown.id);
    if (completedView.status !== "completed" || unknownView.status !== "uncertain") throw new Error("Actual original172 terminal phases not established");
    const queue = jobs.createQueue(jobs.QueueName.AgentLoop, process.env.E2E_DISPOSABLE_REDIS_URL); cleanup.unshift(() => queue.close());
    const realJobs = await queue.getJobs(["wait", "delayed", "active", "completed", "failed", "paused"], 0, -1);
    const unknownJob = realJobs.find(job => job.data?.payload?.runId === unknown.id && job.data?.payload?.operation === "execute");
    if (!unknownJob?.id) throw new Error("Original172 real Redis execute intent missing");
    phase = "old172-native-business-originals";
    const source = p.procurementCommandFixture(database); await source.initialize();
    const commands = new c.ProcurementCommandService(database, vaultModule.createProcurementCommandVault(), source.owner, source.audit);
    const basis = await source.basis();
    const pending = await commands.prepare(source.context, { kind: "requisition_create", targetId: null, input: basis.requisitionInput });
    const prepared = await commands.prepare(source.context, { kind: "purchase_create", targetId: null, input: basis.purchaseInput });
    const succeeded = await commands.execute(source.context, prepared.id);
    await send({ type: "agent.command.seeded172", loopContext: f.base.a.context, completedInput, unknownInput, completedView, unknownView,
      commandContext: source.context, pending, succeeded, unknownQueueJobId: unknownJob.id, originalModelCalls: f.modelCalls.length });
  } catch (error) {
    failure = error; const codes: string[] = []; let cause: unknown = error;
    for (let i = 0; i < 6 && cause && typeof cause === "object"; i++) {
      if ("code" in cause && typeof cause.code === "string" && /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|ECONNREFUSED|ETIMEDOUT)$/.test(cause.code)) codes.push(cause.code);
      cause = "cause" in cause ? cause.cause : null;
    }
    await send({ type: "agent.command.failed", phase, codes, code: codes[0] ?? null, errorName: error instanceof Error ? error.name : "Error" });
  }
  const failures: unknown[] = [];
  for (const close of cleanup) try { await close(); } catch (error) { failures.push(error); }
  if (failures.length) await send({ type: "agent.command.failed", phase: "old172-cleanup", code: null, errorName: "AggregateError" });
  if (failure !== undefined || failures.length) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...failures], "Original172 seed or cleanup failed");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await seedOriginal172(); } catch { process.exitCode = 1; }
}
