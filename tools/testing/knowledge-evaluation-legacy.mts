import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Database from "../../packages/database/src/index.js";
import type * as Core from "../../packages/ai-core/src/index.js";
import type * as Jobs from "../../packages/jobs/src/index.js";
import type * as Storage from "../../packages/storage/src/index.js";
import type * as Authz from "../../packages/authz/src/index.js";
import type * as Contracts from "../../packages/contracts/src/index.js";
import type * as Audit from "../../apps/api/src/audit/audit.service.js";
import type * as Knowledge from "../../apps/api/src/knowledge/knowledge.service.js";
import type * as Imports from "../../apps/api/src/knowledge/knowledge-import.service.js";
import type * as Governance from "../../apps/api/src/knowledge/knowledge-governance.service.js";
import type * as Answers from "../../apps/api/src/knowledge/knowledge-answer-context.service.js";
import type * as Contexts from "../../apps/api/src/ai/assist-context.service.js";
import type * as Assists from "../../apps/api/src/ai/assist.service.js";
import type * as Evaluations from "../../apps/api/src/knowledge/knowledge-evaluation.service.js";
import type * as Worker from "../../apps/worker/src/processors/ai-assist.processor.js";
import type * as Drizzle from "../../packages/database/node_modules/drizzle-orm/index.js";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

export async function migrateKnowledgeEvaluationLegacyDatabase(database: Database.DatabaseConnection, expectedName: string, environment: NodeJS.ProcessEnv) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment)), nonce = /^order_daily_e2e_([a-f0-9]{32})$/.exec(expectedName)?.[1];
  if (!nonce || url.pathname !== `/${expectedName}` || environment.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" ||
      environment.E2E_LEGACY_SCHEMA_TARGET !== "pre-0167" || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Knowledge evaluation legacy migration requires the exact fresh pre0167 database and private bucket");
  const [actual] = await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== expectedName || actual.ledger !== null || actual.populated !== false) throw new Error("Knowledge evaluation legacy migration refuses a populated or different database");
  const requireDatabase = createRequire(new URL("../../packages/database/package.json", import.meta.url));
  const { readMigrationFiles } = requireDatabase("drizzle-orm/migrator");
  const migrationsFolder = fileURLToPath(new URL("../../packages/database/migrations/", import.meta.url));
  const journal = JSON.parse(await readFile(new URL("../../packages/database/migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ tag: string; when: number }> };
  const targets = journal.entries.filter(row => row.tag.startsWith("0167_"));
  if (targets.length !== 1) throw new Error("Canonical167 knowledge evaluation migration required");
  const migrations = (readMigrationFiles({ migrationsFolder }) as Array<{ folderMillis: number; sql: string[]; hash: string }>).filter(row => row.folderMillis < targets[0]!.when);
  if (migrations.length !== 166) throw new Error("Actual166 migration prefix required");
  await database.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    await tx.unsafe("create schema drizzle");
    await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) {
      for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]);
    }
  });
}

async function seedActual166() {
  // Guard before any dynamic business import, constructor or connection.
  const url = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const root = process.env.E2E_KNOWLEDGE_EVALUATION_LEGACY_SOURCE;
  const expected = fileURLToPath(new URL("../../tmp/knowledge-evaluation-20261021-e4c8a571/old166-source", import.meta.url));
  if (!process.connected || !nonce || process.env.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" ||
      process.env.E2E_KNOWLEDGE_EVALUATION_LEGACY_CHILD !== "166" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` ||
      !root || !isAbsolute(root) || resolve(root) !== resolve(expected)) throw new Error("Actual166 knowledge IPC requires its pinned source, nonce database and bucket");
  const send = (value: object) => new Promise<void>((done, reject) => process.send!(value, error => error ? reject(error) : done()));
  let phase = "old166-module-load", cleanup = async () => {};
  try {
    const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
    const oldRequire = createRequire(pathToFileURL(resolve(root, "apps/api/package.json"))); oldRequire("reflect-metadata");
    const d = await load("packages/database/src/index.ts") as typeof Database;
    const core = await load("packages/ai-core/src/index.ts") as typeof Core;
    const { Permission } = await load("packages/authz/src/index.ts") as typeof Authz;
    const { createEntityId } = await load("packages/contracts/src/index.ts") as typeof Contracts;
    const { JobEnvelopeSchema } = await load("packages/jobs/src/index.ts") as typeof Jobs;
    const { ClamAvScanner } = await load("packages/storage/src/index.ts") as typeof Storage;
    const { AuditService } = await load("apps/api/src/audit/audit.service.ts") as typeof Audit;
    const { KnowledgeService } = await load("apps/api/src/knowledge/knowledge.service.ts") as typeof Knowledge;
    const { KnowledgeImportService } = await load("apps/api/src/knowledge/knowledge-import.service.ts") as typeof Imports;
    const { KnowledgeGovernanceService } = await load("apps/api/src/knowledge/knowledge-governance.service.ts") as typeof Governance;
    const { KnowledgeAnswerContextService } = await load("apps/api/src/knowledge/knowledge-answer-context.service.ts") as typeof Answers;
    const { AssistContextService } = await load("apps/api/src/ai/assist-context.service.ts") as typeof Contexts;
    const { AssistService } = await load("apps/api/src/ai/assist.service.ts") as typeof Assists;
    const { KnowledgeEvaluationService } = await load("apps/api/src/knowledge/knowledge-evaluation.service.ts") as typeof Evaluations;
    const { AiAssistProcessor, assistPricing } = await load("apps/worker/src/processors/ai-assist.processor.ts") as typeof Worker;
    const { sql } = oldRequire("drizzle-orm") as typeof Drizzle;
    const database = d.connectDatabase(); cleanup = async () => { await database.client.end(); };
    phase = "old166-ledger";
    if ((await d.readMigrationEvidence(database)).actualRows.length !== 166) throw new Error("Actual166 journal required");
    await d.assertDatabaseMigrationsCurrent(database);
    const tenantId = createEntityId(), userId = createEntityId(), membershipId = createEntityId(), roleId = createEntityId(), providerId = createEntityId();
    const seed = { tenantId, userId, permissions: Object.values(Permission), dataScope: "tenant" as const };
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic original166 evaluation',$2)", [tenantId, `old166-${tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic original166 operator')", [userId, `old166-${userId}`, `${userId}@example.invalid`]);
    await d.withTenant(database.db, seed, async tx => {
      await tx.insert(d.memberships).values({ id: membershipId, tenantId, userId, status: "active" });
      await tx.insert(d.roles).values({ id: roleId, tenantId, name: `Synthetic original166 role ${roleId}`, permissions: Object.values(Permission), dataScope: "tenant" });
      await tx.insert(d.membershipRoles).values({ tenantId, membershipId, roleId });
    });
    const context = await d.withTenant(database.db, seed, tx => d.loadCurrentMembershipContext(tx, seed));
    const originalVault = new core.SecretVault(Buffer.alloc(32, 61)), modelVault = new core.SecretVault(Buffer.alloc(32, 62)), vault = new core.SecretVault(Buffer.alloc(32, 63));
    const knowledge = new KnowledgeService(database, new AuditService(database));
    const imports = new KnowledgeImportService(database, originalVault, new ClamAvScanner(), knowledge), governance = new KnowledgeGovernanceService(database, knowledge);
    const answers = new KnowledgeAnswerContextService(database, vault, knowledge, imports), contexts = new AssistContextService(database, null!, null!, null!, null!, null!, answers);
    const queue: string[] = [], assists = new AssistService(database, vault, contexts, { enqueue: async input => { queue.push(input.id); } });
    const evaluations = new KnowledgeEvaluationService(database, assists);
    await d.withTenant(database.db, context, tx => tx.execute(sql`insert into model_provider_configs(id,tenant_id,provider,label,endpoint,encrypted_api_key,created_by)
      values(${providerId}::uuid,${tenantId}::uuid,'openai-compatible','Synthetic original166 provider','https://synthetic-evaluation.invalid/v1',${modelVault.encrypt("synthetic-no-provider-credential")},${userId}::uuid)`));
    const modelId = (await assists.addModel(context, { providerConfigId: providerId, model: "synthetic-old166-evaluation", label: "Synthetic original166 evaluation", inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxTaskCostUsd: 1 })).id;
    phase = "old166-native-knowledge";
    const fields = { title: `Synthetic original166 source ${createEntityId()}`, summary: "Synthetic original166 fixed fact", body: "Synthetic original166 fixed fact", topic: "operations" as const,
      platform: "amazon" as const, market: "US", spuId: null, sourceType: "team" as const, sourceLabel: "Synthetic original166 source", sourceUrl: "", owner: "Synthetic evaluator",
      verifiedOn: new Date().toISOString().slice(0, 10), reviewDueOn: "2099-12-31", tags: [] };
    const card = await knowledge.save(context, null, { fields, expectedRevision: 0, reason: "Synthetic original166 fixed source", requestId: randomUUID() });
    let entry = (await knowledge.workspace(context)).entries.find(value => value.id === card.id)!;
    await knowledge.change(context, card.id, "submit", { expectedRevision: entry.revision, version: entry.latestVersion, reason: "Synthetic original166 review", requestId: randomUUID() });
    entry = (await knowledge.workspace(context)).entries.find(value => value.id === card.id)!;
    await knowledge.change(context, card.id, "publish", { expectedRevision: entry.revision, version: entry.latestVersion, reason: "Synthetic original166 publication", requestId: randomUUID() });
    const caseFields = { label: `Synthetic original166 case ${createEntityId()}`, search: { query: fields.title, topic: "operations" as const, platform: "amazon" as const, market: "US", spuIds: [] },
      expectedFacts: ["Synthetic original166 fixed fact"], forbiddenClaims: ["Synthetic forbidden promise"], requiredEntryIds: [card.id], expectRefusal: false };
    const saved = await governance.saveEvaluation(context, null, { fields: caseFields, expectedRevision: 0, requestId: randomUUID() });
    const firstInput = { modelId, requestId: randomUUID() }, queuedInput = { modelId, requestId: randomUUID() };
    const first = await evaluations.start(context, saved.id, firstInput), queued = await evaluations.start(context, saved.id, queuedInput);
    const initial = await evaluations.report(context, first.id), reference = initial.answer.knowledge.find(value => value.entryId === card.id);
    if (!reference) throw new Error("Original166 actual pinned knowledge required");
    phase = "old166-durable-answer"; let calls = 0;
    const processor = new AiAssistProcessor(database, modelVault, vault, (provider, key, run) => new core.OpenAiCompatibleProvider({ providerId: provider.id,
      endpoint: "https://synthetic-evaluation.invalid/v1", apiKey: key, pricing: assistPricing(run.modelSnapshot), fetch: async () => {
        calls++; return Response.json({ id: `synthetic-old166-response-${run.id}`, choices: [{ message: { content: JSON.stringify({ summary: "Synthetic original166 fixed fact",
          findings: [{ title: "Synthetic original166 fixed fact", detail: "Synthetic original166 fixed fact", kind: "fact", severity: "info", evidence: [{ sourceId: reference.sourceId, detail: "Original166 pinned source" }], location: null }],
          directions: [], matches: [], missingInformation: [] }) } }], usage: { prompt_tokens: 50, completion_tokens: 80 } });
      } }));
    await processor.process(JobEnvelopeSchema.parse({ jobId: initial.answer.id, tenantId, requestedBy: userId, correlationId: initial.answer.id,
      idempotencyKey: initial.answer.id, payload: { runId: initial.answer.id, operation: "analyze" } }));
    const report = await evaluations.report(context, first.id), queuedReport = await evaluations.report(context, queued.id);
    await evaluations.review(context, first.id, { result: "pass", reason: "Synthetic original166 manual fact check" });
    const reviewed = await evaluations.report(context, first.id);
    if (calls !== 1 || reviewed.answer.status !== "completed" || report.checks.some(value => value.status !== "pass") || reviewed.manualReviews.length !== 1)
      throw new Error("Actual166 completed assertion and original human review required");
    // A genuine old standalone evaluation-purpose Assist is intentionally not
    // linked. The upgrade must not adopt it or manufacture a protocol for it.
    const isolated = await assists.create(context, { kind: "knowledge_answer", purpose: "evaluation", scopeId: saved.id, search: caseFields.search,
      evidenceStoreId: null, previousRunId: null, requestId: randomUUID(), modelId });
    await send({ type: "knowledge.evaluation.seeded166", context, roleId, membershipId, modelId, caseId: saved.id, caseFields, cardId: card.id,
      first: { input: firstInput, result: first, report: reviewed }, queued: { input: queuedInput, result: queued, report: queuedReport }, isolated,
      modelCalls: calls, queuedIds: queue });
  } catch (error) {
    const codes: string[] = []; let cause: unknown = error;
    for (let depth = 0; depth < 6 && cause && typeof cause === "object"; depth++) {
      if ("code" in cause && typeof cause.code === "string" && /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(cause.code)) codes.push(cause.code);
      cause = "cause" in cause ? cause.cause : null;
    }
    await send({ type: "knowledge.evaluation.failed", phase, ...(codes[0] ? { code: codes[0] } : {}), codes, errorName: error instanceof Error ? error.name : "Error" });
    throw new Error("Synthetic genuine166 evaluation fixture failed");
  } finally { await cleanup(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await seedActual166();
