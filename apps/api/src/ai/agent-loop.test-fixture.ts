import { randomUUID } from "node:crypto";
import { OpenAiCompatibleProvider, type ModelResponseCheckpoint, type ResolvedModelRequest, type SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { AGENT_LOOP_VERSION, CreateAgentLoopSchema, AgentLoopDecisionSchema, defaultAgentLoopLimits,
  type AgentLoopDecision, type AgentLoopResult, type CreateAgentLoop } from "@yummyai/contracts/ai/agent-loop";
import type { AgentReadCall, AgentReadPageView } from "@yummyai/contracts/ai/agent-read";
import { agentLoopRuns, agentLoopSteps, aiBudgetLedger, withTenant, type DatabaseConnection } from "@yummyai/database";
import { AgentLoopRuntime } from "@yummyai/workflow-core";
import { AgentLoopTurnInputSchema, agentLoopChecksum, type AgentLoopTurnInput, type AgentLoopReadPort } from "../../../../packages/workflow-core/src/agent-loop-model.js";
import { sql } from "drizzle-orm";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { agentReadFixture, type AgentActor } from "./agent-read.test-fixture.js";
import { AgentLoopService, type AgentLoopDispatcher } from "./agent-loop.service.js";

export function requireAgentLoopEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment)), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const redis = environment.E2E_DISPOSABLE_REDIS_URL, loopback = ["localhost", "127.0.0.1", "[::1]"];
  if (!nonce || environment.E2E_AGENT_LOOP_ISOLATED !== "1" || environment.E2E_AGENT_READ_ISOLATED !== "1" || environment.E2E_ISOLATED_DAILY !== "1" ||
    environment.E2E_LEGACY_SCHEMA_TARGET !== "current" || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !loopback.includes(url.hostname) ||
    !redis || environment.REDIS_URL !== redis || environment.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` ||
    !["redis:", "rediss:"].includes(new URL(redis).protocol) || !loopback.includes(new URL(redis).hostname))
    throw new Error("Agent loop fixture requires every opt-in and exact current nonce database, bucket and Redis before connection");
  return { url: url.href, nonce };
}

export function finishLoop(packet: AgentLoopTurnInput): AgentLoopDecision {
  const claims: AgentLoopResult["claims"] = [];
  for (const collection of packet.collections) {
    if (collection.complete) claims.push({ stepId: collection.stepId, sourceId: "$collection", sourceChecksum: collection.collectionFingerprint, field: "total", value: collection.total });
    const row = collection.rows[0]; if (!row) continue;
    if ("physicalQuantity" in row.data) {
      claims.push({ stepId: collection.stepId, sourceId: row.sourceId, sourceChecksum: row.sourceChecksum, field: "physicalQuantity", value: row.data.physicalQuantity });
      claims.push({ stepId: collection.stepId, sourceId: row.sourceId, sourceChecksum: row.sourceChecksum, field: "unit", value: row.data.unit });
    } else claims.push({ stepId: collection.stepId, sourceId: row.sourceId, sourceChecksum: row.sourceChecksum, field: "category", value: row.data.category });
  }
  return AgentLoopDecisionSchema.parse({ action: "finish", label: "核对真实原字段并结束", read: null,
    result: { summary: "Synthetic transport reports only original owner fields; free prose is not a semantic correctness claim", claims,
      missingInformation: packet.collections.some(row => !row.complete) ? ["原集合仅有界读取 未证明全集"] : [] } });
}
export const inventoryDecision = (stockItemId: string | null = null): AgentLoopDecision => ({ action: "read", label: "读取原库存集合",
  read: { tool: "inventory.balances.page", query: { stockItemId, locationId: null } }, result: null });
export const exceptionDecision = (orderId: string | null = null): AgentLoopDecision => ({ action: "read", label: "读取原订单异常集合",
  read: { tool: "orders.exceptions.page", query: { orderId, status: "all" } }, result: null });

/** Identity/provider admission is synthetic. Orders, movements, reservations,
 * read pages, budget ownership, encrypted checkpoints and execution are real.
 * The only model boundary replaced is its HTTP transport. No marketplace,
 * artwork approval, physical production or business adoption occurs. */
export function agentLoopFixture(database: DatabaseConnection, options: { contentVault?: SecretVault; modelVault?: SecretVault } = {}) {
  requireAgentLoopEnvironment();
  const base = agentReadFixture(database), gateway = base.gateway();
  const dispatches: Array<Parameters<AgentLoopDispatcher["enqueue"]>[0]> = [];
  const modelCalls: AgentLoopTurnInput[] = [], readCalls: Array<{ context: TenantContext; input: AgentReadCall; page?: AgentReadPageView }> = [];
  const controls: { failQueue: boolean; unknownUsage: boolean;
    decision: (packet: AgentLoopTurnInput) => unknown;
    beforeModel?: (packet: AgentLoopTurnInput) => Promise<void>;
    afterCheckpoint?: (packet: AgentLoopTurnInput, value: ModelResponseCheckpoint) => Promise<void>;
    beforeRead?: (context: TenantContext, input: AgentReadCall) => Promise<void>;
    afterRead?: (page: AgentReadPageView) => Promise<void> } = {
      failQueue: false, unknownUsage: false, decision: packet => packet.collections.length ? finishLoop(packet) : inventoryDecision(),
    };
  const dispatcher: AgentLoopDispatcher = { enqueue: async input => { dispatches.push(input); if (controls.failQueue) throw new Error("Synthetic original loop queue unavailable"); } };
  const reads: AgentLoopReadPort = { workspace: context => gateway.workspace(context), call: async (context, input) => {
    const call: (typeof readCalls)[number] = { context, input }; readCalls.push(call);
    await controls.beforeRead?.(context, input); const page = await gateway.call(context, input); call.page = page;
    await controls.afterRead?.(page); return page;
  } };
  const service = (retentionSeconds?: number) => new AgentLoopService(database, options.contentVault ?? base.vault, gateway, dispatcher, retentionSeconds);
  const runtime = () => new AgentLoopRuntime({ database, contentVault: options.contentVault ?? base.vault, modelVault: options.modelVault ?? base.modelVault, reads,
    providerFactory: (provider, apiKey, model) => new class extends OpenAiCompatibleProvider {
      override generate<T>(request: ResolvedModelRequest<T>, signal: AbortSignal) {
        const packet = AgentLoopTurnInputSchema.parse(request.untrustedSourceData);
        return super.generate({ ...request, onResponseCheckpoint: async value => {
          await request.onResponseCheckpoint?.(value); await controls.afterCheckpoint?.(packet, value);
        } }, signal);
      }
    }({ providerId: provider.id, apiKey, endpoint: "https://synthetic-agent-loop.invalid/v1",
      pricing: model.inputUsdPerMillion === null || model.outputUsdPerMillion === null ? null : {
        inputUsdPerMillion: model.inputUsdPerMillion, outputUsdPerMillion: model.outputUsdPerMillion },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string; content?: unknown }> };
        const text = body.messages?.find(row => row.role === "user")?.content;
        if (typeof text !== "string") throw new Error("Synthetic loop received an invalid provider transport packet");
        const framed = /<untrusted_source_data>\n([\s\S]*)\n<\/untrusted_source_data>/.exec(text)?.[1];
        const packet = AgentLoopTurnInputSchema.parse(JSON.parse(framed ?? "null")); modelCalls.push(packet);
        await controls.beforeModel?.(packet);
        return Response.json({ id: "synthetic-loop-response-" + createEntityId(), choices: [{ message: { content: JSON.stringify(controls.decision(packet)) } }],
          ...(controls.unknownUsage ? {} : { usage: { prompt_tokens: 50, completion_tokens: 80 } }) });
      } }),
  });
  async function request(actor = base.a, changes: Partial<CreateAgentLoop> = {}) {
    const workspace = await service().workspace(await base.current(actor));
    return CreateAgentLoopSchema.parse({ version: AGENT_LOOP_VERSION, requestId: randomUUID(), modelId: base.modelId,
      goal: "Read original ERP fields using bounded tools and cite exact evidence", allowedTools: ["inventory.balances.page"],
      limits: defaultAgentLoopLimits(), maxCostUsd: 0.1, executionContract: workspace.executionContract, ...changes });
  }
  async function rows(context = base.a.context) {
    return withTenant(database.db, context, async tx => ({ runs: await tx.select().from(agentLoopRuns), steps: await tx.select().from(agentLoopSteps),
      ledgers: await tx.select().from(aiBudgetLedger), audits: await tx.execute<{ id: string; action: string; entity_id: string; metadata: unknown }>(sql`
        select id,action,entity_id,metadata from audit_events where action like 'agent.loop.%' order by id`) }));
  }
  async function physical(context = base.a.context) {
    const state = await base.state(context); return Object.fromEntries(Object.entries(state.tables).filter(([name]) => !["audit_events", "ai_budget_ledger"].includes(name)));
  }
  const clear = () => { controls.failQueue = false; controls.unknownUsage = false; controls.beforeModel = undefined; controls.beforeRead = undefined;
    controls.afterRead = undefined; controls.afterCheckpoint = undefined; controls.decision = packet => packet.collections.length ? finishLoop(packet) : inventoryDecision(); };
  return { base, gateway, service, runtime, controls, dispatches, modelCalls, readCalls, request, rows, physical, clear,
    initialize: () => base.initialize(), close: () => base.close(), checksum: agentLoopChecksum,
    process: (id: string, actor: AgentActor = base.a) => runtime().process(actor.context, id),
  };
}
