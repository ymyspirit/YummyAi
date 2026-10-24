import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "../../packages/database/src/client.js";
import type * as Database from "../../packages/database/src/index.js";
import type * as Fixture from "./knowledge-benchmark-fixture.mjs";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

export async function migrateBusinessBenchmarkLegacyDatabase(database: DatabaseConnection, name: string, environment: NodeJS.ProcessEnv) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment)), nonce = /^order_daily_e2e_([a-f0-9]{32})$/.exec(name)?.[1];
  if (!nonce || url.pathname !== `/${name}` || environment.E2E_BUSINESS_BENCHMARK_ISOLATED !== "1" ||
      environment.E2E_KNOWLEDGE_BENCHMARK_ISOLATED !== "1" || environment.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" ||
      environment.E2E_LEGACY_SCHEMA_TARGET !== "pre-0169" || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Business benchmark legacy migration requires its exact fresh pre0169 database and private bucket");
  const [actual] = await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== name || actual.ledger !== null || actual.populated !== false) throw new Error("Business benchmark legacy migration refuses a populated or different database");
  const requireDatabase = createRequire(new URL("../../packages/database/package.json", import.meta.url));
  const { readMigrationFiles } = requireDatabase("drizzle-orm/migrator");
  const folder = fileURLToPath(new URL("../../packages/database/migrations/", import.meta.url));
  const journal = JSON.parse(await readFile(new URL("../../packages/database/migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ tag: string; when: number }> };
  const target = journal.entries.filter(row => row.tag.startsWith("0169_"));
  if (target.length !== 1) throw new Error("Canonical169 business benchmark migration required");
  const migrations = (readMigrationFiles({ migrationsFolder: folder }) as Array<{ folderMillis: number; sql: string[]; hash: string }>).filter(row => row.folderMillis < target[0]!.when);
  if (migrations.length !== 168) throw new Error("Actual168 migration prefix required");
  await database.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    await tx.unsafe("create schema drizzle"); await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) { for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]); }
  });
}

async function seedActual168() {
  const url = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const root = process.env.E2E_BUSINESS_BENCHMARK_LEGACY_SOURCE;
  const expected = fileURLToPath(new URL("../../tmp/business-benchmark-20261021-c9e82d4a/old168-source", import.meta.url));
  if (!process.connected || !nonce || process.env.E2E_BUSINESS_BENCHMARK_ISOLATED !== "1" || process.env.E2E_KNOWLEDGE_BENCHMARK_ISOLATED !== "1" ||
      process.env.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" ||
      process.env.E2E_BUSINESS_BENCHMARK_LEGACY_CHILD !== "168" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` ||
      !root || !isAbsolute(root) || resolve(root) !== resolve(expected))
    throw new Error("Actual168 business compatibility IPC requires its pinned ESM source, nonce database and private bucket before import");
  const send = (value: object) => new Promise<void>((done, reject) => process.send!(value, error => error ? reject(error) : done()));
  let phase = "old168-esm-load", close = async () => {};
  try {
    const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
    createRequire(pathToFileURL(resolve(root, "apps/api/package.json")))("reflect-metadata");
    const db = await load("packages/database/src/index.ts") as typeof Database;
    const old = await load("tools/testing/knowledge-benchmark-fixture.mts") as typeof Fixture;
    const database = db.connectDatabase(); close = () => database.client.end();
    if ((await db.readMigrationEvidence(database)).actualRows.length !== 168) throw new Error("Actual168 journal required");
    await db.assertDatabaseMigrationsCurrent(database);
    const f = old.knowledgeBenchmarkFixture(database); await f.initialize(); phase = "old168-published-fixed-input";
    const rows = [];
    for (let index = 0; index < 2; index++) {
      const token = randomUUID().replaceAll("-", "").replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)));
      const fields = f.fields(`Synthetic legacy fixed source ${token}`); fields.body += " Quantity 3 Unit price 12.34 USD";
      const card = await f.knowledge.save(f.a.context, null, { fields, expectedRevision: 0, reason: "Synthetic original168 fixed source", requestId: randomUUID() });
      await f.publish(card.id); rows.push({ card, fields });
    }
    const fields = { name: "Synthetic genuine168 fixed benchmark", description: "Original168 knowledge-only manifest and native pending task",
      items: rows.map(({ card, fields }, index) => ({ key: `original_${index + 1}`, role: "knowledge_answer" as const,
        evaluation: { label: `Original168 item ${index + 1}`, search: { query: fields.title, topic: "operations" as const, platform: "amazon" as const, market: "US", spuIds: [] },
          expectedFacts: ["Synthetic fixed fact"], forbiddenClaims: ["Synthetic unsupported guarantee"], requiredEntryIds: [card.id], expectRefusal: false },
        calculations: [{ key: "total", operator: "product" as const, operands: ["3", "12.34"], scale: 2, unit: "money", currency: "USD", expectedValue: "37.02" }] })) };
    const saved = await f.datasets.save(f.a.context, null, { fields, expectedRevision: 0, reason: "Synthetic original168 draft", requestId: randomUUID() });
    const published = await f.datasets.publish(f.a.context, saved.id, { expectedRevision: saved.revision, retentionDays: 7, reason: "Synthetic original168 explicit publication", requestId: randomUUID() });
    const version = await f.datasets.version(f.a.context, published.id);
    const createInput = { datasetVersionId: version.id, baselineVersion: "extractive-arithmetic-v1" as const, modelId: f.modelId, label: "Synthetic original168 experiment",
      maxAttemptsPerItem: 3, reason: "Synthetic original168 fixed arms", requestId: randomUUID() };
    const created = await f.experiments.create(f.a.context, createInput);
    const startInput = { itemId: version.items[0]!.id, expectedLatestAttemptId: null, confirmNewPaidAttempt: true as const, requestId: randomUUID() };
    const started = await f.experiments.start(f.a.context, created.id, startInput); await f.complete(started.id, version);
    await f.experiments.review(f.a.context, started.id, { expectedReviewId: null, decision: "pass", minutes: "1.500", hourlyUsd: "120",
      reason: "Synthetic actual168 human verification", requestId: randomUUID() });
    const sealedInput = { reason: "Synthetic original168 report may remain incomplete without invented costs", requestId: randomUUID() };
    const reportReceipt = await f.costs.report(f.a.context, created.id, sealedInput), report = await f.costs.readReport(f.a.context, reportReceipt.id);
    const queuedInput = { itemId: version.items[1]!.id, expectedLatestAttemptId: null, confirmNewPaidAttempt: true as const, requestId: randomUUID() };
    const queued = await f.experiments.start(f.a.context, created.id, queuedInput), pending = await f.experiments.attempt(f.a.context, queued.id);
    if (!pending.evaluationRunId || pending.state !== "queued" || f.requests.length !== 1) throw new Error("Actual168 pending native knowledge evaluation required");
    phase = "old168-original-receipts";
    await send({ type: "business.benchmark.seeded168", context: f.a.context, modelId: f.modelId, created, createInput, version,
      completed: { receipt: started, input: startInput, attempt: await f.experiments.attempt(f.a.context, started.id) },
      queued: { receipt: queued, input: queuedInput, attempt: pending, native: await f.evaluations.report(f.a.context, pending.evaluationRunId) },
      reportReceipt, reportInput: sealedInput, report, providerCalls: f.requests.length });
  } catch (error) {
    const codes: string[] = []; let cause: unknown = error;
    for (let depth = 0; depth < 6 && cause && typeof cause === "object"; depth++) {
      if ("code" in cause && typeof cause.code === "string" && /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(cause.code)) codes.push(cause.code);
      cause = "cause" in cause ? cause.cause : null;
    }
    await send({ type: "business.benchmark.failed", phase, codes, errorName: error instanceof Error ? error.name : "Error" });
    throw new Error("Synthetic genuine168 benchmark fixture failed");
  } finally { await close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await seedActual168();
