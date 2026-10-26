import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { SecretVault, OpenAiCompatibleProvider } from "../../packages/ai-core/src/index.js";
import { Permission } from "../../packages/authz/src/index.js";
import { createEntityId } from "../../packages/contracts/src/common/ids.js";
import type { TenantContext } from "../../packages/contracts/src/tenant/tenant-context.js";
import type { KnowledgeFields, KnowledgeSearch } from "../../packages/contracts/src/knowledge/index.js";
import { AssistResultSchema, type AssistResult } from "../../packages/contracts/src/ai/assist.js";
import { JobEnvelopeSchema } from "../../packages/jobs/src/index.js";
import { knowledgeDay } from "../../packages/knowledge-core/src/index.js";
import { memberships, membershipRoles, roles, loadCurrentMembershipContext, aiAssistRuns, withTenant, type DatabaseConnection } from "../../packages/database/src/index.js";
import { ClamAvScanner } from "../../packages/storage/src/index.js";
import type * as Drizzle from "../../packages/database/node_modules/drizzle-orm/index.js";
import { AuditService } from "../../apps/api/src/audit/audit.service.js";
import { AssistContextService } from "../../apps/api/src/ai/assist-context.service.js";
import { AssistService, type AssistEnqueuer } from "../../apps/api/src/ai/assist.service.js";
import { KnowledgeService } from "../../apps/api/src/knowledge/knowledge.service.js";
import { KnowledgeImportService } from "../../apps/api/src/knowledge/knowledge-import.service.js";
import { KnowledgeGovernanceService } from "../../apps/api/src/knowledge/knowledge-governance.service.js";
import { KnowledgeAnswerContextService } from "../../apps/api/src/knowledge/knowledge-answer-context.service.js";
import { KnowledgeEvaluationService } from "../../apps/api/src/knowledge/knowledge-evaluation.service.js";
import { AiAssistProcessor, assistPricing } from "../../apps/worker/src/processors/ai-assist.processor.js";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const requireDatabase = createRequire(new URL("../../packages/database/package.json", import.meta.url));
const { eq, sql } = requireDatabase("drizzle-orm") as typeof Drizzle;
export const evaluationSha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
/** Human-readable synthetic text only. One hex digit maps to one a-p letter;
 * real database/request/resource IDs remain their original UUIDs. */
export function evaluationTextId(id = createEntityId()) {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) throw new Error("evaluation_text_id_requires_uuid");
  return id.replaceAll("-", "").replace(/[a-f0-9]/g, digit => "abcdefghijklmnop"[Number.parseInt(digit, 16)]!);
}
export function requireKnowledgeEvaluationEnvironment(target: "current" | "pre-0167", environment: NodeJS.ProcessEnv = process.env) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment)), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (!nonce || environment.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" || environment.E2E_LEGACY_SCHEMA_TARGET !== target ||
      environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Knowledge evaluation fixture requires its exact isolated schema, nonce database and bucket before connection");
  return { url, nonce, workspace };
}
export const evaluationAllPermissions = Object.values(Permission);
export type EvaluationActor = { tenantId: string; userId: string; membershipId: string; roleId: string; widerRoleId: string; context: TenantContext };

/** Only native knowledge/Assist branches are exercised. Original document and
 * model secrets are separate; the provider HTTP transport is synthetic. */
export function knowledgeEvaluationOwner(database: DatabaseConnection, options: { queue?: AssistEnqueuer; output?: () => AssistResult;
  beforeResponse?: () => Promise<void>; requests?: Array<{ model: string; body: Record<string, unknown> }> } = {}) {
  const originalVault = new SecretVault(Buffer.alloc(32, 61)), modelVault = new SecretVault(Buffer.alloc(32, 62)), vault = new SecretVault(Buffer.alloc(32, 63));
  const audit = new AuditService(database), knowledge = new KnowledgeService(database, audit);
  const imports = new KnowledgeImportService(database, originalVault, new ClamAvScanner(), knowledge);
  const governance = new KnowledgeGovernanceService(database, knowledge), answers = new KnowledgeAnswerContextService(database, vault, knowledge, imports);
  // As in the existing governance integration, unrelated business branches are
  // absent rather than replaced with invented business facts or fake owners.
  const contexts = new AssistContextService(database, null!, null!, null!, null!, null!, answers);
  const assists = new AssistService(database, vault, contexts, options.queue ?? { enqueue: async () => {} });
  const evaluations = new KnowledgeEvaluationService(database, assists);
  const processor = new AiAssistProcessor(database, modelVault, vault, (provider, key, run) => new OpenAiCompatibleProvider({
    providerId: provider.id, endpoint: "https://synthetic-evaluation.invalid/v1", apiKey: key, pricing: assistPricing(run.modelSnapshot),
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      options.requests?.push({ model: run.modelSnapshot.model, body });
      if (options.beforeResponse) await options.beforeResponse();
      return Response.json({ id: `synthetic-response-${run.id}`, choices: [{ message: { content: JSON.stringify(options.output?.() ?? {
        summary: "Synthetic fixed fact", findings: [], directions: [], matches: [], missingInformation: [] }) } }], usage: { prompt_tokens: 50, completion_tokens: 80 } });
    },
  }));
  return { originalVault, modelVault, vault, audit, knowledge, imports, governance, answers, contexts, assists, evaluations, processor };
}

export function knowledgeEvaluationFixture(database: DatabaseConnection) {
  requireKnowledgeEvaluationEnvironment("current");
  const controls: { failQueue: boolean; beforeQueue?: (input: Parameters<AssistEnqueuer["enqueue"]>[0]) => Promise<void>; beforeResponse?: () => Promise<void> } = { failQueue: false };
  const dispatches: Array<Parameters<AssistEnqueuer["enqueue"]>[0]> = [], requests: Array<{ model: string; body: Record<string, unknown> }> = [];
  let output: AssistResult = AssistResultSchema.parse({ summary: "Synthetic fixed fact", findings: [], directions: [], matches: [], missingInformation: [] });
  const owner = knowledgeEvaluationOwner(database, { requests, output: () => output, beforeResponse: async () => { await controls.beforeResponse?.(); },
    queue: { enqueue: async input => { dispatches.push(input); await controls.beforeQueue?.(input); if (controls.failQueue) throw new Error("Synthetic postcommit queue unavailable"); } } });
  let a: EvaluationActor, second: EvaluationActor, foreign: EvaluationActor, modelId: string, alternateModelId: string, providerId: string;
  const all = evaluationAllPermissions;
  const seed = (actor: Pick<EvaluationActor, "tenantId" | "userId">): TenantContext => ({ tenantId: actor.tenantId, userId: actor.userId, permissions: all, dataScope: "tenant" });
  async function actor(tenantId?: string): Promise<EvaluationActor> {
    const value = { tenantId: tenantId ?? createEntityId(), userId: createEntityId(), membershipId: createEntityId(), roleId: createEntityId(), widerRoleId: createEntityId() };
    if (!tenantId) await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic evaluation tenant',$2)", [value.tenantId, `evaluation-${value.tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic evaluation operator')", [value.userId, `evaluation-${value.userId}`, `${value.userId}@example.invalid`]);
    await withTenant(database.db, seed(value), async tx => {
      await tx.insert(memberships).values({ id: value.membershipId, tenantId: value.tenantId, userId: value.userId, status: "active" });
      await tx.insert(roles).values([value.roleId, value.widerRoleId].map((id, index) => ({ id, tenantId: value.tenantId, name: `Synthetic evaluation role ${id}`, permissions: index === 0 ? all : [], dataScope: "tenant" })));
      await tx.insert(membershipRoles).values([value.roleId, value.widerRoleId].map(roleId => ({ tenantId: value.tenantId, membershipId: value.membershipId, roleId })));
    });
    return { ...value, context: await withTenant(database.db, seed(value), tx => loadCurrentMembershipContext(tx, seed(value))) };
  }
  async function grant(value = a, permissions: readonly string[] = all, scope: "self" | "team" | "tenant" = "tenant", wider: readonly string[] = []) {
    await withTenant(database.db, seed(value), async tx => {
      await tx.update(roles).set({ permissions: [...permissions], dataScope: scope }).where(eq(roles.id, value.roleId));
      await tx.update(roles).set({ permissions: [...wider], dataScope: "tenant" }).where(eq(roles.id, value.widerRoleId));
      await tx.update(memberships).set({ status: "active" }).where(eq(memberships.id, value.membershipId));
    });
  }
  async function initialize() {
    a = await actor(); second = await actor(a.tenantId); foreign = await actor(); providerId = createEntityId();
    await withTenant(database.db, a.context, tx => tx.execute(sql`insert into model_provider_configs(id,tenant_id,provider,label,endpoint,encrypted_api_key,created_by)
      values(${providerId}::uuid,${a.tenantId}::uuid,'openai-compatible','Synthetic evaluation provider','https://synthetic-evaluation.invalid/v1',${owner.modelVault.encrypt("synthetic-no-provider-credential")},${a.userId}::uuid)`));
    modelId = (await owner.assists.addModel(a.context, { providerConfigId: providerId, model: "synthetic-evaluation-a", label: "Synthetic evaluation A", inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxTaskCostUsd: 1 })).id;
    alternateModelId = (await owner.assists.addModel(a.context, { providerConfigId: providerId, model: "synthetic-evaluation-b", label: "Synthetic evaluation B", inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxTaskCostUsd: 1 })).id;
  }
  function fields(label = `Synthetic evaluation ${evaluationTextId()}`): KnowledgeFields {
    return { title: label, summary: label, body: `${label} Synthetic fixed fact`, topic: "operations", platform: "amazon", market: "US", spuId: null,
      sourceType: "team", sourceLabel: "Synthetic evaluation bibliography", sourceUrl: "", owner: "Synthetic evaluator", verifiedOn: knowledgeDay(), reviewDueOn: "2099-12-31", tags: [] };
  }
  async function publish(id: string) {
    let entry = (await owner.knowledge.workspace(a.context)).entries.find(value => value.id === id)!;
    await owner.knowledge.change(a.context, id, "submit", { expectedRevision: entry.revision, version: entry.latestVersion, reason: "Synthetic explicit review", requestId: randomUUID() });
    entry = (await owner.knowledge.workspace(a.context)).entries.find(value => value.id === id)!;
    await owner.knowledge.change(a.context, id, "publish", { expectedRevision: entry.revision, version: entry.latestVersion, reason: "Synthetic approved knowledge", requestId: randomUUID() });
  }
  async function scenario() {
    const cardFields = fields(), card = await owner.knowledge.save(a.context, null, { fields: cardFields, expectedRevision: 0, reason: "Synthetic fixed source", requestId: randomUUID() });
    await publish(card.id);
    const search: KnowledgeSearch = { query: cardFields.title, topic: "operations", platform: "amazon", market: "US", spuIds: [] };
    const caseFields = { label: `Synthetic fixed case ${createEntityId()}`, search, expectedFacts: ["Synthetic fixed fact"], forbiddenClaims: ["Synthetic forbidden claim"], requiredEntryIds: [card.id], expectRefusal: false };
    const saved = await owner.governance.saveEvaluation(a.context, null, { fields: caseFields, expectedRevision: 0, requestId: randomUUID() });
    return { cardId: card.id, cardFields, caseId: saved.id, caseFields, input: { modelId, requestId: randomUUID() } };
  }
  async function processRun(id: string, value = a, operation: "analyze" | "expire" = "analyze") {
    return owner.processor.process(JobEnvelopeSchema.parse({ jobId: id, tenantId: value.tenantId, requestedBy: value.userId, correlationId: id,
      idempotencyKey: id, payload: { runId: id, operation } }));
  }
  async function state(context = a.context) {
    return withTenant(database.db, context, async tx => {
      const result: Record<string, { count: number; hash: string }> = {};
      for (const table of ["ai_assist_runs", "ai_assist_executions", "ai_budget_ledger", "knowledge_evaluation_runs", "knowledge_evaluation_protocols", "knowledge_evaluation_assessments", "knowledge_governance_events"])
        result[table] = (await tx.execute<{ count: number; hash: string }>(sql`select count(*)::int as count,md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as hash from ${sql.identifier(table)} t`))[0]!;
      return result;
    });
  }
  async function pending() { return withTenant(database.db, a.context, tx => tx.select().from(aiAssistRuns).where(sql`${aiAssistRuns.status} in ('queued','running')`)); }
  return { ...owner, controls, dispatches, requests, initialize, actor, seed, grant, scenario, fields, publish, processRun, state, pending,
    setOutput(value: AssistResult) { output = AssistResultSchema.parse(value); },
    get a() { return a; }, get second() { return second; }, get foreign() { return foreign; }, get modelId() { return modelId; }, get alternateModelId() { return alternateModelId; }, get providerId() { return providerId; } };
}
