import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "../../packages/database/src/client.js";
import type * as Database from "../../packages/database/src/index.js";
import type * as Knowledge from "./knowledge-benchmark-fixture.mjs";
import type * as Business from "./business-benchmark-fixture.mjs";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

export async function migrateRoleBenchmarkLegacyDatabase(database: DatabaseConnection, name: string, environment: NodeJS.ProcessEnv) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment)), nonce = /^order_daily_e2e_([a-f0-9]{32})$/.exec(name)?.[1];
  if (!nonce || url.pathname !== `/${name}` || environment.E2E_ROLE_BENCHMARK_ISOLATED !== "1" || environment.E2E_BUSINESS_BENCHMARK_ISOLATED !== "1" ||
      environment.E2E_KNOWLEDGE_BENCHMARK_ISOLATED !== "1" || environment.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" ||
      environment.E2E_LEGACY_SCHEMA_TARGET !== "pre-0170" || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Role benchmark legacy migration requires all flags and its exact fresh pre0170 nonce database and private bucket");
  const [actual] = await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== name || actual.ledger !== null || actual.populated !== false) throw new Error("Role benchmark legacy migration refuses a populated or different database");
  const requireDatabase = createRequire(new URL("../../packages/database/package.json", import.meta.url));
  const { readMigrationFiles } = requireDatabase("drizzle-orm/migrator");
  const folder = fileURLToPath(new URL("../../packages/database/migrations/", import.meta.url));
  const journal = JSON.parse(await readFile(new URL("../../packages/database/migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ tag: string; when: number }> };
  const target = journal.entries.filter(row => row.tag.startsWith("0170_"));
  if (target.length !== 1) throw new Error("Canonical170 role benchmark migration required");
  const migrations = (readMigrationFiles({ migrationsFolder: folder }) as Array<{ folderMillis: number; sql: string[]; hash: string }>).filter(row => row.folderMillis < target[0]!.when);
  if (migrations.length !== 169) throw new Error("Actual169 migration prefix required");
  await database.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    await tx.unsafe("create schema drizzle"); await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) { for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]); }
  });
}

async function seedActual169() {
  const url = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const root = process.env.E2E_ROLE_BENCHMARK_LEGACY_SOURCE;
  const expected = fileURLToPath(new URL("../../tmp/role-benchmark-20261021-b84f6d29/old169-source", import.meta.url));
  if (!process.connected || !nonce || process.env.E2E_ROLE_BENCHMARK_ISOLATED !== "1" || process.env.E2E_BUSINESS_BENCHMARK_ISOLATED !== "1" ||
      process.env.E2E_KNOWLEDGE_BENCHMARK_ISOLATED !== "1" || process.env.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" ||
      process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.E2E_ROLE_BENCHMARK_LEGACY_CHILD !== "169" ||
      process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !root || !isAbsolute(root) || resolve(root) !== resolve(expected))
    throw new Error("Actual169 IPC requires its pinned original ESM source and exact opt-in nonce database before import");
  const send = (value: object) => new Promise<void>((done, reject) => process.send!(value, error => error ? reject(error) : done()));
  let phase = "old169-esm-bootstrap", close = async () => {}, closeBusiness = () => {};
  try {
    const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
    createRequire(pathToFileURL(resolve(root, "apps/api/package.json")))("reflect-metadata");
    const db = await load("packages/database/src/index.ts") as typeof Database;
    const oldKnowledge = await load("tools/testing/knowledge-benchmark-fixture.mts") as typeof Knowledge;
    const oldBusiness = await load("tools/testing/business-benchmark-fixture.mts") as typeof Business;
    const database = db.connectDatabase(); close = () => database.client.end();
    if ((await db.readMigrationEvidence(database)).actualRows.length !== 169) throw new Error("Actual169 journal required");
    await db.assertDatabaseMigrationsCurrent(database);
    const knowledge = oldKnowledge.knowledgeBenchmarkFixture(database), business = oldBusiness.businessBenchmarkFixture(database);
    closeBusiness = business.close; await knowledge.initialize(); await business.initialize();
    phase = "old169-knowledge-manifest";
    const k = await knowledge.experiment(2), kStart = { itemId: k.version.items[0]!.id, expectedLatestAttemptId: null, confirmNewPaidAttempt: true as const, requestId: randomUUID() };
    const kDone = await knowledge.experiments.start(knowledge.a.context, k.created.id, kStart); await knowledge.complete(kDone.id, k.version);
    await knowledge.experiments.review(knowledge.a.context, kDone.id, { expectedReviewId: null, decision: "pass", minutes: "1.000", hourlyUsd: "60",
      reason: "Synthetic actual169 human review of original knowledge arithmetic", requestId: randomUUID() });
    const kPendingInput = { itemId: k.version.items[1]!.id, expectedLatestAttemptId: null, confirmNewPaidAttempt: true as const, requestId: randomUUID() };
    const kPending = await knowledge.experiments.start(knowledge.a.context, k.created.id, kPendingInput);
    const kReportInput = { reason: "Synthetic immutable original169 knowledge report; unknown costs remain explicit", requestId: randomUUID() };
    const kReport = await knowledge.costs.report(knowledge.a.context, k.created.id, kReportInput);
    phase = "old169-business-manifest";
    const b = await business.experiment(), completed = [];
    for (const index of [0, 2]) {
      const input = { itemId: b.version.items[index]!.id, expectedLatestAttemptId: null, confirmNewPaidAttempt: true as const, requestId: randomUUID() };
      const receipt = await business.experiments.start(business.a.context, b.created.id, input); await business.complete(receipt.id, b.version);
      await business.experiments.review(business.a.context, receipt.id, { expectedReviewId: null, decision: "pass", minutes: "1.250", hourlyUsd: "60",
        reason: "Synthetic actual169 human checks original facts; phrase checks are not semantic monetary proof", requestId: randomUUID() });
      completed.push({ input, receipt, attempt: await business.experiments.attempt(business.a.context, receipt.id) });
    }
    const pending = [];
    for (const index of [1, 3]) {
      const input = { itemId: b.version.items[index]!.id, expectedLatestAttemptId: null, confirmNewPaidAttempt: true as const, requestId: randomUUID() };
      const receipt = await business.experiments.start(business.a.context, b.created.id, input), attempt = await business.experiments.attempt(business.a.context, receipt.id);
      if (!attempt.nativeRunId || attempt.evaluationRunId || attempt.state !== "queued") throw new Error("Actual169 original business native pending receipt required");
      pending.push({ input, receipt, attempt, native: await business.assists.get(business.a.context, attempt.nativeRunId) });
    }
    const bReportInput = { reason: "Synthetic immutable original169 two-role report; unknown costs remain explicit", requestId: randomUUID() };
    const bReport = await business.costs.report(business.a.context, b.created.id, bReportInput);
    phase = "old169-original-receipts";
    const queued = await knowledge.experiments.attempt(knowledge.a.context, kPending.id);
    if (!queued.evaluationRunId || queued.state !== "queued") throw new Error("Actual169 knowledge pending native required");
    await send({ type: "role.benchmark.seeded169", knowledge: { context: knowledge.a.context, modelId: knowledge.modelId, created: k.created, createInput: k.createInput,
      version: k.version, completed: { input: kStart, receipt: kDone, attempt: await knowledge.experiments.attempt(knowledge.a.context, kDone.id) },
      pending: { input: kPendingInput, receipt: kPending, attempt: queued, native: await knowledge.evaluations.report(knowledge.a.context, queued.evaluationRunId) },
      reportInput: kReportInput, reportReceipt: kReport, report: await knowledge.costs.readReport(knowledge.a.context, kReport.id), providerCalls: knowledge.requests.length },
      business: { context: business.a.context, modelId: business.modelId, created: b.created, createInput: b.createInput, version: b.version, completed, pending,
        reportInput: bReportInput, reportReceipt: bReport, report: await business.costs.readReport(business.a.context, bReport.id), providerCalls: business.requests.length } });
  } catch (error) {
    const codes: string[] = []; let cause: unknown = error;
    for (let depth = 0; depth < 7 && cause && typeof cause === "object"; depth++) {
      if ("code" in cause && typeof cause.code === "string" && /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(cause.code)) codes.push(cause.code);
      cause = "cause" in cause ? cause.cause : null;
    }
    await send({ type: "role.benchmark.failed", phase, codes, errorName: error instanceof Error ? error.name : "Error" });
    throw new Error("Synthetic genuine169 role compatibility seed failed");
  } finally { try { closeBusiness(); } finally { await close(); } }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await seedActual169();
