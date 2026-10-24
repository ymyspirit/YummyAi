import { randomUUID } from "node:crypto";
import { OpenAiCompatibleProvider, type ModelResponseCheckpoint, type ResolvedModelRequest, type SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { AgentCommandOriginalSchema, ConfirmAgentCommandSchema, AGENT_COMMAND_VERSION, type AgentCommandOriginal, type AgentCommandView } from "@yummyai/contracts/ai/agent-command";
import { AGENT_PLAN_VERSION, AgentPlanDecisionSchema, AgentPlanDraftSchema, CreateAgentPlanSchema, PrepareAgentPlanItemSchema,
  defaultAgentPlanLimits, type AgentPlanDecision, type AgentPlanView, type CreateAgentPlan } from "@yummyai/contracts/ai/agent-plan";
import type { AgentReadCall, AgentReadPageView } from "@yummyai/contracts/ai/agent-read";
import { agentPlanRuns, agentPlanSteps, agentPlanItems, agentCommandRequests, aiBudgetLedger, aiBudgetPolicies, withTenant, type DatabaseConnection } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { AgentPlanRuntime } from "../../../../packages/workflow-core/src/agent-plan-runtime.js";
import { AgentPlanTurnInputSchema, agentPlanChecksum, type AgentPlanTurnInput, type AgentPlanReadPort } from "../../../../packages/workflow-core/src/agent-plan-model.js";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { OrderRoutingService } from "../orders/order-routing.service.js";
import { agentCommandOwners } from "./agent-command.test-fixture.js";
import { agentReadFixture, type AgentActor } from "./agent-read.test-fixture.js";
import { AgentPlanService, type AgentPlanDispatcher } from "./agent-plan.service.js";

export function requireAgentPlanEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment)), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const redis = environment.E2E_DISPOSABLE_REDIS_URL, local = ["localhost", "127.0.0.1", "[::1]"];
  if (!nonce || ["E2E_AGENT_PLAN_ISOLATED", "E2E_AGENT_LOOP_ISOLATED", "E2E_AGENT_COMMAND_ISOLATED", "E2E_AGENT_READ_ISOLATED", "E2E_ISOLATED_DAILY"].some(key => environment[key] !== "1") ||
    environment.E2E_LEGACY_SCHEMA_TARGET !== "current" || !local.includes(url.hostname) || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` ||
    !redis || environment.REDIS_URL !== redis || environment.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` ||
    !["redis:", "rediss:"].includes(new URL(redis).protocol) || !local.includes(new URL(redis).hostname))
    throw new Error("Agent planning fixture requires every flag and exact current nonce DB, private bucket and Redis before construction or connection");
  return { url: url.href, nonce };
}

export function planClaims(packet: AgentPlanTurnInput) {
  const claims: NonNullable<AgentPlanDecision["result"]>["claims"] = [];
  for (const collection of packet.collections) {
    if (collection.complete) claims.push({ stepId: collection.stepId, sourceId: "$collection", sourceChecksum: collection.collectionFingerprint, field: "total", value: collection.total });
    const row = collection.rows[0]; if (!row) continue;
    if ("physicalQuantity" in row.data) {
      claims.push({ stepId: collection.stepId, sourceId: row.sourceId, sourceChecksum: row.sourceChecksum, field: "physicalQuantity", value: row.data.physicalQuantity });
      claims.push({ stepId: collection.stepId, sourceId: row.sourceId, sourceChecksum: row.sourceChecksum, field: "unit", value: row.data.unit });
    } else claims.push({ stepId: collection.stepId, sourceId: row.sourceId, sourceChecksum: row.sourceChecksum, field: "category", value: row.data.category });
  }
  return claims;
}

/** Synthetic model HTTP supplies decisions, never prepared or executed owner facts.
 * Draft amounts are explicitly operator-provided, not inferred from inventory.
 * Source claims verify exact cited fields only; business semantics still require
 * each original review and confirmation. No artwork approval or factory release. */
export function finishPlan(packet: AgentPlanTurnInput, originals: readonly AgentCommandOriginal[] = []): AgentPlanDecision {
  const claims = planClaims(packet);
  return AgentPlanDecisionSchema.parse({ action: "finish", label: "Offer individually reviewable original drafts", read: null,
    result: { summary: "Synthetic transport returns unapproved drafts; source fields do not prove proposed business parameters", claims,
      missingInformation: packet.collections.some(row => !row.complete) ? ["Original collection is only a bounded prefix"] : [],
      proposals: originals.map((original, position) => {
        const slot = packet.slots[position]; if (!slot) throw new Error("Synthetic draft exceeds actual server slots");
        return AgentPlanDraftSchema.parse({ position, capability: { domain: original.domain, kind: original.command.kind },
          label: `Synthetic ${original.domain} original draft`, reason: "Operator-provided fields need separate original-owner review",
          original: AgentCommandOriginalSchema.parse({ ...original, command: { ...original.command,
            input: { ...original.command.input, idempotencyKey: slot.idempotencyKey } } }), claims: claims.map(claim => ({ ...claim })), missingInformation: [] });
      }) } });
}

export function agentPlanFixture(database: DatabaseConnection, options: { contentVault?: SecretVault; modelVault?: SecretVault } = {}) {
  requireAgentPlanEnvironment();
  const base = agentReadFixture(database), gateway = base.gateway(), owners = agentCommandOwners(database, { contentVault: options.contentVault ?? base.vault });
  const dispatcherCalls: Array<Parameters<AgentPlanDispatcher["enqueue"]>[0]> = [];
  const modelCalls: AgentPlanTurnInput[] = [], readCalls: Array<{ context: TenantContext; input: AgentReadCall; page?: AgentReadPageView }> = [];
  const wire: Array<{ bodyBytes: number; schemaBytes: number }> = [];
  const controls: { failQueue: boolean; unknownUsage: boolean; decision: (packet: AgentPlanTurnInput) => unknown;
    beforeModel?: (packet: AgentPlanTurnInput) => Promise<void>;
    afterCheckpoint?: (packet: AgentPlanTurnInput, value: ModelResponseCheckpoint) => Promise<void>;
    beforeRead?: (context: TenantContext, input: AgentReadCall) => Promise<void>;
    afterRead?: (page: AgentReadPageView) => Promise<void> } = { failQueue: false, unknownUsage: false, decision: packet => finishPlan(packet) };
  const dispatcher: AgentPlanDispatcher = { enqueue: async value => { dispatcherCalls.push(value); if (controls.failQueue) throw new Error("Synthetic planner queue unavailable"); } };
  const reads: AgentPlanReadPort = { workspace: context => gateway.workspace(context), call: async (context, input) => {
    const call: (typeof readCalls)[number] = { context, input }; readCalls.push(call); await controls.beforeRead?.(context, input);
    const page = await gateway.call(context, input); call.page = page; await controls.afterRead?.(page); return page;
  } };
  const service = (retentionSeconds?: number) => new AgentPlanService(database, options.contentVault ?? base.vault, gateway, owners.service(), owners.adapter, dispatcher, retentionSeconds);
  const runtime = () => new AgentPlanRuntime({ database, contentVault: options.contentVault ?? base.vault, modelVault: options.modelVault ?? base.modelVault, reads,
    providerFactory: (provider, apiKey, model) => new class extends OpenAiCompatibleProvider {
      override generate<T>(request: ResolvedModelRequest<T>, signal: AbortSignal) {
        const packet = AgentPlanTurnInputSchema.parse(request.untrustedSourceData);
        return super.generate({ ...request, onResponseCheckpoint: async value => {
          await request.onResponseCheckpoint?.(value); await controls.afterCheckpoint?.(packet, value);
        } }, signal);
      }
    }({ providerId: provider.id, apiKey, endpoint: "https://synthetic-agent-plan.invalid/v1",
      pricing: model.inputUsdPerMillion === null || model.outputUsdPerMillion === null ? null : {
        inputUsdPerMillion: model.inputUsdPerMillion, outputUsdPerMillion: model.outputUsdPerMillion },
      fetch: async (_url, init) => {
        const text = String(init?.body), body = JSON.parse(text) as { messages?: Array<{ role?: string; content?: unknown }>; response_format?: unknown };
        const user = body.messages?.find(row => row.role === "user")?.content;
        const framed = typeof user === "string" ? /<untrusted_source_data>\n([\s\S]*)\n<\/untrusted_source_data>/.exec(user)?.[1] : undefined;
        const packet = AgentPlanTurnInputSchema.parse(JSON.parse(framed ?? "null")); modelCalls.push(packet);
        wire.push({ bodyBytes: Buffer.byteLength(text), schemaBytes: Buffer.byteLength(JSON.stringify(body.response_format ?? null)) });
        await controls.beforeModel?.(packet);
        return Response.json({ id: "synthetic-plan-" + createEntityId(), choices: [{ message: { content: JSON.stringify(controls.decision(packet)) } }],
          ...(controls.unknownUsage ? {} : { usage: { prompt_tokens: 50, completion_tokens: 80 } }) });
      } }),
  });
  async function request(actor = base.a, changes: Partial<CreateAgentPlan> = {}) {
    const workspace = await service().workspace(await base.current(actor));
    return CreateAgentPlanSchema.parse({ version: AGENT_PLAN_VERSION, requestId: randomUUID(), modelId: base.modelId,
      goal: "Read actual inventory and propose individually reviewable original commands", contextText: "Synthetic operator statements are not verified source evidence",
      allowedReads: ["inventory.balances.page"], allowedCommands: [{ domain: "procurement", kind: "requisition_create" }, { domain: "finance", kind: "bill_record" }],
      limits: defaultAgentPlanLimits(), maxCostUsd: 1, executionContract: workspace.executionContract, ...changes });
  }
  async function source(actor = base.a) {
    return sourceContext(await base.current(actor));
  }
  async function sourceContext(context: TenantContext) {
    const suffix = createEntityId().slice(-10).toUpperCase();
    const warehouse = await base.inventory.createWarehouse(context, { code: `PLAN-${suffix}`, name: "Synthetic original plan warehouse", type: "owned", countryCode: "US", timeZone: "UTC" });
    const material = await base.inventory.createStockItem(context, { code: `PLAN-MAT-${suffix}`, name: "Synthetic planner source", skuId: null, baseUnit: "meter" });
    const location = await base.inventory.createLocation(context, { warehouseId: warehouse.id, code: `PLAN-LOC-${suffix}`, name: "Synthetic planner location" });
    await base.inventory.recordMovement(context, { stockItemId: material.id, locationId: location.id, lotId: null, bucket: "physical", type: "opening", quantityDelta: "1.000000001", unit: "meter",
      sourceType: "opening", sourceId: "synthetic-plan:" + location.id, reasonCode: "INITIAL_COUNT", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() });
    const stock = { warehouseId: warehouse.id, stockItemId: material.id, locations: [location.id] };
    const routing = new OrderRoutingService(database, owners.orders, owners.audit);
    const supplier = await routing.createSupplier(context, { name: "Synthetic planner original supplier", kind: "manual", regionCode: "US", settlementCurrency: "USD", externalConnectionRef: null });
    const requisition = AgentCommandOriginalSchema.parse({ domain: "procurement", command: { kind: "requisition_create", targetId: null, input: {
      code: `PLAN-${suffix}`, reasonCode: "SYNTHETIC", lines: [{ lineKey: "LINE-1", stockItemId: stock.stockItemId,
        destinationLocationId: stock.locations[0], quantity: "2.5", unit: "meter" }], idempotencyKey: randomUUID() } } });
    const bill = AgentCommandOriginalSchema.parse({ domain: "finance", command: { kind: "bill_record", targetId: null, input: {
      supplierId: supplier.id, kind: "supplier_invoice", externalBillId: `SYNTHETIC-PLAN-${suffix}`, currency: "USD", amountMinor: 12345,
      issuedAt: "2026-07-01T00:00:00.000Z", dueAt: null, procurementInvoiceId: null, idempotencyKey: randomUUID() } } });
    return { ...stock, supplierId: supplier.id, requisition, bill, originals: [requisition, bill], contextText: "Synthetic operator supplied drafts, unverified until each original review: " + JSON.stringify([requisition, bill]) };
  }
  async function rows(context = base.a.context) {
    return withTenant(database.db, context, async tx => ({ runs: await tx.select().from(agentPlanRuns).orderBy(agentPlanRuns.id), steps: await tx.select().from(agentPlanSteps).orderBy(agentPlanSteps.id),
      items: await tx.select().from(agentPlanItems).orderBy(agentPlanItems.id), ledgers: await tx.select().from(aiBudgetLedger).orderBy(aiBudgetLedger.id), audits: await tx.execute<{ id: string; action: string; entity_id: string; metadata: unknown }>(sql`
        select id,action,entity_id,metadata from audit_events where action like 'agent.plan.%' order by id`) }));
  }
  async function business(context = base.a.context) {
    return withTenant(database.db, context, async tx => {
      const state: Record<string, { count: number; hash: string }> = {};
      for (const table of ["inventory_procurement_requisitions", "inventory_purchase_orders", "inventory_purchase_order_versions", "finance_payable_bills",
        "finance_payable_payments", "finance_original_write_proofs", "inventory_balances", "inventory_movements", "inventory_reservations", "production_orders", "ad_goal_versions"])
        state[table] = (await tx.execute<{ count: number; hash: string }>(sql`select count(*)::int as count,
          md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as hash from ${sql.identifier(table)} t`))[0]!;
      return state;
    });
  }
  const confirmation = (view: AgentCommandView) => ConfirmAgentCommandSchema.parse({ version: AGENT_COMMAND_VERSION, requestId: view.requestId,
    ownerCommandId: view.ownerCommandId, originalChecksum: view.originalChecksum, confirmationToken: view.confirmationToken, decision: "execute_original" });
  const prepareInput = (run: Pick<AgentPlanView, "requestId">, item: { proposalChecksum: string }) => PrepareAgentPlanItemSchema.parse({ version: AGENT_PLAN_VERSION, requestId: run.requestId, proposalChecksum: item.proposalChecksum });
  async function settlePrepared() {
    const context = await base.current(base.a), records = await withTenant(database.db, context, tx => tx.select().from(agentCommandRequests).where(eq(agentCommandRequests.ownerId, context.userId)));
    for (const row of records) {
      const reference = row.ownerCommandId ? { domain: row.binding.domain, commandId: row.ownerCommandId, accountId: row.binding.accountId } : await owners.adapter.locate(context, row.binding);
      if (!reference) continue;
      let current = await owners.adapter.read(context, reference);
      if (current.native.view.canCancel) current = await owners.adapter.cancel(context, reference);
      if (["succeeded", "cancelled", "rejected", "expired"].includes(current.native.view.status) && !current.native.view.acknowledged)
        await owners.adapter.acknowledge(context, reference);
    }
  }
  const clear = () => { controls.failQueue = false; controls.unknownUsage = false; controls.beforeModel = undefined; controls.beforeRead = undefined;
    controls.afterRead = undefined; controls.afterCheckpoint = undefined; controls.decision = packet => finishPlan(packet); };
  async function initialize() {
    await base.initialize();
    // Explicit synthetic configuration admission. The live test later updates
    // and restores this row without requesting an unauthorized DELETE grant.
    await withTenant(database.db, base.a.context, tx => tx.insert(aiBudgetPolicies).values({ tenantId: base.a.tenantId,
      monthlyCapUsd: "100", defaultTaskCapUsd: "1", taskCapsUsd: { erp_agent: 1, erp_agent_plan: 1 } }).onConflictDoNothing());
  }
  return { base, gateway, owners, service, runtime, dispatcherCalls, modelCalls, readCalls, wire, controls, request, source, sourceContext, rows, business, confirmation, prepareInput, settlePrepared, clear,
    checksum: agentPlanChecksum, initialize, close: () => base.close(),
    process: (id: string, actor: AgentActor = base.a) => runtime().process(actor.context, id) };
}
