/** Restricted compiled-personal-browser IPC. Business and model checkpoints use
 * original owners; only the Responses provider is an owned loopback fixture. */
import "../../apps/api/node_modules/reflect-metadata/Reflect.js";
import { intersectPermissionContexts } from "../../packages/authz/src/index.js";
import { createEnvironmentSecretVault } from "../../packages/ai-core/src/index.js";
import { createEntityId, TenantContextSchema, type TenantContext } from "../../packages/contracts/src/index.js";
import { AGENT_NATIVE_V4_VERSION, type AgentNativeV4ResolvedProposal } from "../../packages/contracts/src/ai/agent-native-v4.js";
import { AGENT_FULFILLMENT_COMMAND_VERSION, AcknowledgeAgentFulfillmentCommandSchema } from "../../packages/contracts/src/ai/agent-fulfillment-command.js";
import { FulfillmentCommandReceiptSchema, type FulfillmentCommandReceipt } from "../../packages/contracts/src/order/fulfillment-command.js";
import { agentPlanItems, agentPlanRuns, connectDatabase, loadCurrentMembershipContext, memberships, orderFulfillmentCommandIntents,
  users, withTenant, type DatabaseConnection } from "../../packages/database/src/index.js";
import { and, eq, sql } from "../../apps/api/node_modules/drizzle-orm/index.js";
import { createOrderPiiVault } from "../../apps/api/src/orders/order-pii-vault.js";
import { createIntegrationSecretVault } from "../../apps/api/src/integrations/integration-secret-vault.js";
import { ModelConfigurationService } from "../../apps/api/src/ai/model-configuration.service.js";
import type { AgentActor } from "../../apps/api/src/ai/agent-read.test-fixture.js";
import type { ShipmentCreateFixture, ShipmentCreateScenario } from "../../apps/api/src/ai/agent-native-v4-shipment-create.test-fixture.js";
import { requireShipmentCreateEnvironment } from "./require-shipment-create-environment.mjs";

type ShipmentReceipt = Extract<FulfillmentCommandReceipt, { kind: "shipment_create" }>;
type Counter = { modelCalls: number; responses: number; paidProviderCalls: 0; workerProcesses: 0; providerFailures: number };
export type ShipmentCreateBrowserGroup = {
  lineId: string; productionOrderId: string; productionVersionId: string; qualityGroupId: string; qualityInspectionId: string;
  productionProjectionVersion: number; productionProjectionVersionAfterInspection: number; quantity: number;
  availableQuantity: number; result: "passed" | "failed";
};
export type ShipmentCreateBrowserSeed = {
  version: typeof AGENT_NATIVE_V4_VERSION; runId: string;
  parentRequest: { requestId: string; requestChecksum: string };
  proposal: { itemId: string; position: number; proposalChecksum: string; originalProtocol: typeof AGENT_FULFILLMENT_COMMAND_VERSION;
    originalOrderId: string; originalChecksum: null; preparationRequestChecksum: null;
    operatorChecks: AgentNativeV4ResolvedProposal["operatorChecks"] };
  order: { orderId: string; sequence: number; lines: Array<{ lineId: string; quantity: number; productionOrderId: string }> };
  groups: { aGood: ShipmentCreateBrowserGroup; aHeld: ShipmentCreateBrowserGroup; bGood: ShipmentCreateBrowserGroup };
  packages: Array<{ packageReferenceId: string; lines: Array<{ orderLineId: string; quantity: number }> }>;
  source: { stepId: string; resultIndex: number; dataChecksum: string; expectedSequence: number };
  model: { providerId: string; modelId: string }; counters: Counter;
};
export type ShipmentCreateBrowserShipment = {
  id: string; orderId: string; status: string; currentVersionNumber: number; approvedVersionNumber: number | null; wholeOrder: boolean;
  versions: Array<{ id: string; versionNumber: number; requestChecksum: string | null; productionSourceVersion: number | null }>;
  packages: Array<{ id: string; versionId: string; packageReferenceId: string }>;
  packageLines: Array<{ id: string; versionId: string; packageId: string; orderLineId: string; quantity: number }>;
  productionAllocations: Array<{ id: string; versionId: string; packageId: string; packageLineId: string; orderLineId: string;
    productionOrderId: string; productionVersionId: string; qualityInspectionId: string; qualityGroupId: string | null;
    productionProjectionVersion: number; quantity: number }>;
  reviewCount: number; trackingCount: number; writebackCount: number; manualConfirmationCount: number;
  physicalHandover: { shipmentVersionId: string | null; packageCount: number; dispatchedPackageCount: number; allDispatched: boolean };
};
export type ShipmentCreateBrowserState = {
  run: { id: string; requestId: string; requestChecksum: string; status: string; revision: number; stopped: boolean;
    inputChecksum: string; resultChecksum: string | null; knownCostUsd: string; unknownCost: boolean; expiresAt: string };
  item: { id: string; proposalChecksum: string; originalProtocol: string | null; originalOrderId: string | null;
    originalChecksum: string | null; preparationRequestChecksum: string | null; completionChecksum: string | null;
    preparationRequested: boolean; fulfillmentIntentId: string | null };
  original: { id: string; requestId: string; requestChecksum: string; contractVersion: string; status: string; generation: number;
    leasePresent: boolean; acknowledged: boolean; redacted: boolean; privateAvailable: boolean | null;
    viewStatus: string | null; receipt: ShipmentReceipt | null } | null;
  originalRead: "not_linked" | "available" | "denied"; shipment: ShipmentCreateBrowserShipment | null;
  shipmentFacts: Awaited<ReturnType<ShipmentCreateFixture["shipmentState"]>>; counters: Counter;
};
export type ShipmentCreateBrowserBusiness = Record<string, { count: number; hash: string }>;
export type ShipmentCreateBrowserRequest = { nonce: string; id: number } & (
  { operation: "seed"; context: TenantContext } | { operation: "state" | "business" | "close" });
export type ShipmentCreateBrowserPacket =
  | { type: "ready"; nonce: string }
  | { type: "result"; nonce: string; id: number; value: ShipmentCreateBrowserSeed | ShipmentCreateBrowserState | ShipmentCreateBrowserBusiness | { closed: true } }
  | { type: "failure"; nonce: string; id?: number; phase: string; code: string | null };

const phases = new Set(["environment", "fixture_load", "ready", "actual_personal_membership", "fixture_initialize", "caller_model",
  "original_plan", "sealed_parent", "state", "business", "close_parent", "close_receipt", "close_original", "close_resources"]);
const codes = new Set(["shipment_browser_ipc_required", "shipment_browser_message_invalid", "shipment_browser_child_required",
  "shipment_browser_database_closed", "shipment_browser_personal_context_missing", "shipment_browser_parent_missing",
  "shipment_browser_parent_identity_invalid", "shipment_browser_original_identity_invalid", "shipment_browser_seed_missing",
  "shipment_browser_receipt_invalid", "shipment_browser_original_not_acknowledgeable", "shipment_browser_original_not_acknowledged",
  "shipment_browser_cleanup_failed", "shipment_browser_seed_already_started", "shipment_browser_personal_actor_mismatch",
  "shipment_browser_actual_membership_missing", "shipment_browser_actual_model_channel_missing", "shipment_browser_actual_parent_not_sealed",
  "shipment_browser_original_source_mismatch", "shipment_browser_business_projection_invalid", "shipment_browser_shipment_identity_invalid"]);
const send = (message: ShipmentCreateBrowserPacket) => new Promise<void>((done, reject) => {
  if (!process.connected || !process.send) { reject(new Error("shipment_browser_ipc_required")); return; }
  process.send(message, error => error ? reject(error) : done());
});
function safeCode(error: unknown): string | null {
  let cause = error;
  for (let depth = 0; depth < 7 && cause && typeof cause === "object"; depth++) {
    if ("code" in cause && typeof cause.code === "string" && /^[A-Z0-9]{5}$/.test(cause.code)) return cause.code;
    cause = "cause" in cause ? cause.cause : null;
  }
  return error instanceof Error && codes.has(error.message) ? error.message : null;
}
function denied(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("getStatus" in error && typeof error.getStatus === "function") return [403, 404].includes(Number(error.getStatus()));
  return "code" in error && error.code === "FORBIDDEN";
}
function request(raw: unknown, nonce: string): ShipmentCreateBrowserRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("shipment_browser_message_invalid");
  const value = raw as Record<string, unknown>, fields = value.operation === "seed" ? ["nonce", "id", "operation", "context"] : ["nonce", "id", "operation"];
  if (value.nonce !== nonce || !Number.isSafeInteger(value.id) || Number(value.id) < 1 ||
    !["seed", "state", "business", "close"].includes(String(value.operation)) || Object.keys(value).length !== fields.length ||
    fields.some(field => !Object.hasOwn(value, field)) || Buffer.byteLength(JSON.stringify(value)) > 65_536)
    throw new Error("shipment_browser_message_invalid");
  return value.operation === "seed"
    ? { nonce, id: Number(value.id), operation: "seed", context: TenantContextSchema.parse(value.context) }
    : { nonce, id: Number(value.id), operation: value.operation as "state" | "business" | "close" };
}
function groupPin(scenario: ShipmentCreateScenario, group: ShipmentCreateScenario["groups"]["aGood"]): ShipmentCreateBrowserGroup {
  const source = scenario.workspace.sources.find(row => row.orderLineId === group.lineId && row.qualityGroupId === group.id);
  if (!source || source.productionOrderId !== group.productionOrderId || source.productionVersionId !== group.productionVersionId ||
    source.qualityInspectionId !== group.inspectionId || source.projectionVersion !== group.productionProjectionVersion)
    throw new Error("shipment_browser_original_source_mismatch");
  return { lineId: group.lineId, productionOrderId: group.productionOrderId, productionVersionId: group.productionVersionId,
    qualityGroupId: group.id, qualityInspectionId: group.inspectionId, productionProjectionVersion: group.productionProjectionVersion,
    productionProjectionVersionAfterInspection: group.productionProjectionVersionAfterInspection, quantity: group.quantity,
    availableQuantity: source.availableQuantity, result: group.result };
}
function shipmentProjection(value: Awaited<ReturnType<ShipmentCreateFixture["owners"]["shipping"]["get"]>>): ShipmentCreateBrowserShipment {
  const byId = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
  return { id: value.shipment.id, orderId: value.shipment.orderId, status: value.shipment.status,
    currentVersionNumber: value.shipment.currentVersionNumber, approvedVersionNumber: value.shipment.approvedVersionNumber, wholeOrder: value.shipment.wholeOrder,
    versions: byId(value.versions.map(row => ({ id: row.id, versionNumber: row.versionNumber, requestChecksum: row.requestChecksum, productionSourceVersion: row.productionSourceVersion }))),
    packages: byId(value.packages.map(row => ({ id: row.id, versionId: row.shipmentVersionId, packageReferenceId: row.packageReferenceId }))),
    packageLines: byId(value.packageLines.map(row => ({ id: row.id, versionId: row.shipmentVersionId, packageId: row.packageId, orderLineId: row.orderLineId, quantity: row.quantity }))),
    productionAllocations: byId(value.productionAllocations.map(row => ({ id: row.id, versionId: row.shipmentVersionId, packageId: row.packageId,
      packageLineId: row.packageLineId, orderLineId: row.orderLineId, productionOrderId: row.productionOrderId, productionVersionId: row.productionVersionId,
      qualityInspectionId: row.qualityInspectionId, qualityGroupId: row.qualityGroupId, productionProjectionVersion: row.productionProjectionVersion, quantity: row.quantity }))),
    reviewCount: value.reviews.length, trackingCount: value.tracking.length, writebackCount: value.writebacks.length,
    manualConfirmationCount: value.manualConfirmations.length, physicalHandover: value.physicalHandover };
}

export async function shipmentCreateBrowserChild(): Promise<void> {
  // No fixture module is evaluated, nor a DB client constructed, before admission.
  const environment = requireShipmentCreateEnvironment(process.env, "current", true);
  if (!process.connected || !process.argv.includes("--shipment-create-browser-child") || process.env.TSX_DISABLE_CACHE !== "1")
    throw new Error("shipment_browser_child_required");
  const { shipmentCreateFixture } = await import("../../apps/api/src/ai/agent-native-v4-shipment-create.test-fixture.js");
  let database: DatabaseConnection | undefined = connectDatabase(environment.url), fixture: ShipmentCreateFixture | undefined;
  let ceiling: TenantContext | undefined, seeded: ShipmentCreateBrowserSeed | undefined;
  let run: { id: string; requestId: string } | undefined, item: { id: string; proposalChecksum: string } | undefined;
  let started = false, closed = false, phase = "ready", serial = Promise.resolve(), closing: Promise<void> | undefined;
  const counters = (): Counter => ({ modelCalls: fixture?.native.modelCalls.length ?? 0, responses: fixture?.native.wire.length ?? 0,
    paidProviderCalls: 0, workerProcesses: 0, providerFailures: fixture?.native.providerFailures.length ?? 0 });
  const connection = () => { if (!database) throw new Error("shipment_browser_database_closed"); return database; };
  const current = async () => {
    if (!ceiling) throw new Error("shipment_browser_personal_context_missing");
    const initial = ceiling;
    return withTenant(connection().db, initial, async tx => TenantContextSchema.parse(intersectPermissionContexts(initial,
      await loadCurrentMembershipContext(tx, initial, { lock: true }))));
  };
  const linked = async () => {
    if (!run || !item) throw new Error("shipment_browser_parent_missing");
    const context = await current(), originalRun = run, originalItem = item;
    return withTenant(connection().db, context, async tx => {
      const [parent] = await tx.select({ id: agentPlanRuns.id, requestId: agentPlanRuns.requestId, requestChecksum: agentPlanRuns.requestChecksum,
        status: agentPlanRuns.status, revision: agentPlanRuns.revision, stopRequestedAt: agentPlanRuns.stopRequestedAt,
        inputChecksum: agentPlanRuns.inputChecksum, resultChecksum: agentPlanRuns.resultChecksum, knownCostUsd: agentPlanRuns.knownCostUsd,
        unknownCost: agentPlanRuns.unknownCost, expiresAt: agentPlanRuns.expiresAt }).from(agentPlanRuns)
        .where(and(eq(agentPlanRuns.id, originalRun.id), eq(agentPlanRuns.ownerId, context.userId), eq(agentPlanRuns.version, AGENT_NATIVE_V4_VERSION)));
      const [proposal] = await tx.select({ id: agentPlanItems.id, proposalChecksum: agentPlanItems.proposalChecksum,
        originalProtocol: agentPlanItems.originalProtocol, originalOrderId: agentPlanItems.originalOrderId, originalChecksum: agentPlanItems.originalChecksum,
        preparationRequestChecksum: agentPlanItems.preparationRequestChecksum, completionChecksum: agentPlanItems.completionChecksum,
        preparationRequestedAt: agentPlanItems.preparationRequestedAt, fulfillmentIntentId: agentPlanItems.fulfillmentIntentId }).from(agentPlanItems)
        .where(and(eq(agentPlanItems.runId, originalRun.id), eq(agentPlanItems.id, originalItem.id)));
      if (!parent || parent.requestId !== originalRun.requestId || !proposal || proposal.proposalChecksum !== originalItem.proposalChecksum)
        throw new Error("shipment_browser_parent_identity_invalid");
      if (!proposal.fulfillmentIntentId) return { parent, proposal, original: null };
      const [original] = await tx.select({ id: orderFulfillmentCommandIntents.id, requestId: orderFulfillmentCommandIntents.requestId,
        requestChecksum: orderFulfillmentCommandIntents.requestChecksum, contractVersion: orderFulfillmentCommandIntents.contractVersion,
        orderId: orderFulfillmentCommandIntents.orderId, kind: orderFulfillmentCommandIntents.kind, targetId: orderFulfillmentCommandIntents.targetId,
        requestKey: orderFulfillmentCommandIntents.requestKey, status: orderFulfillmentCommandIntents.status, generation: orderFulfillmentCommandIntents.generation,
        leaseExpiresAt: orderFulfillmentCommandIntents.leaseExpiresAt, acknowledgedAt: orderFulfillmentCommandIntents.acknowledgedAt,
        redactedAt: orderFulfillmentCommandIntents.redactedAt }).from(orderFulfillmentCommandIntents)
        .where(and(eq(orderFulfillmentCommandIntents.id, proposal.fulfillmentIntentId), eq(orderFulfillmentCommandIntents.createdBy, context.userId)));
      if (!original || original.contractVersion !== AGENT_FULFILLMENT_COMMAND_VERSION || original.kind !== "shipment_create" ||
        original.orderId !== proposal.originalOrderId || original.targetId !== original.orderId || original.requestId !== proposal.id ||
        original.requestKey !== proposal.id || original.requestChecksum !== proposal.originalChecksum || original.requestChecksum !== proposal.preparationRequestChecksum)
        throw new Error("shipment_browser_original_identity_invalid");
      return { parent, proposal, original };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  };
  const state = async (): Promise<ShipmentCreateBrowserState> => {
    if (!fixture || !seeded) throw new Error("shipment_browser_seed_missing");
    phase = "state"; const found = await linked();
    let originalRead: ShipmentCreateBrowserState["originalRead"] = "not_linked", privateAvailable: boolean | null = null;
    let viewStatus: string | null = null, receipt: ShipmentReceipt | null = null, shipment: ShipmentCreateBrowserShipment | null = null;
    if (found.original) {
      try {
        const view = await fixture.native.fulfillmentCommands.get(await current(), found.original.id,
          { version: AGENT_FULFILLMENT_COMMAND_VERSION, orderId: seeded.order.orderId });
        privateAvailable = view.privateAvailable; viewStatus = view.native.status; originalRead = "available";
        if (view.native.receipt) {
          const checked = FulfillmentCommandReceiptSchema.parse(view.native.receipt);
          if (checked.kind !== "shipment_create") throw new Error("shipment_browser_receipt_invalid");
          receipt = checked;
          const original = await fixture.owners.shipping.get(await current(), checked.shipmentId);
          if (original.shipment.id !== checked.shipmentId || original.shipment.orderId !== seeded.order.orderId ||
            !original.versions.some(row => row.id === checked.versionId && row.versionNumber === checked.versionNumber))
            throw new Error("shipment_browser_shipment_identity_invalid");
          shipment = shipmentProjection(original);
        }
      } catch (error) { if (!denied(error)) throw error; originalRead = "denied"; receipt = null; shipment = null; privateAvailable = null; viewStatus = null; }
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
      privateAvailable, viewStatus, receipt } : null, originalRead, shipment, shipmentFacts: await fixture.shipmentState(seeded.order.orderId), counters: counters() };
  };
  const close = () => closing ??= (async () => {
    if (closed) return;
    const failures: unknown[] = [];
    try {
      if (fixture && run) {
        phase = "close_parent"; const context = await current();
        await fixture.native.service().stop(context, run.id, { version: AGENT_NATIVE_V4_VERSION, requestId: run.requestId });
        if (item) {
          phase = "close_receipt";
          await fixture.native.service().itemReceipt(context, run.id, item.id,
            { version: AGENT_NATIVE_V4_VERSION, requestId: run.requestId, proposalChecksum: item.proposalChecksum });
          const found = await linked();
          if (found.original) {
            phase = "close_original";
            const query = { version: AGENT_FULFILLMENT_COMMAND_VERSION, orderId: found.original.orderId };
            let view = await fixture.native.fulfillmentCommands.get(context, found.original.id, query);
            if (!view.native.acknowledged) {
              if (!view.canAcknowledge) throw new Error("shipment_browser_original_not_acknowledgeable");
              view = await fixture.native.fulfillmentCommands.acknowledge(context, found.original.id,
                AcknowledgeAgentFulfillmentCommandSchema.parse({ ...query, requestId: view.native.requestId,
                  requestChecksum: view.native.requestChecksum, decision: "acknowledge_original" }));
            }
            if (!view.native.acknowledged) throw new Error("shipment_browser_original_not_acknowledged");
          }
        }
      }
    } catch (error) { failures.push(error); }
    phase = "close_resources";
    // The wrapper owns native.settle/close and all original scene cleanup. Call
    // that chain once; the exact UI-created child above is outside its map.
    try { await fixture?.close(); } catch (error) { failures.push(error); }
    try { await database?.client.end(); } catch (error) { failures.push(error); }
    database = undefined; closed = true;
    if (failures.length) throw new AggregateError(failures, "shipment_browser_cleanup_failed");
  })();
  const seed = async (caller: TenantContext): Promise<ShipmentCreateBrowserSeed> => {
    if (started || closed) throw new Error("shipment_browser_seed_already_started"); started = true;
    phase = "actual_personal_membership";
    const configured = JSON.parse(process.env.ERP_FIXTURE_ACTORS ?? "null") as { operator?: { userId?: unknown; tenantId?: unknown } } | null;
    if (!configured?.operator || caller.userId !== configured.operator.userId || caller.tenantId !== configured.operator.tenantId)
      throw new Error("shipment_browser_personal_actor_mismatch");
    const personal = await withTenant(connection().db, caller, async tx => {
      const context = TenantContextSchema.parse(intersectPermissionContexts(caller, await loadCurrentMembershipContext(tx, caller, { lock: true })));
      const [member] = await tx.select({ id: memberships.id, subject: users.oidcSubject }).from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.tenantId, context.tenantId),
          eq(memberships.userId, context.userId), eq(memberships.status, "active")));
      if (!member) throw new Error("shipment_browser_actual_membership_missing");
      return { context, member };
    });
    ceiling = personal.context;
    const actor: AgentActor = { tenantId: ceiling.tenantId, userId: ceiling.userId, context: ceiling, subject: personal.member.subject,
      membershipId: personal.member.id, roleIds: new Map() };
    const modelVault = createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config");
    fixture = shipmentCreateFixture(connection(), { actor, contentVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist"),
      modelVault, orderVault: createOrderPiiVault(), integrationVault: createIntegrationSecretVault() });
    phase = "fixture_initialize"; await fixture.initialize();
    phase = "caller_model";
    // Browser leaves share one nonce and retain their model rows until DB teardown.
    const configuration = new ModelConfigurationService(connection(), modelVault), name = `Shipment ${environment.nonce} ${createEntityId()}`;
    const snapshot = await configuration.invoke(await current(), { operation: "channel.save", name, baseUrl: "https://synthetic-shipment-create.invalid/v1",
      apiKey: "synthetic-no-provider-credential", textProtocol: "responses", models: [] });
    if (!("channels" in snapshot)) throw new Error("shipment_browser_actual_model_channel_missing");
    const provider = snapshot.channels.find(channel => channel.name === name);
    if (!provider || provider.provider !== "openai" || provider.status !== "enabled") throw new Error("shipment_browser_actual_model_channel_missing");
    const model = await fixture.native.base.assists.addModel(await current(), { providerConfigId: provider.id, model: "synthetic-shipment-create-browser",
      label: name, inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxTaskCostUsd: 1 });
    phase = "original_plan"; const planned = await fixture.plan({ modelId: model.id });
    run = { id: planned.view.id, requestId: planned.view.requestId };
    phase = "sealed_parent";
    const { view, item: selected, scenario } = planned, proposal = view.result?.proposals[0], suggestion = proposal?.draft.fulfillment;
    if (!proposal || !suggestion || view.status !== "completed" || view.items.length !== 1 || view.result?.proposals.length !== 1 ||
      selected.id !== proposal.id || selected.originalProtocol !== AGENT_FULFILLMENT_COMMAND_VERSION || suggestion.original.kind !== "shipment_create" ||
      suggestion.source.orderId !== scenario.scene.order.id || suggestion.original.targetId !== scenario.scene.order.id ||
      selected.originalChecksum !== null || selected.preparationRequestChecksum !== null || counters().modelCalls !== 4 || counters().responses !== 4 || counters().providerFailures !== 0)
      throw new Error("shipment_browser_actual_parent_not_sealed");
    item = { id: selected.id, proposalChecksum: selected.proposalChecksum };
    const orderLines = scenario.scene.productions.map(production => ({ lineId: production.lineId, quantity: production.quantity, productionOrderId: production.order.id }));
    if (orderLines.length !== 2 || scenario.command.kind !== "shipment_create" || scenario.command.targetId !== scenario.scene.order.id || scenario.command.input.packages.length !== 2)
      throw new Error("shipment_browser_original_source_mismatch");
    return seeded = { version: AGENT_NATIVE_V4_VERSION, runId: view.id, parentRequest: fixture.native.proof(planned.input),
      proposal: { itemId: selected.id, position: selected.position, proposalChecksum: selected.proposalChecksum,
        originalProtocol: AGENT_FULFILLMENT_COMMAND_VERSION, originalOrderId: scenario.scene.order.id, originalChecksum: null,
        preparationRequestChecksum: null, operatorChecks: proposal.operatorChecks },
      order: { orderId: scenario.scene.order.id, sequence: suggestion.source.expectedSequence, lines: orderLines },
      groups: { aGood: groupPin(scenario, scenario.groups.aGood), aHeld: groupPin(scenario, scenario.groups.aHeld), bGood: groupPin(scenario, scenario.groups.bGood) },
      packages: scenario.command.input.packages.map(pkg => ({ packageReferenceId: pkg.packageReferenceId,
        lines: pkg.lines.map(line => ({ orderLineId: line.orderLineId, quantity: line.quantity })) })),
      source: { stepId: suggestion.source.stepId, resultIndex: suggestion.source.resultIndex, dataChecksum: suggestion.source.dataChecksum,
        expectedSequence: suggestion.source.expectedSequence }, model: { providerId: provider.id, modelId: model.id }, counters: counters() };
  };
  const business = async (): Promise<ShipmentCreateBrowserBusiness> => {
    phase = "business"; if (!fixture || !seeded) throw new Error("shipment_browser_seed_missing");
    const original = await fixture.business();
    // Test projection, not a physical table or an exclusion from the original
    // digest. All unknown original work columns remain protected by this hash.
    const [protectedWork] = await withTenant(connection().db, await current(), tx => tx.execute<{ count: number; hash: string }>(sql`
      select count(*)::integer as count,
        md5(coalesce(jsonb_agg(projected.row_json order by projected.row_json::text)::text,'[]')) as hash
      from (select to_jsonb(work)-'search_revision'-'search_specification_version_id'-'search_design_executor' as row_json
        from order_work_items work) projected
    `), { isolationLevel: "repeatable read", accessMode: "read only" });
    if (!protectedWork) throw new Error("shipment_browser_business_projection_invalid");
    const value = { ...original, order_work_items_without_search_projection: protectedWork };
    for (const row of Object.values(value)) if (!Number.isSafeInteger(row.count) || row.count < 0 || !/^[a-f0-9]{32,64}$/.test(row.hash))
      throw new Error("shipment_browser_business_projection_invalid");
    return value;
  };
  const fail = async (error: unknown, id?: number) => send({ type: "failure", nonce: environment.nonce, ...(id === undefined ? {} : { id }),
    phase: phases.has(phase) ? phase : "environment", code: safeCode(error) }).catch(() => {});
  process.on("disconnect", () => { void serial.then(close).catch(() => { process.exitCode = 1; }); });
  process.on("message", raw => {
    serial = serial.then(async () => {
      let message: ShipmentCreateBrowserRequest;
      try { message = request(raw, environment.nonce); } catch { return; }
      try {
        let value: ShipmentCreateBrowserSeed | ShipmentCreateBrowserState | ShipmentCreateBrowserBusiness | { closed: true };
        if (message.operation === "seed") value = await seed(message.context);
        else if (message.operation === "state") value = await state();
        else if (message.operation === "business") value = await business();
        else { await close(); value = { closed: true }; }
        await send({ type: "result", nonce: environment.nonce, id: message.id, value });
        if (message.operation === "close" && process.connected) process.disconnect();
      } catch (error) { await fail(error, message.id); if (message.operation === "close") { process.exitCode = 1; if (process.connected) process.disconnect(); } }
    }).catch(async error => { process.exitCode = 1; await fail(error); await close().catch(() => {}); if (process.connected) process.disconnect(); });
  });
  await send({ type: "ready", nonce: environment.nonce });
}

if (process.argv.includes("--shipment-create-browser-child")) {
  void shipmentCreateBrowserChild().catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); });
}
