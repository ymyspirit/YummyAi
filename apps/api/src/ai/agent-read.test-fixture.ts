import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { SecretVault, assistFingerprint } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { CreateAssistSchema, type CreateAssist } from "@yummyai/contracts/ai/assist";
import { assistRequestRecoveryText } from "@yummyai/contracts/ai/assist-recovery";
import { type KnowledgeFields } from "@yummyai/contracts/knowledge";
import { JobEnvelopeSchema } from "@yummyai/jobs";
import { memberships, membershipRoles, roles, marketplaceAccounts, organizationTeams, organizationTeamMembers,
  loadCurrentMembershipContext, withTenant, type DatabaseConnection } from "@yummyai/database";
import { Storage, ClamAvScanner } from "@yummyai/storage";
import type * as S3Sdk from "../../../../packages/storage/node_modules/@aws-sdk/client-s3/dist-types/index.js";
import { eq, sql } from "drizzle-orm";
import { knowledgeEvaluationOwner } from "../../../../tools/testing/knowledge-evaluation-fixture.mjs";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { OrderService } from "../orders/order.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { AmazonOrderReportService } from "../orders/amazon-order-report.service.js";
import { OrderWorkspaceService } from "../orders/order-workspace.service.js";
import { ProductionEditorService } from "../design/production-editor.service.js";
import { IntegrationService } from "../integrations/integration.service.js";
import { DatabaseApiClientContextLoader } from "../auth/tenant-context.guard.js";
import { AssistContextService } from "./assist-context.service.js";
import { AssistService, type AssistEnqueuer } from "./assist.service.js";
import { AgentReadService } from "./agent-read.service.js";

const { S3Client } = createRequire(new URL("../../../../packages/storage/package.json", import.meta.url))("@aws-sdk/client-s3") as typeof S3Sdk;
export const agentReadSha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
export const allAgentPermissions = Object.values(Permission);
type Scope = TenantContext["dataScope"];
export type AgentActor = { tenantId: string; userId: string; subject: string; membershipId: string;
  roleIds: Map<string, string>; context: TenantContext };

export function requireAgentReadEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment));
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (!nonce || environment.E2E_AGENT_READ_ISOLATED !== "1" || environment.E2E_LEGACY_SCHEMA_TARGET !== "current" ||
      environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Agent read fixture requires its exact isolated current nonce database and private bucket before connecting");
  return url.href;
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
export async function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 15_000); })]); }
  finally { clearTimeout(timer); }
}

/** Identity/account admissions are explicit synthetic setup. All exception,
 * inventory, Assist, billing and recovery facts come from their real owners.
 * This suite performs no artwork approval, object upload or factory release. */
export function agentReadFixture(database: DatabaseConnection) {
  requireAgentReadEnvironment();
  const controls: { failQueue: boolean; beforeResponse?: () => Promise<void> } = { failQueue: false };
  const dispatches: Array<Parameters<AssistEnqueuer["enqueue"]>[0]> = [];
  const providerRequests: Array<{ model: string; body: Record<string, unknown> }> = [];
  const queue: AssistEnqueuer = { enqueue: async input => { dispatches.push(input); if (controls.failQueue) throw new Error("Synthetic queue unavailable"); } };
  const native = knowledgeEvaluationOwner(database, { queue, requests: providerRequests,
    beforeResponse: async () => { await controls.beforeResponse?.(); },
    output: () => ({ summary: "Synthetic original response", findings: [], directions: [], matches: [], missingInformation: [],
      artworkChecks: [], templateSlots: [], listingCopy: null, actions: [], replyDraft: null }) });
  const orders = new OrderService(database, native.originalVault, native.audit), inventory = new InventoryService(database, native.audit);
  const integrationVault = new SecretVault(Buffer.alloc(32, 73));
  const storageClient = new S3Client({ endpoint: process.env.S3_ENDPOINT, forcePathStyle: true, region: process.env.S3_REGION ?? "us-east-1",
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! } });
  const storage = new Storage(storageClient, process.env.S3_PRIVATE_BUCKET!), clam = new ClamAvScanner();
  const scan = { scan: (bytes: Uint8Array, fileName: string, mediaType: string) => clam.scan({ body: bytes, fileName, mediaType }) };
  const unavailable = async (): Promise<never> => { throw new Error("Synthetic asset-free recovery has no document or artwork job"); };
  const reports = new AmazonOrderReportService(database, native.originalVault, orders, native.audit,
    { download: unavailable, scan: bytes => clam.scan({ body: bytes, fileName: "synthetic-recovery.txt", mediaType: "text/plain" }) },
    { schedule: unavailable }, { schedule: unavailable });
  const editor = new ProductionEditorService(database, native.originalVault, storage, reports, native.audit, { enqueue: unavailable }, scan, native.originalVault);
  const orderWorkspace = new OrderWorkspaceService(database, native.originalVault, storage, reports, editor, scan);
  const contexts = new AssistContextService(database, orderWorkspace, null!, editor, null!, null!, native.answers);
  const assists = new AssistService(database, native.vault, contexts, queue);
  const gateway = () => new AgentReadService(database, orders, inventory, integrationVault);
  const integration = new IntegrationService(database, integrationVault, { enqueue: unavailable }, native.audit);
  const loader = new DatabaseApiClientContextLoader(database);
  const defaultScopes = Object.fromEntries(allAgentPermissions.map(bit => [bit, "tenant" as const]));
  const seed = (actor: Pick<AgentActor, "tenantId" | "userId">): TenantContext => ({ ...actor, permissions: allAgentPermissions,
    permissionScopes: defaultScopes, dataScope: "tenant", teamIds: [] });
  let a: AgentActor, second: AgentActor, foreign: AgentActor, modelId: string;
  const accounts = new Map<string, string>();

  async function current(actor: Pick<AgentActor, "tenantId" | "userId">) {
    return withTenant(database.db, { ...actor, permissions: [], dataScope: "self" }, tx => loadCurrentMembershipContext(tx, actor));
  }
  async function scopes(actor: AgentActor, values: Record<string, Scope>) {
    await withTenant(database.db, seed(actor), async tx => {
      for (const [permission, roleId] of actor.roleIds) if (!Object.hasOwn(values, permission))
        await tx.update(roles).set({ permissions: [] }).where(eq(roles.id, roleId));
      for (const [permission, dataScope] of Object.entries(values)) {
        const previous = actor.roleIds.get(permission);
        if (previous) await tx.update(roles).set({ permissions: [permission], dataScope }).where(eq(roles.id, previous));
        else {
          const roleId = createEntityId(); actor.roleIds.set(permission, roleId);
          await tx.insert(roles).values({ id: roleId, tenantId: actor.tenantId, name: `Synthetic read role ${roleId}`, permissions: [permission], dataScope });
          await tx.insert(membershipRoles).values({ tenantId: actor.tenantId, membershipId: actor.membershipId, roleId });
        }
      }
    });
    return current(actor);
  }
  async function actor(tenantId?: string, values: Record<string, Scope> = defaultScopes): Promise<AgentActor> {
    const value: AgentActor = { tenantId: tenantId ?? createEntityId(), userId: createEntityId(), subject: randomUUID(),
      membershipId: createEntityId(), roleIds: new Map(), context: null! };
    if (!tenantId) await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic agent reader',$2)", [value.tenantId, randomUUID()]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic original reader')",
      [value.userId, value.subject, `${value.userId}@example.invalid`]);
    await withTenant(database.db, seed(value), tx => tx.insert(memberships).values({ id: value.membershipId, tenantId: value.tenantId, userId: value.userId, status: "active" }));
    value.context = await scopes(value, values);
    return value;
  }
  async function team(actor: AgentActor) {
    const teamId = createEntityId(), memberId = createEntityId();
    await withTenant(database.db, seed(actor), async tx => {
      await tx.insert(organizationTeams).values({ id: teamId, tenantId: actor.tenantId, name: `Synthetic reader team ${teamId}`, createdBy: actor.userId });
      await tx.insert(organizationTeamMembers).values({ id: memberId, tenantId: actor.tenantId, teamId, membershipId: actor.membershipId, createdBy: actor.userId });
    });
    return { teamId, memberId };
  }
  async function memberActive(actor: AgentActor, active: boolean) {
    await withTenant(database.db, seed(actor), tx => tx.update(memberships).set({ status: active ? "active" : "disabled" }).where(eq(memberships.id, actor.membershipId)));
  }
  async function teamActive(actor: AgentActor, memberId: string, active: boolean) {
    await withTenant(database.db, seed(actor), tx => tx.update(organizationTeamMembers).set({ active,
      revision: sql`${organizationTeamMembers.revision}+1` }).where(eq(organizationTeamMembers.id, memberId)));
  }
  async function account(actor: AgentActor) {
    const existing = accounts.get(actor.tenantId); if (existing) return existing;
    const id = createEntityId();
    await withTenant(database.db, seed(actor), tx => tx.insert(marketplaceAccounts).values({ id, tenantId: actor.tenantId, platform: "etsy", displayName: "Synthetic metadata shop",
      region: "GLOBAL", authorizationMode: "etsy_oauth", createdBy: actor.userId }));
    accounts.set(actor.tenantId, id); return id;
  }
  async function order(actor = a) {
    const id = createEntityId();
    return orders.ingestNormalized(actor.context, { accountId: await account(actor), platform: "etsy", externalEventId: `${id}:1`, externalOrderId: id,
      providerStatus: "paid", placedAt: new Date().toISOString(), orderTotal: { amountMinor: 1000, currency: "USD" },
      lines: [{ externalLineId: `${id}-line`, externalListingId: null, skuCode: null, title: "Synthetic non-artwork item", quantity: 1,
        unitPrice: { amountMinor: 1000, currency: "USD" }, customizationCount: 0 }], redactedSource: { fixture: id }, protectedDetails: null });
  }
  async function exception(orderId: string, actor = a) {
    const basis = await orders.exceptionOperations(actor.context, orderId);
    return orders.openExceptionReviewed(actor.context, orderId, { category: "address", code: "SYNTHETIC_PRIVATE_CODE",
      message: "Synthetic private issue must never enter the read tool", idempotencyKey: randomUUID(),
      expectedOrderSequence: basis.orderSequence, expectedSourceChecksum: basis.sourceChecksum });
  }
  async function stock(actor = a, count = 3) {
    const suffix = createEntityId().slice(-12).toUpperCase();
    const warehouse = await inventory.createWarehouse(actor.context, { code: `QA-${suffix}`, name: "Synthetic exact inventory", type: "owned", countryCode: "US", timeZone: "UTC" });
    const item = await inventory.createStockItem(actor.context, { code: `MAT-${suffix}`, name: "Synthetic exact material", skuId: null, baseUnit: "meter" });
    const locations: string[] = [];
    for (let index = 0; index < count; index++) {
      const location = await inventory.createLocation(actor.context, { warehouseId: warehouse.id, code: `LOC-${index}`, name: `Synthetic location ${index}` });
      locations.push(location.id);
      await inventory.recordMovement(actor.context, { stockItemId: item.id, locationId: location.id, lotId: null, bucket: "physical", type: "opening",
        quantityDelta: "1.000000001", unit: "meter", sourceType: "opening", sourceId: `synthetic:${location.id}`, reasonCode: "INITIAL_COUNT",
        occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() });
    }
    await inventory.createReservation(actor.context, { stockItemId: item.id, locationId: locations[0]!, lotId: null, quantity: "0.000000001",
      unit: "meter", sourceType: "manual", sourceId: `synthetic:${item.id}`, expiresAt: null, idempotencyKey: randomUUID() });
    return { warehouseId: warehouse.id, stockItemId: item.id, locations };
  }
  async function knowledgeRequest(actor = a) {
    const label = `Synthetic recovery ${createEntityId()}`;
    const fields: KnowledgeFields = { title: label, summary: label, body: "Synthetic original response", topic: "operations", platform: "all", market: "ALL", spuId: null,
      sourceType: "team", sourceLabel: "Synthetic original source", sourceUrl: "", owner: "Synthetic reader", verifiedOn: "2020-01-01", reviewDueOn: "2099-12-31", tags: [] };
    const card = await native.knowledge.save(actor.context, null, { fields, expectedRevision: 0, reason: "Synthetic recovery source", requestId: randomUUID() });
    await native.knowledge.change(actor.context, card.id, "submit", { expectedRevision: 1, version: 1, reason: "Synthetic explicit source review", requestId: randomUUID() });
    await native.knowledge.change(actor.context, card.id, "publish", { expectedRevision: 2, version: 1, reason: "Synthetic explicit source publication", requestId: randomUUID() });
    return CreateAssistSchema.options[0].parse({ kind: "knowledge_answer", purpose: "dialogue", scopeId: randomUUID(), modelId, requestId: randomUUID(),
      search: { query: label, topic: "operations", platform: "all", market: "ALL", spuIds: [] } });
  }
  function proof(request: CreateAssist) {
    const requestChecksum = agentReadSha(assistRequestRecoveryText(request));
    if (requestChecksum !== assistFingerprint(CreateAssistSchema.parse(request))) throw new Error("Recovery proof differs from the original owner fingerprint");
    return { requestId: request.requestId, requestChecksum };
  }
  async function processRun(id: string, actor = a) {
    return native.processor.process(JobEnvelopeSchema.parse({ jobId: id, tenantId: actor.tenantId, requestedBy: actor.userId,
      correlationId: id, idempotencyKey: id, payload: { runId: id, operation: "analyze" } }));
  }
  async function state(context = a.context) {
    return withTenant(database.db, context, async tx => {
      const tables = ["orders", "order_lines", "order_source_snapshots", "order_exceptions", "order_exception_events", "order_events", "order_protected_access_events",
        "inventory_balances", "inventory_movements", "inventory_reservations", "inventory_reservation_events", "audit_events",
        "ai_assist_runs", "ai_assist_executions", "ai_budget_ledger", "knowledge_evaluation_runs", "knowledge_evaluation_protocols", "knowledge_evaluation_assessments"];
      const values: Record<string, { count: number; hash: string }> = {};
      for (const table of tables) values[table] = (await tx.execute<{ count: number; hash: string }>(sql`select count(*)::int as count,
        md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as hash from ${sql.identifier(table)} t`))[0]!;
      return { tables: values, dispatches: dispatches.length, providerRequests: providerRequests.length };
    });
  }
  async function initialize() {
    a = await actor(); second = await actor(a.tenantId); foreign = await actor();
    const providerId = createEntityId();
    await withTenant(database.db, a.context, tx => tx.execute(sql`insert into model_provider_configs(id,tenant_id,provider,label,endpoint,encrypted_api_key,created_by)
      values(${providerId}::uuid,${a.tenantId}::uuid,'openai-compatible','Synthetic recovery provider','https://synthetic-evaluation.invalid/v1',${native.modelVault.encrypt("synthetic-no-provider-credential")},${a.userId}::uuid)`));
    modelId = (await assists.addModel(a.context, { providerConfigId: providerId, model: "synthetic-recovery", label: "Synthetic original model",
      inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxTaskCostUsd: 1 })).id;
  }
  return { ...native, assists, contexts, orders, inventory, orderWorkspace, editor, integration, loader, gateway,
    integrationVault, controls, dispatches, providerRequests, initialize, current, scopes, actor, seed, team, memberActive, teamActive,
    order, exception, stock, knowledgeRequest, proof, process: processRun, state,
    get a() { return a; }, get second() { return second; }, get foreign() { return foreign; }, get modelId() { return modelId; },
    close() { storageClient.destroy(); },
    newAssists: () => new AssistService(database, native.vault, contexts, queue),
  };
}
