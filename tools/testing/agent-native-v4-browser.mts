/** Isolated compiled-personal-browser support. Only the original fixture's
 * loopback Responses transport is synthetic; no queue consumer is started. */
import "../../apps/api/node_modules/reflect-metadata/Reflect.js";
import { intersectPermissionContexts } from "../../packages/authz/src/index.js";
import { createEnvironmentSecretVault } from "../../packages/ai-core/src/index.js";
import { TenantContextSchema, type TenantContext } from "../../packages/contracts/src/index.js";
import { AGENT_NATIVE_V4_VERSION, type AgentNativeV4ResolvedProposal } from "../../packages/contracts/src/ai/agent-native-v4.js";
import { AGENT_FULFILLMENT_COMMAND_VERSION, AcknowledgeAgentFulfillmentCommandSchema } from "../../packages/contracts/src/ai/agent-fulfillment-command.js";
import { FulfillmentCommandReceiptSchema, type FulfillmentCommandReceipt } from "../../packages/contracts/src/order/fulfillment-command.js";
import { agentPlanItems, agentPlanRuns, connectDatabase, loadCurrentMembershipContext, memberships, orderFulfillmentCommandIntents,
  users, withTenant, type DatabaseConnection } from "../../packages/database/src/index.js";
import { and, eq, sql } from "../../apps/api/node_modules/drizzle-orm/index.js";
import { createOrderPiiVault } from "../../apps/api/src/orders/order-pii-vault.js";
import { createIntegrationSecretVault } from "../../apps/api/src/integrations/integration-secret-vault.js";
import { ModelConfigurationService } from "../../apps/api/src/ai/model-configuration.service.js";
import { agentNativeV4Fixture } from "../../apps/api/src/ai/agent-native-v4.test-fixture.js";
import type { AgentActor } from "../../apps/api/src/ai/agent-read.test-fixture.js";
import { requireAgentNativeV4Environment } from "./require-agent-native-v4-environment.mjs";

type Fixture = ReturnType<typeof agentNativeV4Fixture>;
type FeedbackReceipt = Extract<FulfillmentCommandReceipt, { kind: "delivery_feedback" }>;
type Counter = { modelCalls: number; responses: number; paidProviderCalls: 0; workerProcesses: 0; providerFailures: number };
export type AgentNativeV4BrowserSeed = {
  version: typeof AGENT_NATIVE_V4_VERSION;
  runId: string;
  parentRequest: { requestId: string; requestChecksum: string };
  proposal: { itemId: string; position: number; proposalChecksum: string; originalProtocol: typeof AGENT_FULFILLMENT_COMMAND_VERSION;
    originalOrderId: string; originalChecksum: null; preparationRequestChecksum: null;
    operatorChecks: AgentNativeV4ResolvedProposal["operatorChecks"] };
  order: { orderId: string; lineId: string; productionOrderId: string; sequence: number };
  delivery: { packageId: string; itemId: string; expectedSequence: number; fileChecksum: string; manufacturingPlanChecksum: string };
  source: { stepId: string; resultIndex: number; dataChecksum: string; expectedSequence: number };
  model: { providerId: string; modelId: string };
  counters: Counter;
};
export type AgentNativeV4BrowserState = {
  run: { id: string; requestId: string; requestChecksum: string; status: string; revision: number; stopped: boolean;
    inputChecksum: string; resultChecksum: string | null; knownCostUsd: string; unknownCost: boolean; expiresAt: string };
  item: { id: string; proposalChecksum: string; originalProtocol: string | null; originalOrderId: string | null;
    originalChecksum: string | null; preparationRequestChecksum: string | null; completionChecksum: string | null;
    preparationRequested: boolean; fulfillmentIntentId: string | null };
  original: { id: string; requestId: string; requestChecksum: string; contractVersion: string; status: string; generation: number;
    leasePresent: boolean; acknowledged: boolean; redacted: boolean; privateAvailable: boolean | null;
    viewStatus: string | null; receipt: FeedbackReceipt | null } | null;
  originalRead: "not_linked" | "available" | "denied";
  counters: Counter;
};
export type AgentNativeV4BrowserBusiness = Record<string, { count: number; hash: string }>;
export type AgentNativeV4BrowserRequest = { nonce: string; id: number } & (
  { operation: "seed"; context: TenantContext } | { operation: "state" | "business" | "close" });
export type AgentNativeV4BrowserPacket =
  | { type: "ready"; nonce: string }
  | { type: "result"; nonce: string; id: number; value: AgentNativeV4BrowserSeed | AgentNativeV4BrowserState | AgentNativeV4BrowserBusiness | { closed: true } }
  | { type: "failure"; nonce: string; id?: number; phase: string; code: string | null };

const phases = new Set(["environment", "ready", "actual_personal_membership", "fixture_initialize", "caller_model", "original_source",
  "parent_start", "original_processor", "sealed_parent", "state", "business", "close_parent", "close_receipt", "close_original", "close_resources"]);
const send = (message: AgentNativeV4BrowserPacket) => new Promise<void>((done, reject) => {
  if (!process.connected || !process.send) { reject(new Error("native4_browser_ipc_required")); return; }
  process.send(message, error => error ? reject(error) : done());
});
const safeCodes = new Set(["native4_browser_ipc_required", "native4_browser_message_invalid", "native4_browser_child_required",
  "native4_browser_database_closed", "native4_browser_personal_context_missing", "native4_browser_parent_missing",
  "native4_browser_parent_identity_invalid", "native4_browser_original_identity_invalid", "native4_browser_seed_missing",
  "native4_browser_feedback_receipt_invalid", "native4_browser_original_not_acknowledgeable", "native4_browser_original_not_acknowledged",
  "native4_browser_cleanup_failed", "native4_browser_seed_already_started", "native4_browser_personal_actor_mismatch",
  "native4_browser_actual_membership_missing", "native4_browser_actual_model_channel_missing", "native4_browser_original_feedback_missing",
  "native4_browser_actual_parent_not_sealed", "native4_browser_original_source_mismatch", "native4_browser_business_projection_invalid"]);
function safeCode(error: unknown) {
  let cause = error;
  for (let depth = 0; depth < 7 && cause && typeof cause === "object"; depth++) {
    if ("code" in cause && typeof cause.code === "string" && /^[A-Z0-9]{5}$/.test(cause.code)) return cause.code;
    cause = "cause" in cause ? cause.cause : null;
  }
  return error instanceof Error && safeCodes.has(error.message) ? error.message : null;
}
function denied(error: unknown) {
  if (!error || typeof error !== "object") return false;
  if ("getStatus" in error && typeof error.getStatus === "function") return [403, 404].includes(Number(error.getStatus()));
  return "code" in error && error.code === "FORBIDDEN";
}
function request(raw: unknown, nonce: string): AgentNativeV4BrowserRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("native4_browser_message_invalid");
  const value = raw as Record<string, unknown>, fields = value.operation === "seed" ? ["nonce", "id", "operation", "context"] : ["nonce", "id", "operation"];
  if (value.nonce !== nonce || !Number.isSafeInteger(value.id) || Number(value.id) < 1 ||
    !["seed", "state", "business", "close"].includes(String(value.operation)) || Object.keys(value).length !== fields.length ||
    fields.some(field => !Object.hasOwn(value, field)) || Buffer.byteLength(JSON.stringify(value)) > 65_536)
    throw new Error("native4_browser_message_invalid");
  return value.operation === "seed"
    ? { nonce, id: Number(value.id), operation: "seed", context: TenantContextSchema.parse(value.context) }
    : { nonce, id: Number(value.id), operation: value.operation as "state" | "business" | "close" };
}

export async function agentNativeV4BrowserChild(): Promise<void> {
  // This strict browser guard precedes even construction of the lazy DB client.
  const environment = requireAgentNativeV4Environment(process.env, "current", true);
  if (!process.connected || !process.argv.includes("--agent-native-v4-browser-child") || process.env.TSX_DISABLE_CACHE !== "1")
    throw new Error("native4_browser_child_required");
  let database: DatabaseConnection | undefined = connectDatabase(environment.url), fixture: Fixture | undefined;
  let actor: AgentActor | undefined, ceiling: TenantContext | undefined, seeded: AgentNativeV4BrowserSeed | undefined;
  let run: { id: string; requestId: string } | undefined, item: { id: string; proposalChecksum: string } | undefined;
  let started = false, closed = false, phase = "ready", serial = Promise.resolve();
  const counters = (): Counter => ({ modelCalls: fixture?.modelCalls.length ?? 0, responses: fixture?.wire.length ?? 0,
    paidProviderCalls: 0, workerProcesses: 0, providerFailures: fixture?.providerFailures.length ?? 0 });
  const connection = () => { if (!database) throw new Error("native4_browser_database_closed"); return database; };
  const current = async () => {
    if (!ceiling) throw new Error("native4_browser_personal_context_missing");
    return withTenant(connection().db, ceiling, async tx => TenantContextSchema.parse(intersectPermissionContexts(ceiling!,
      await loadCurrentMembershipContext(tx, ceiling!, { lock: true }))));
  };
  const linked = async () => {
    if (!run || !item || !ceiling) throw new Error("native4_browser_parent_missing");
    return withTenant(connection().db, ceiling, async tx => {
      const [parent] = await tx.select({ id: agentPlanRuns.id, requestId: agentPlanRuns.requestId, requestChecksum: agentPlanRuns.requestChecksum,
        status: agentPlanRuns.status, revision: agentPlanRuns.revision, stopRequestedAt: agentPlanRuns.stopRequestedAt,
        inputChecksum: agentPlanRuns.inputChecksum, resultChecksum: agentPlanRuns.resultChecksum, knownCostUsd: agentPlanRuns.knownCostUsd,
        unknownCost: agentPlanRuns.unknownCost, expiresAt: agentPlanRuns.expiresAt }).from(agentPlanRuns)
        .where(and(eq(agentPlanRuns.id, run!.id), eq(agentPlanRuns.ownerId, ceiling!.userId), eq(agentPlanRuns.version, AGENT_NATIVE_V4_VERSION)));
      const [proposal] = await tx.select({ id: agentPlanItems.id, proposalChecksum: agentPlanItems.proposalChecksum,
        originalProtocol: agentPlanItems.originalProtocol, originalOrderId: agentPlanItems.originalOrderId, originalChecksum: agentPlanItems.originalChecksum,
        preparationRequestChecksum: agentPlanItems.preparationRequestChecksum, completionChecksum: agentPlanItems.completionChecksum,
        preparationRequestedAt: agentPlanItems.preparationRequestedAt, fulfillmentIntentId: agentPlanItems.fulfillmentIntentId }).from(agentPlanItems)
        .where(and(eq(agentPlanItems.runId, run!.id), eq(agentPlanItems.id, item!.id)));
      if (!parent || parent.requestId !== run!.requestId || !proposal || proposal.proposalChecksum !== item!.proposalChecksum)
        throw new Error("native4_browser_parent_identity_invalid");
      if (!proposal.fulfillmentIntentId) return { parent, proposal, original: null };
      const [original] = await tx.select({ id: orderFulfillmentCommandIntents.id, requestId: orderFulfillmentCommandIntents.requestId,
        requestChecksum: orderFulfillmentCommandIntents.requestChecksum, contractVersion: orderFulfillmentCommandIntents.contractVersion,
        orderId: orderFulfillmentCommandIntents.orderId, requestKey: orderFulfillmentCommandIntents.requestKey,
        status: orderFulfillmentCommandIntents.status, generation: orderFulfillmentCommandIntents.generation,
        leaseExpiresAt: orderFulfillmentCommandIntents.leaseExpiresAt, acknowledgedAt: orderFulfillmentCommandIntents.acknowledgedAt,
        redactedAt: orderFulfillmentCommandIntents.redactedAt }).from(orderFulfillmentCommandIntents)
        .where(and(eq(orderFulfillmentCommandIntents.id, proposal.fulfillmentIntentId), eq(orderFulfillmentCommandIntents.createdBy, ceiling!.userId)));
      if (!original || original.contractVersion !== AGENT_FULFILLMENT_COMMAND_VERSION || original.orderId !== proposal.originalOrderId ||
        original.requestId !== proposal.id || original.requestKey !== proposal.id || original.requestChecksum !== proposal.originalChecksum ||
        original.requestChecksum !== proposal.preparationRequestChecksum) throw new Error("native4_browser_original_identity_invalid");
      return { parent, proposal, original };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  };
  const state = async (): Promise<AgentNativeV4BrowserState> => {
    if (!fixture || !seeded) throw new Error("native4_browser_seed_missing");
    phase = "state"; const found = await linked();
    let originalRead: AgentNativeV4BrowserState["originalRead"] = "not_linked", privateAvailable: boolean | null = null;
    let viewStatus: string | null = null, receipt: FeedbackReceipt | null = null;
    if (found.original) {
      try {
        const view = await fixture.fulfillmentCommands.get(await current(), found.original.id,
          { version: AGENT_FULFILLMENT_COMMAND_VERSION, orderId: seeded.order.orderId });
        privateAvailable = view.privateAvailable; viewStatus = view.native.status; originalRead = "available";
        if (view.native.receipt) {
          const checked = FulfillmentCommandReceiptSchema.parse(view.native.receipt);
          if (checked.kind !== "delivery_feedback" || checked.packageId !== seeded.delivery.packageId || checked.itemId !== seeded.delivery.itemId)
            throw new Error("native4_browser_feedback_receipt_invalid");
          receipt = checked;
        }
      } catch (error) { if (!denied(error)) throw error; originalRead = "denied"; }
    }
    return { run: { id: found.parent.id, requestId: found.parent.requestId, requestChecksum: found.parent.requestChecksum,
      status: found.parent.status, revision: found.parent.revision, stopped: found.parent.stopRequestedAt !== null,
      inputChecksum: found.parent.inputChecksum, resultChecksum: found.parent.resultChecksum, knownCostUsd: found.parent.knownCostUsd,
      unknownCost: found.parent.unknownCost !== 0, expiresAt: found.parent.expiresAt.toISOString() },
    item: { id: found.proposal.id, proposalChecksum: found.proposal.proposalChecksum, originalProtocol: found.proposal.originalProtocol,
      originalOrderId: found.proposal.originalOrderId, originalChecksum: found.proposal.originalChecksum,
      preparationRequestChecksum: found.proposal.preparationRequestChecksum, completionChecksum: found.proposal.completionChecksum,
      preparationRequested: found.proposal.preparationRequestedAt !== null, fulfillmentIntentId: found.proposal.fulfillmentIntentId },
    original: found.original ? { id: found.original.id, requestId: found.original.requestId, requestChecksum: found.original.requestChecksum,
      contractVersion: found.original.contractVersion, status: found.original.status, generation: found.original.generation,
      leasePresent: found.original.leaseExpiresAt !== null, acknowledged: found.original.acknowledgedAt !== null, redacted: found.original.redactedAt !== null,
      privateAvailable, viewStatus, receipt } : null, originalRead, counters: counters() };
  };
  const close = async () => {
    if (closed) return;
    const failures: unknown[] = [];
    try {
      if (fixture && run && ceiling) {
        phase = "close_parent"; const context = await current();
        await fixture.service().stop(context, run.id, { version: AGENT_NATIVE_V4_VERSION, requestId: run.requestId });
        if (item) {
          phase = "close_receipt";
          // Exact GET receipt can recover an already-born original intent after
          // a lost UI response. It never calls original prepare or execute.
          await fixture.service().itemReceipt(context, run.id, item.id,
            { version: AGENT_NATIVE_V4_VERSION, requestId: run.requestId, proposalChecksum: item.proposalChecksum });
          const found = await linked();
          if (found.original) {
            phase = "close_original";
            const query = { version: AGENT_FULFILLMENT_COMMAND_VERSION, orderId: found.original.orderId };
            let view = await fixture.fulfillmentCommands.get(context, found.original.id, query);
            if (!view.native.acknowledged) {
              if (!view.canAcknowledge) throw new Error("native4_browser_original_not_acknowledgeable");
              view = await fixture.fulfillmentCommands.acknowledge(context, found.original.id,
                AcknowledgeAgentFulfillmentCommandSchema.parse({ ...query, requestId: view.native.requestId,
                  requestChecksum: view.native.requestChecksum, decision: "acknowledge_original" }));
            }
            if (!view.native.acknowledged) throw new Error("native4_browser_original_not_acknowledged");
          }
        }
      }
    } catch (error) { failures.push(error); }
    phase = "close_resources";
    try { await fixture?.close(); } catch (error) { failures.push(error); }
    try { await database?.client.end(); } catch (error) { failures.push(error); }
    database = undefined; closed = true;
    if (failures.length) throw new AggregateError(failures, "native4_browser_cleanup_failed");
  };
  const seed = async (caller: TenantContext): Promise<AgentNativeV4BrowserSeed> => {
    if (started || closed) throw new Error("native4_browser_seed_already_started"); started = true;
    phase = "actual_personal_membership";
    const configured = JSON.parse(process.env.ERP_FIXTURE_ACTORS ?? "null") as { operator?: { userId?: unknown; tenantId?: unknown } } | null;
    if (!configured?.operator || caller.userId !== configured.operator.userId || caller.tenantId !== configured.operator.tenantId)
      throw new Error("native4_browser_personal_actor_mismatch");
    const personal = await withTenant(connection().db, caller, async tx => {
      const context = TenantContextSchema.parse(intersectPermissionContexts(caller, await loadCurrentMembershipContext(tx, caller, { lock: true })));
      const [member] = await tx.select({ id: memberships.id, subject: users.oidcSubject }).from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.tenantId, context.tenantId),
          eq(memberships.userId, context.userId), eq(memberships.status, "active")));
      if (!member) throw new Error("native4_browser_actual_membership_missing");
      return { context, member };
    });
    ceiling = personal.context;
    actor = { tenantId: ceiling.tenantId, userId: ceiling.userId, context: ceiling, subject: personal.member.subject,
      membershipId: personal.member.id, roleIds: new Map() };
    const modelVault = createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config");
    fixture = agentNativeV4Fixture(connection(), { actor, contentVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist"),
      modelVault, orderVault: createOrderPiiVault(), integrationVault: createIntegrationSecretVault() });
    phase = "fixture_initialize"; await fixture.initialize();
    phase = "caller_model";
    const configuration = new ModelConfigurationService(connection(), modelVault), name = "Synthetic native V4 browser " + environment.nonce;
    const snapshot = await configuration.invoke(await current(), { operation: "channel.save", name, baseUrl: "https://synthetic-native-v4.invalid/v1",
      apiKey: "synthetic-no-provider-credential", textProtocol: "responses", models: [] });
    if (!("channels" in snapshot)) throw new Error("native4_browser_actual_model_channel_missing");
    const provider = snapshot.channels.find(channel => channel.name === name);
    if (!provider || provider.provider !== "openai" || provider.status !== "enabled") throw new Error("native4_browser_actual_model_channel_missing");
    const model = await fixture.base.assists.addModel(await current(), { providerConfigId: provider.id, model: "synthetic-native-v4-browser",
      label: "Synthetic native V4 browser " + environment.nonce, inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxTaskCostUsd: 1 });
    phase = "original_source"; const scenario = await fixture.scenario("delivery_feedback"), command = scenario.command;
    if (command.kind !== "delivery_feedback" || !command.input.manufacturingChecksum)
      throw new Error("native4_browser_original_feedback_missing");
    const manufacturingPlanChecksum = command.input.manufacturingChecksum;
    const input = await fixture.request(scenario, { modelId: model.id });
    phase = "parent_start"; const created = await fixture.service().start(await current(), input); run = { id: created.id, requestId: created.requestId };
    phase = "original_processor"; await fixture.process(created.id);
    phase = "sealed_parent"; const view = await fixture.service().get(await current(), created.id), proposal = view.result?.proposals[0], selected = view.items[0];
    if (!proposal || !selected || view.status !== "completed" || view.items.length !== 1 || view.result?.proposals.length !== 1 ||
      selected.id !== proposal.id || selected.originalProtocol !== AGENT_FULFILLMENT_COMMAND_VERSION || proposal.draft.fulfillment?.source.orderId !== scenario.scene.order.id ||
      selected.originalChecksum !== null || selected.preparationRequestChecksum !== null || proposal.draft.fulfillment?.original.kind !== "delivery_feedback" ||
      fixture.modelCalls.length !== 4 || fixture.wire.length !== 4 || fixture.providerFailures.length !== 0)
      throw new Error("native4_browser_actual_parent_not_sealed");
    item = { id: selected.id, proposalChecksum: selected.proposalChecksum };
    const suggestion = proposal.draft.fulfillment, production = scenario.scene.productions[0];
    if (!suggestion || !production || suggestion.original.kind !== "delivery_feedback" || suggestion.original.targetId !== command.targetId ||
      suggestion.original.packageId !== command.packageId)
      throw new Error("native4_browser_original_source_mismatch");
    return seeded = { version: AGENT_NATIVE_V4_VERSION, runId: view.id, parentRequest: fixture.proof(input),
      proposal: { itemId: selected.id, position: selected.position, proposalChecksum: selected.proposalChecksum,
        originalProtocol: AGENT_FULFILLMENT_COMMAND_VERSION, originalOrderId: scenario.scene.order.id,
        originalChecksum: null, preparationRequestChecksum: null, operatorChecks: proposal.operatorChecks },
      order: { orderId: scenario.scene.order.id, lineId: production.lineId, productionOrderId: production.order.id, sequence: suggestion.source.expectedSequence },
      delivery: { packageId: command.packageId, itemId: command.targetId, expectedSequence: command.input.expectedSequence,
        fileChecksum: command.input.fileChecksum, manufacturingPlanChecksum },
      source: { stepId: suggestion.source.stepId, resultIndex: suggestion.source.resultIndex, dataChecksum: suggestion.source.dataChecksum,
        expectedSequence: suggestion.source.expectedSequence }, model: { providerId: provider.id, modelId: model.id }, counters: counters() };
  };
  const fail = async (error: unknown, id?: number) => send({ type: "failure", nonce: environment.nonce, ...(id === undefined ? {} : { id }),
    phase: phases.has(phase) ? phase : "environment", code: safeCode(error) }).catch(() => {});
  process.on("disconnect", () => { void serial.then(close).catch(() => { process.exitCode = 1; }); });
  process.on("message", raw => {
    serial = serial.then(async () => {
      let message: AgentNativeV4BrowserRequest;
      try { message = request(raw, environment.nonce); } catch { return; }
      try {
        let value: AgentNativeV4BrowserSeed | AgentNativeV4BrowserState | AgentNativeV4BrowserBusiness | { closed: true };
        if (message.operation === "seed") value = await seed(message.context);
        else if (message.operation === "state") value = await state();
        else if (message.operation === "business") {
          phase = "business"; if (!fixture || !seeded) throw new Error("native4_browser_seed_missing");
          const original = await fixture.business();
          // Test-only protected-column digest, not another physical table. Keep
          // every original business column except the three lazy search fields;
          // the original full-table digest above remains present and unchanged.
          const [protectedWork] = await withTenant(connection().db, await current(), tx => tx.execute<{ count: number; hash: string }>(sql`
            select count(*)::integer as count,
              md5(coalesce(jsonb_agg(projected.row_json order by projected.row_json::text)::text,'[]')) as hash
            from (select to_jsonb(work)-'search_revision'-'search_specification_version_id'-'search_design_executor' as row_json
              from order_work_items work) projected
          `), { isolationLevel: "repeatable read", accessMode: "read only" });
          if (!protectedWork) throw new Error("native4_browser_business_projection_invalid");
          value = { ...original, order_work_items_without_search_projection: protectedWork };
          for (const row of Object.values(value)) if (!Number.isSafeInteger(row.count) || row.count < 0 || !/^[a-f0-9]{32,64}$/.test(row.hash))
            throw new Error("native4_browser_business_projection_invalid");
        } else { await close(); value = { closed: true }; }
        await send({ type: "result", nonce: environment.nonce, id: message.id, value });
        if (message.operation === "close" && process.connected) process.disconnect();
      } catch (error) { await fail(error, message.id); if (message.operation === "close") { process.exitCode = 1; if (process.connected) process.disconnect(); } }
    }).catch(async error => { process.exitCode = 1; await fail(error); await close().catch(() => {}); if (process.connected) process.disconnect(); });
  });
  await send({ type: "ready", nonce: environment.nonce });
}

if (process.argv.includes("--agent-native-v4-browser-child")) {
  void agentNativeV4BrowserChild().catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); });
}
