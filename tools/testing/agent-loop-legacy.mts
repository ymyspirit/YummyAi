import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "../../packages/database/src/client.js";
import type * as OriginalDatabase from "../../packages/database/src/index.js";
import type * as OriginalFixture from "../../apps/api/src/ai/agent-read.test-fixture.js";
import type * as OriginalAssist from "../../apps/api/src/ai/assist.service.js";
import type * as OriginalQueue from "../../apps/api/src/ai/redis-assist-enqueuer.js";
import type * as OriginalJobs from "../../packages/jobs/src/index.js";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

const expectedRoot = fileURLToPath(new URL("../../tmp/agent-loop-20261022-68018aa3/old171-source", import.meta.url));
export function requireAgentLoopLegacyEnvironment(environment: NodeJS.ProcessEnv, target: "pre-0172" | "current") {
  const url = new URL(requireDisposableIntegrationEnvironment(environment)), root = environment.E2E_AGENT_LOOP_LEGACY_SOURCE;
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1], redis = environment.E2E_DISPOSABLE_REDIS_URL;
  const loopback = ["localhost", "127.0.0.1", "[::1]"];
  if (!nonce || environment.E2E_ISOLATED_DAILY !== "1" || environment.E2E_AGENT_LOOP_ISOLATED !== "1" || environment.E2E_AGENT_READ_ISOLATED !== "1" ||
    environment.E2E_LEGACY_SCHEMA_TARGET !== target || !root || !isAbsolute(root) || resolve(root) !== resolve(expectedRoot) || !loopback.includes(url.hostname) ||
    environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !redis || environment.REDIS_URL !== redis ||
    environment.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` || !["redis:", "rediss:"].includes(new URL(redis).protocol) || !loopback.includes(new URL(redis).hostname))
    throw new Error("Agent loop genuine171 requires the frozen source and exact isolated nonce database, bucket and Redis before connection");
  return { root: resolve(root), url: url.href, nonce, name: url.pathname.slice(1) };
}

export async function assertAgentLoopOriginal171Graph(root: string) {
  if (resolve(root) !== resolve(expectedRoot)) throw new Error("Agent loop original171 source identity differs");
  const oldRequire = createRequire(pathToFileURL(resolve(root, "apps/api/package.json")));
  for (const name of ["contracts", "database", "ai-core", "authz", "jobs", "storage", "workflow-core"]) {
    const actual = await realpath(resolve(root, "apps/api/node_modules/@yummyai", name));
    const expected = await realpath(resolve(root, "packages", name));
    if (actual !== expected) throw new Error("Agent loop original171 workspace dependency escaped: " + name);
  }
  const contract = oldRequire.resolve("@yummyai/contracts/ai/assist");
  if (!(await realpath(contract)).startsWith((await realpath(resolve(root, "packages/contracts"))) + "/") &&
    !(await realpath(contract)).startsWith((await realpath(resolve(root, "packages/contracts"))) + "\\"))
    throw new Error("Agent loop original171 contract resolution escaped");
  let newExport = false;
  try { oldRequire.resolve("@yummyai/contracts/ai/agent-loop"); newExport = true; } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || !["ERR_PACKAGE_PATH_NOT_EXPORTED", "MODULE_NOT_FOUND"].includes(String(error.code))) throw error;
  }
  if (newExport) throw new Error("Agent loop new172 export reached by original171 graph");
  const journal = JSON.parse(await readFile(resolve(root, "packages/database/migrations/meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  if (journal.entries.length !== 171 || !journal.entries.at(-1)?.tag.startsWith("0171_")) throw new Error("Agent loop original171 journal required");
}

export async function migrateAgentLoopLegacyDatabase(database: DatabaseConnection, name: string, environment: NodeJS.ProcessEnv) {
  const target = requireAgentLoopLegacyEnvironment(environment, "pre-0172"); if (target.name !== name) throw new Error("Agent loop legacy database identity mismatch");
  await assertAgentLoopOriginal171Graph(target.root);
  const [actual] = await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== name || actual.ledger !== null || actual.populated !== false) throw new Error("Agent loop legacy migration refuses populated or foreign database");
  const oldRequire = createRequire(pathToFileURL(resolve(target.root, "packages/database/package.json")));
  const { readMigrationFiles } = oldRequire("drizzle-orm/migrator") as { readMigrationFiles(value: { migrationsFolder: string }): Array<{ folderMillis: number; sql: string[]; hash: string }> };
  const migrations = readMigrationFiles({ migrationsFolder: resolve(target.root, "packages/database/migrations") });
  if (migrations.length !== 171) throw new Error("Agent loop genuine171 migration prefix required");
  await database.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    await tx.unsafe("create schema drizzle"); await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) {
      for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]);
    }
  });
}

async function seedOriginal171() {
  const target = requireAgentLoopLegacyEnvironment(process.env, "current");
  if (!process.connected || process.env.E2E_AGENT_LOOP_LEGACY_CHILD !== "171") throw new Error("Agent loop genuine171 seed requires its isolated IPC parent");
  const send = (value: object) => new Promise<void>((done, reject) => process.send!(value, error => error ? reject(error) : done()));
  let phase = "old171-graph", failure: unknown;
  const cleanup: Array<() => Promise<unknown> | void> = [];
  try {
    await assertAgentLoopOriginal171Graph(target.root);
    const load = (path: string) => import(pathToFileURL(resolve(target.root, path)).href);
    createRequire(pathToFileURL(resolve(target.root, "apps/api/package.json")))("reflect-metadata");
    phase = "old171-esm-modules";
    const d = await load("packages/database/src/index.ts") as typeof OriginalDatabase;
    const owner = await load("apps/api/src/ai/agent-read.test-fixture.ts") as typeof OriginalFixture;
    const assist = await load("apps/api/src/ai/assist.service.ts") as typeof OriginalAssist;
    const queueOwner = await load("apps/api/src/ai/redis-assist-enqueuer.ts") as typeof OriginalQueue;
    const jobs = await load("packages/jobs/src/index.ts") as typeof OriginalJobs;
    const database = d.connectDatabase(target.url); cleanup.unshift(() => database.client.end());
    await d.assertDatabaseMigrationsCurrent(database);
    if ((await d.readMigrationEvidence(database)).actualRows.length !== 171) throw new Error("Agent loop seed database is not original171");
    const f = owner.agentReadFixture(database); cleanup.unshift(() => f.close());
    phase = "old171-identity-provider"; await f.initialize();
    const enqueuer = new queueOwner.RedisAssistEnqueuer(); cleanup.unshift(() => enqueuer.onModuleDestroy());
    const service = new assist.AssistService(database, f.vault, f.contexts, enqueuer);
    const queue = jobs.createQueue(jobs.QueueName.AiAssist, process.env.E2E_DISPOSABLE_REDIS_URL); cleanup.unshift(() => queue.close());
    phase = "old171-real-native-create";
    const completedRequest = await f.knowledgeRequest(), queuedRequest = await f.knowledgeRequest(), unknownRequest = await f.knowledgeRequest();
    const completed = await service.create(f.a.context, completedRequest); await f.process(completed.id);
    const queued = await service.create(f.a.context, queuedRequest);
    const unknown = await service.create(f.a.context, unknownRequest);
    f.controls.beforeResponse = async () => { throw new DOMException("Synthetic original171 submitted response lost", "TimeoutError"); };
    try { await f.process(unknown.id); } finally { f.controls.beforeResponse = undefined; }
    phase = "old171-original-receipts";
    const completedView = await service.get(f.a.context, completed.id), queuedView = await service.get(f.a.context, queued.id), unknownView = await service.get(f.a.context, unknown.id);
    if (completedView.status !== "completed" || queuedView.status !== "queued" || unknownView.invocations?.[0]?.state !== "uncertain" || f.providerRequests.length !== 2)
      throw new Error("Agent loop actual171 native phases not established");
    const realJobs = await queue.getJobs(["wait", "delayed", "active", "completed", "failed", "paused"], 0, -1);
    const queuedAnalyze = realJobs.find(job => job.data?.payload?.runId === queued.id && job.data?.payload?.operation === "analyze");
    const unknownAnalyze = realJobs.find(job => job.data?.payload?.runId === unknown.id && job.data?.payload?.operation === "analyze");
    if (!queuedAnalyze?.id || !unknownAnalyze?.id) throw new Error("Agent loop original171 Redis analyze intents missing");
    await send({ type: "agent.loop.seeded171", context: f.a.context, modelId: f.modelId, completedRequest, queuedRequest, unknownRequest,
      completedView, queuedView, unknownView, queuedAnalyzeJobId: queuedAnalyze.id, unknownAnalyzeJobId: unknownAnalyze.id,
      realQueueJobIds: realJobs.map(job => job.id).sort(), originalProviderCalls: f.providerRequests.length });
  } catch (error) {
    failure = error; const codes: string[] = []; let current: unknown = error;
    for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
      if ("code" in current && typeof current.code === "string" && /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(current.code)) codes.push(current.code);
      current = "cause" in current ? current.cause : null;
    }
    await send({ type: "agent.loop.failed", phase, codes, errorName: error instanceof Error ? error.name : "Error" });
  }
  const failures: unknown[] = [];
  for (const close of cleanup) { try { await close(); } catch (error) { failures.push(error); } }
  if (failure !== undefined || failures.length) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...failures], "Original171 Agent loop fixture or cleanup failed");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await seedOriginal171();
