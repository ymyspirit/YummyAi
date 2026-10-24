import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "../../packages/database/src/client.js";
import type * as Database from "../../packages/database/src/index.js";
import type * as Fixture from "./knowledge-evaluation-fixture.mjs";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

export async function migrateKnowledgeBenchmarkLegacyDatabase(database: DatabaseConnection, name: string, environment: NodeJS.ProcessEnv) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment)), nonce = /^order_daily_e2e_([a-f0-9]{32})$/.exec(name)?.[1];
  if (!nonce || url.pathname !== `/${name}` || environment.E2E_KNOWLEDGE_BENCHMARK_ISOLATED !== "1" || environment.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" ||
      environment.E2E_LEGACY_SCHEMA_TARGET !== "pre-0168" || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Knowledge benchmark legacy migration requires the exact fresh pre0168 database and private bucket");
  const [actual] = await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== name || actual.ledger !== null || actual.populated !== false) throw new Error("Knowledge benchmark legacy migration refuses a populated or different database");
  const requireDatabase = createRequire(new URL("../../packages/database/package.json", import.meta.url));
  const { readMigrationFiles } = requireDatabase("drizzle-orm/migrator");
  const migrationsFolder = fileURLToPath(new URL("../../packages/database/migrations/", import.meta.url));
  const journal = JSON.parse(await readFile(new URL("../../packages/database/migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ tag: string; when: number }> };
  const target = journal.entries.filter(row => row.tag.startsWith("0168_"));
  if (target.length !== 1) throw new Error("Canonical168 benchmark migration required");
  const migrations = (readMigrationFiles({ migrationsFolder }) as Array<{ folderMillis: number; sql: string[]; hash: string }>).filter(row => row.folderMillis < target[0]!.when);
  if (migrations.length !== 167) throw new Error("Actual167 migration prefix required");
  await database.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    await tx.unsafe("create schema drizzle"); await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) { for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]); }
  });
}

async function seedActual167() {
  // No historical module, constructor or database connection before this guard.
  const url = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const root = process.env.E2E_KNOWLEDGE_BENCHMARK_LEGACY_SOURCE;
  const expected = fileURLToPath(new URL("../../tmp/knowledge-benchmark-20261021-a7d9e6c2/old167-source", import.meta.url));
  if (!process.connected || !nonce || process.env.E2E_KNOWLEDGE_BENCHMARK_ISOLATED !== "1" || process.env.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" ||
      process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.E2E_KNOWLEDGE_BENCHMARK_LEGACY_CHILD !== "167" ||
      process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !root || !isAbsolute(root) || resolve(root) !== resolve(expected))
    throw new Error("Actual167 benchmark IPC requires its pinned ESM source, nonce database and private bucket");
  const send = (value: object) => new Promise<void>((done, reject) => process.send!(value, error => error ? reject(error) : done()));
  let phase = "old167-esm-load", cleanup = async () => {};
  try {
    const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
    const oldRequire = createRequire(pathToFileURL(resolve(root, "apps/api/package.json"))); oldRequire("reflect-metadata");
    const d = await load("packages/database/src/index.ts") as typeof Database;
    // The frozen .mts helper is itself ESM and resolves all owners and Worker
    // relative to old167. No current owner manufactures the historical graph.
    const old = await load("tools/testing/knowledge-evaluation-fixture.mts") as typeof Fixture;
    const database = d.connectDatabase(); cleanup = async () => { await database.client.end(); };
    phase = "old167-ledger";
    if ((await d.readMigrationEvidence(database)).actualRows.length !== 167) throw new Error("Actual167 journal required");
    await d.assertDatabaseMigrationsCurrent(database);
    const f = old.knowledgeEvaluationFixture(database); await f.initialize(); const s = await f.scenario();
    phase = "old167-native-answer";
    const first = await f.evaluations.start(f.a.context, s.caseId, s.input), initial = await f.evaluations.report(f.a.context, first.id), reference = initial.answer.knowledge[0];
    if (!reference) throw new Error("Actual167 pinned knowledge required");
    f.setOutput({ summary: "Synthetic fixed fact", findings: [{ title: "Synthetic fixed fact", detail: "Synthetic fixed fact", kind: "fact", severity: "info",
      evidence: [{ sourceId: reference.sourceId, detail: "Actual167 pinned reference" }], location: null }], directions: [], matches: [], missingInformation: [] });
    await f.processRun(initial.answer.id);
    await f.evaluations.review(f.a.context, first.id, { result: "pass", reason: "Synthetic original167 fact check" });
    const report = await f.evaluations.report(f.a.context, first.id);
    const secondInput = { modelId: f.modelId, requestId: randomUUID() }, second = await f.evaluations.start(f.a.context, s.caseId, secondInput);
    const pending = await f.evaluations.report(f.a.context, second.id);
    if (f.requests.length !== 1 || report.answer.status !== "completed" || report.assessmentState !== "recorded" || !report.assessment || report.assessment.checks.some(row => row.status !== "pass"))
      throw new Error("Actual167 sealed evaluation and original manual review required");
    await send({ type: "knowledge.benchmark.seeded167", context: f.a.context, modelId: f.modelId, scenario: s,
      completed: { input: s.input, result: first, report }, queued: { input: secondInput, result: second, report: pending }, modelCalls: f.requests.length });
  } catch (error) {
    const codes: string[] = []; let cause: unknown = error;
    for (let depth = 0; depth < 6 && cause && typeof cause === "object"; depth++) {
      if ("code" in cause && typeof cause.code === "string" && /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(cause.code)) codes.push(cause.code);
      cause = "cause" in cause ? cause.cause : null;
    }
    await send({ type: "knowledge.benchmark.failed", phase, ...(codes[0] ? { code: codes[0] } : {}), codes, errorName: error instanceof Error ? error.name : "Error" });
    throw new Error("Synthetic genuine167 benchmark fixture failed");
  } finally { await cleanup(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await seedActual167();
