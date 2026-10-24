import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { AssistResultSchema } from "../../packages/contracts/src/ai/assist.js";
import { BENCHMARK_RULE_VERSION, BenchmarkDatasetFieldsSchema, type BenchmarkItem, type BenchmarkVersion } from "../../packages/contracts/src/knowledge/benchmark.js";
import { withTenant, type DatabaseConnection } from "../../packages/database/src/index.js";
import type * as Drizzle from "../../packages/database/node_modules/drizzle-orm/index.js";
import { knowledgeEvaluationFixture, knowledgeEvaluationOwner, evaluationSha } from "./knowledge-evaluation-fixture.mjs";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";
import { KnowledgeBenchmarkDatasetService } from "../../apps/api/src/knowledge/knowledge-benchmark-dataset.service.js";
import { KnowledgeBenchmarkExperimentService } from "../../apps/api/src/knowledge/knowledge-benchmark-experiment.service.js";
import { KnowledgeBenchmarkCostService } from "../../apps/api/src/knowledge/knowledge-benchmark-cost.service.js";

export { evaluationSha as benchmarkSha, knowledgeEvaluationOwner };
export const benchmarkTables = ["knowledge_benchmark_datasets", "knowledge_benchmark_versions", "knowledge_benchmark_items", "knowledge_benchmark_experiments",
  "knowledge_benchmark_attempts", "knowledge_benchmark_assessments", "knowledge_benchmark_reviews", "knowledge_benchmark_expenses", "knowledge_benchmark_commands", "knowledge_benchmark_reports", "knowledge_benchmark_retention_jobs"] as const;
const { sql } = createRequire(new URL("../../packages/database/package.json", import.meta.url))("drizzle-orm") as typeof Drizzle;
export function requireKnowledgeBenchmarkEnvironment(target: "current" | "pre-0168", environment: NodeJS.ProcessEnv = process.env) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment)), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (!nonce || environment.E2E_KNOWLEDGE_BENCHMARK_ISOLATED !== "1" || environment.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" ||
      environment.E2E_LEGACY_SCHEMA_TARGET !== target || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Knowledge benchmark fixture requires its exact isolated schema, nonce database and private bucket before connection");
  return { url, nonce, workspace: fileURLToPath(new URL("../../", import.meta.url)) };
}

/** Published knowledge, original membership, native Assist/Durable worker and
 * budget owners are real. Only the provider HTTP response is synthetic. */
export function knowledgeBenchmarkFixture(database: DatabaseConnection) {
  requireKnowledgeBenchmarkEnvironment("current");
  const base = knowledgeEvaluationFixture(database);
  const nativeState = base.state.bind(base);
  const datasets = new KnowledgeBenchmarkDatasetService(database, base.evaluations, base.vault);
  const experiments = new KnowledgeBenchmarkExperimentService(database, base.evaluations, base.vault);
  const costs = new KnowledgeBenchmarkCostService(database, experiments, base.vault);
  async function sources(count = 2) {
    const fields = [];
    const sourceRows = [];
    for (let index = 0; index < count; index++) {
      const cardFields = base.fields();
      cardFields.body = `${cardFields.title} Synthetic fixed fact Quantity 3 Unit price 12.34 USD`;
      const card = await base.knowledge.save(base.a.context, null, { fields: cardFields, expectedRevision: 0, reason: "Synthetic benchmark source", requestId: randomUUID() });
      await base.publish(card.id);
      sourceRows.push({ cardId: card.id, cardFields });
      fields.push({ key: `sample_${index + 1}`, role: "knowledge_answer" as const,
        evaluation: { label: `Synthetic sample ${index + 1}`, search: { query: cardFields.title, topic: "operations" as const, platform: "amazon" as const, market: "US", spuIds: [] },
          expectedFacts: ["Synthetic fixed fact"], forbiddenClaims: ["Synthetic unsupported promise"], requiredEntryIds: [card.id], expectRefusal: false },
        calculations: [{ key: "total", operator: "product" as const, operands: ["3", "12.34"], scale: 2, unit: "money", currency: "USD", expectedValue: "37.02" }] });
    }
    return { fields: BenchmarkDatasetFieldsSchema.parse({ name: `Synthetic benchmark ${randomUUID()}`, description: "Synthetic original arithmetic and reviewed source comparison", items: fields }), sources: sourceRows };
  }
  function output(item: BenchmarkItem, options: { value?: string; unit?: string; currency?: string | null; sourceId?: string; includeGoldInSummary?: boolean; omitTyped?: boolean } = {}) {
    const fields=item.fields;if(fields.role!=="knowledge_answer")throw new Error("Synthetic knowledge fixture requires its original role");
    const source = item.sourcePins.find(pin => "entryId" in pin && fields.evaluation.requiredEntryIds.includes(pin.entryId));
    if (!source) throw new Error("Synthetic benchmark answer requires its actual published source pin");
    const evidence = [{ sourceId: options.sourceId ?? source.sourceId, detail: "Synthetic original three units at twelve point thirty-four USD" }];
    return AssistResultSchema.parse({ summary: "Synthetic fixed fact" + (options.includeGoldInSummary ? " Correct total 37.02 USD" : ""),
      ...(!options.omitTyped ? { typedAnswers: fields.calculations.map(calculation => ({ key: calculation.key, value: options.value ?? "37.02", unit: options.unit ?? "money",
        currency: options.currency === undefined ? "USD" : options.currency, evidence })) } : {}),
      findings: [{ title: "Synthetic fixed fact", detail: "Synthetic fixed fact", kind: "fact", severity: "info", evidence, location: null }],
      directions: [], matches: [], missingInformation: [] });
  }
  async function dataset(count = 2, options: { retentionDays?: number } = {}) {
    const source = await sources(count);
    const saveInput = { fields: source.fields, expectedRevision: 0, reason: "Synthetic explicit fixed dataset draft", requestId: randomUUID() };
    const saved = await datasets.save(base.a.context, null, saveInput);
    const publishInput = { expectedRevision: saved.revision, retentionDays: options.retentionDays ?? 30, reason: "Synthetic reviewed fixed source publication", requestId: randomUUID() };
    const published = await datasets.publish(base.a.context, saved.id, publishInput);
    const version = await datasets.version(base.a.context, published.id);
    return { ...source, saved, saveInput, published, publishInput, version };
  }
  async function experiment(count = 2, options: { modelId?: string; maxAttemptsPerItem?: number; retentionDays?: number } = {}) {
    const source = await dataset(count, options);
    const createInput = { datasetVersionId: source.version.id, label: `Synthetic fixed experiment ${randomUUID()}`, baselineVersion: BENCHMARK_RULE_VERSION,
      modelId: options.modelId ?? base.modelId, maxAttemptsPerItem: options.maxAttemptsPerItem ?? 3, reason: "Synthetic free baseline plus explicit candidate", requestId: randomUUID() };
    const created = await experiments.create(base.a.context, createInput);
    return { ...source, created, createInput, experiment: await experiments.get(base.a.context, created.id) };
  }
  async function complete(attemptId: string, version: BenchmarkVersion, options: Parameters<typeof output>[1] = {}) {
    const before = await experiments.attempt(base.a.context, attemptId);
    if (!before.evaluationRunId) throw new Error("Synthetic completion requires a genuine native candidate evaluation");
    const item = version.items.find(value => value.id === before.itemId);
    if (!item) throw new Error("Synthetic candidate item must belong to this original published version");
    const native = await base.evaluations.report(base.a.context, before.evaluationRunId);
    let phase = "prepare-output";
    try {
      base.setOutput(output(item, options)); phase = "processor"; await base.processRun(native.answer.id);
      phase = "read-native"; const completedNative = await base.evaluations.report(base.a.context, before.evaluationRunId);
      phase = "read-attempt"; const attempt = await experiments.attempt(base.a.context, attemptId);
      phase = "verify-completed";
      if (completedNative.answer.status !== "completed" || attempt.state !== "completed" || !attempt.assessment)
        throw new Error("Synthetic native benchmark completion missing");
      return { attempt, native: completedNative };
    } catch {
      const [actual] = await withTenant(database.db, base.a.context, tx => tx.execute<{ status: string; errorCode: string | null }>(
        sql`select status,error_code as "errorCode" from ai_assist_runs where id=${native.answer.id}::uuid`));
      throw new Error("Synthetic benchmark completion failed: " + JSON.stringify({ phase, nativeStatus: actual?.status ?? "missing",
        nativeError: actual?.errorCode == null ? null : /^[a-z][a-z0-9_]{0,127}$/.test(actual.errorCode) ? actual.errorCode : "unclassified",
        providerRequests: base.requests.length }));
    }
  }
  async function state(context = base.a.context) {
    const native = await nativeState(context);
    return withTenant(database.db, context, async tx => {
      for (const table of [...benchmarkTables, "model_billing_reconciliations", "audit_events"])
        native[table] = (await tx.execute<{ count: number; hash: string }>(sql`select count(*)::int as count,md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as hash from ${sql.identifier(table)} t`))[0]!;
      return native;
    });
  }
  return Object.assign(base, { datasets, experiments, costs, sources, output, dataset, experiment, complete, state });
}
