import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../common/canonical-json.js";
import { FulfillmentCommandKindSchema } from "../order/fulfillment-command.js";
import { AGENT_COMMAND_VERSION, AgentCommandOriginalSchema } from "./agent-command.js";
import { AGENT_FULFILLMENT_COMMAND_VERSION, PrepareAgentFulfillmentCommandSchema } from "./agent-fulfillment-command.js";
import { AGENT_COMMAND_V2_DEFINITION_VERSION, AgentCommandV2KeySchema } from "./agent-command-v2-discovery.js";
import { AGENT_FULFILLMENT_PROPOSAL_VERSION, agentFulfillmentOperatorChecks, parseAgentFulfillmentSuggestion } from "./agent-fulfillment-proposal.js";
import { AGENT_FULFILLMENT_TOOL, AgentFulfillmentResultSchema } from "./agent-fulfillment.js";
import { AgentPlanCommandKeySchema } from "./agent-plan.js";
import { AgentLoopClaimSchema } from "./agent-loop.js";
import { AGENT_TOOLS_VERSION, AgentToolDefinitionSchema } from "./agent-tools.js";
import { AGENT_NATIVE_VERSION, CreateAgentNativeSchema, AgentNativeDraftSchema, defaultAgentNativeLimits } from "./agent-native.js";
import { AGENT_NATIVE_V2_VERSION, CreateAgentNativeV2Schema, AgentNativeV2BindingSchema } from "./agent-native-v2.js";
import { AGENT_NATIVE_V3_VERSION, CreateAgentNativeV3Schema, AgentNativeV3DefinitionSchema,
  AgentNativeV3ModelResultSchema, AgentNativeV3ItemReceiptSchema, AgentNativeV3ViewSchema } from "./agent-native-v3.js";
import {
  AGENT_NATIVE_V4_VERSION, AgentNativeV4BindingSchema, AgentNativeV4ReadKeySchema, CreateAgentNativeV4Schema,
  defaultAgentNativeV4Limits, canonicalAgentNativeV4Request, AgentNativeV4ReadRequestSchema,
  AgentNativeV4DefinitionSchema, agentNativeV4DefinitionSelection, AgentNativeV4ModelDraftSchema,
  AgentNativeV4ModelResultSchema, AgentNativeV4DecisionSchema, AgentNativeV4ResolvedDraftSchema,
  AgentNativeV4ResolvedProposalSchema, AgentNativeV4ResultSchema, AgentNativeV4ItemViewSchema,
  AgentNativeV4ViewSchema, AgentNativeV4ObservationSchema, AgentNativeV4ReceiptSchema,
  AgentNativeV4ItemReceiptSchema, AgentNativeV4ItemReceiptQuerySchema, PrepareAgentNativeV4ItemSchema,
  AgentNativeV4IntentSchema, AgentNativeV4PreparationIntentSchema, agentNativeV4ProposalChecksumPayload,
  type AgentNativeV4ResolvedProposal,
} from "./agent-native-v4.js";

const runId = "01999cab-abcd-7000-8000-000000000001", itemId = "01999cab-abcd-7000-8000-000000000002";
const otherId = "01999cab-abcd-7000-8000-000000000003", targetId = "01999cab-abcd-7000-8000-000000000004";
const orderId = "01999cab-abcd-7000-8000-000000000005", stepId = "01999cab-abcd-7000-8000-000000000006";
const fulfillmentIntentId = "01999cab-abcd-7000-8000-000000000007", agentCommandId = "01999cab-abcd-7000-8000-000000000008";
const ownerCommandId = "01999cab-abcd-7000-8000-000000000009", requestId = "64f9ae8a-c894-4fb2-8589-f93e0293a010";
const hash = "a".repeat(64), originalHash = "b".repeat(64), preparationHash = "c".repeat(64), completionHash = "d".repeat(64);
const now = "2026-10-23T00:00:00.000Z", later = "2026-10-24T00:00:00.000Z", authority = "synthetic-current-original-authority";
const legacyKeys = AgentPlanCommandKeySchema.options.flatMap(schema => schema.shape.kind.options.map(kind =>
  AgentPlanCommandKeySchema.parse({ domain: schema.shape.domain.value, kind })));
const allKeys = [...legacyKeys, ...FulfillmentCommandKindSchema.options.map(kind => AgentCommandV2KeySchema.parse({ domain: "fulfillment", kind }))];
function pin(version: string = AGENT_NATIVE_V4_VERSION, key = "erp.agent.native.v4") {
  return { contractVersion: "native-harness-v1", executorKey: key, checksum: hash,
    skill: { key, version, checksum: hash }, tools: [{ key: key + ".decide", version, checksum: hash }] };
}
const bindings = [
  { tool: "orders.exceptions.page", scope: { status: "all" } }, { tool: "inventory.balances.page", scope: { stockItemId: targetId } },
  { tool: "knowledge.search", scope: { topic: "all", platform: "all", market: "ALL", spuIds: [] } },
  { tool: "creative.history", scope: { scope: "inspection", ownerId: targetId } },
  { tool: "factory.capacity", scope: { factoryId: targetId, query: { from: "2026-10-23", days: 1 } } },
  { tool: "research.evidence", scope: { researchItemId: targetId, snapshotId: targetId, studyRevisionId: null } },
  { tool: "catalog.sku", scope: { skuId: targetId, recipeId: null } }, { tool: "listing.version", scope: { listingId: targetId, versionId: targetId } },
  { tool: "orders.order", scope: { orderId, expectedSequence: 1 } }, { tool: "finance.profit_run", scope: { runId: targetId } },
  { tool: "advertising.analysis", scope: { accountId: targetId, analysisId: targetId } },
  ...["production", "shipments", "logistics"].map(kind => ({ tool: AGENT_FULFILLMENT_TOOL, scope: { orderId, expectedSequence: 1, kind } })),
];
function request() {
  return { version: AGENT_NATIVE_V4_VERSION, requestId, goal: "Synthetic bounded original fulfillment suggestions",
    contextText: "Unverified operator notes", modelId: targetId, bindings, allowedCommands: allKeys,
    limits: defaultAgentNativeV4Limits(), maxCostUsd: 0.000001, executionContract: pin() };
}
function suggestion(kind: typeof FulfillmentCommandKindSchema.options[number] = "delivery_feedback") {
  return parseAgentFulfillmentSuggestion({ version: AGENT_FULFILLMENT_PROPOSAL_VERSION, domain: "fulfillment",
    source: { stepId, resultIndex: 0, dataChecksum: hash, orderId, expectedSequence: 1 },
    original: { kind, targetId, input: {}, ...(kind === "delivery_feedback" ? { packageId: otherId } : {}),
      ...(kind === "shipment_review" ? { versionId: otherId } : {}) } });
}
function completion() {
  return PrepareAgentFulfillmentCommandSchema.parse({ version: AGENT_FULFILLMENT_COMMAND_VERSION, orderId,
    original: { kind: "delivery_feedback", requestId: itemId, targetId, packageId: otherId, input: { kind: "submitted",
      expectedSequence: 0, fileChecksum: hash, idempotencyKey: itemId, reference: "SYNTHETIC",
      note: "Synthetic original human attestation", occurredAt: now, verifiedByOperator: true } } });
}
const claim = { stepId, resultIndex: 0, dataChecksum: hash, path: ["order", "sequence"], value: 1 };
function modelDraft() {
  return { position: 0, capability: { domain: "fulfillment", kind: "delivery_feedback" }, label: "Synthetic receipt suggestion",
    reason: "Separate original operator completion is required", draftJson: JSON.stringify(suggestion()), claimIndexes: [0], missingInformation: [] };
}
function modelResult() { return { summary: "Synthetic proposals only", claims: [claim], missingInformation: [], proposals: [modelDraft()] }; }
function proposal(kind: typeof FulfillmentCommandKindSchema.options[number] = "delivery_feedback") {
  return AgentNativeV4ResolvedProposalSchema.parse({ id: itemId, position: 0, proposalChecksum: hash,
    originalChecksum: null, preparationRequestChecksum: null, draft: { position: 0, capability: { domain: "fulfillment", kind },
      label: "Synthetic original suggestion", reason: "Requires original operator completion", original: null, fulfillment: suggestion(kind),
      claims: [], missingInformation: [] }, claimIndexes: [0], operatorChecks: agentFulfillmentOperatorChecks(kind) });
}
function legacyOriginal() {
  return AgentCommandOriginalSchema.parse({ domain: "procurement", command: { kind: "purchase_review", targetId,
    input: { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC", idempotencyKey: itemId } } });
}
function legacyProposal() {
  return AgentNativeV4ResolvedProposalSchema.parse({ id: itemId, position: 0, proposalChecksum: hash,
    originalChecksum: originalHash, preparationRequestChecksum: preparationHash, draft: { position: 0,
      capability: { domain: "procurement", kind: "purchase_review" }, label: "Synthetic legacy original", reason: "Original owner remains separate",
      original: legacyOriginal(), fulfillment: null, claims: [], missingInformation: [] }, claimIndexes: [0], operatorChecks: [] });
}
function result(value: AgentNativeV4ResolvedProposal = proposal()) { return { summary: "Synthetic resolved proposal", claims: [claim], missingInformation: [], proposals: [value] }; }
function requiredItem() {
  return AgentNativeV4ItemViewSchema.parse({ id: itemId, position: 0, proposalChecksum: hash, originalChecksum: null,
    preparationRequestChecksum: null, preparationRequestedAt: null, agentCommandId: null, ownerCommandId: null,
    preparationState: "not_requested", canPrepare: false, blockReason: "operator_completion_required",
    originalProtocol: AGENT_FULFILLMENT_COMMAND_VERSION, fulfillmentIntentId: null, completionChecksum: null, completionState: "operator_required" });
}
function boundItem() {
  return AgentNativeV4ItemViewSchema.parse({ ...requiredItem(), originalChecksum: originalHash, preparationRequestChecksum: preparationHash,
    preparationRequestedAt: now, preparationState: "known", blockReason: null,
    fulfillmentIntentId, completionChecksum: completionHash, completionState: "bound" });
}
function legacyItem() {
  return AgentNativeV4ItemViewSchema.parse({ ...requiredItem(), originalProtocol: AGENT_COMMAND_VERSION, completionState: "not_required",
    originalChecksum: originalHash, preparationRequestChecksum: preparationHash, preparationRequestedAt: now,
    preparationState: "known", blockReason: null, agentCommandId, ownerCommandId });
}
function readDefinition() {
  return AgentToolDefinitionSchema.parse({ version: AGENT_TOOLS_VERSION, contextAuthority: authority,
    selection: { kind: "read", tool: "knowledge.search" }, definitionChecksum: hash, inputSchema: {}, outputSchema: {},
    effect: "read", execution: "registered_native_reader", available: true, blockReason: null, limitations: [] });
}
function commandDefinition() {
  return { version: AGENT_COMMAND_V2_DEFINITION_VERSION, contextAuthority: authority,
    selection: { kind: "command", command: { domain: "fulfillment", kind: "delivery_feedback" } },
    protocol: AGENT_FULFILLMENT_COMMAND_VERSION, available: true, blockReason: null, inputSchema: {},
    effect: "suggest_original_command", execution: "separate_original_preparation_and_confirmation", completion: "operator_completed_original_request",
    operatorChecks: agentFulfillmentOperatorChecks("delivery_feedback"), limitations: ["No business execution"], definitionChecksum: hash };
}
function observation() {
  const packet = AgentFulfillmentResultSchema.parse({ version: "erp-agent-fulfillment-v1", tool: AGENT_FULFILLMENT_TOOL,
    contextAuthority: authority, callId: otherId, checkedAt: now, readStartedAt: now,
    input: { orderId, expectedSequence: 1, kind: "logistics", pageSize: 1, cursor: null },
    definitionChecksum: hash, inputChecksum: hash, dataChecksum: hash,
    sources: [{ owner: "orders", kind: "order", id: orderId, versionId: null, revision: 1, checksum: null }],
    data: { kind: "logistics", order: { id: orderId, number: "SYNTHETIC", sequence: 1, mainState: "in_production", sideState: null,
      lines: [{ id: targetId, quantity: 1, sku: "SYNTHETIC" }] }, rows: [], coverage: { complete: false,
      kind: "original_owner_page_projection", returned: 0, indexedTotal: 0, hasMore: false, nextCursor: null,
      collectionChecksum: hash, limitation: "Index exhaustion is not complete physical fulfillment evidence" } },
    consistency: "owner_reads_fenced_not_single_transaction_snapshot", modelCalled: false, businessExecuted: false });
  return AgentNativeV4ObservationSchema.parse({ stepId, tool: AGENT_FULFILLMENT_TOOL, request: { bindingIndex: 13, keyword: null },
    results: [packet], basisChecksum: hash, observedRows: 0, collectionComplete: null, indexComplete: true, truncatedBy: null });
}
function view() {
  return AgentNativeV4ViewSchema.parse({ version: AGENT_NATIVE_V4_VERSION, id: runId, requestId, requestChecksum: hash,
    contextAuthority: authority, revision: 1, status: "completed", goal: "Synthetic model proposal", contextText: "Synthetic original context",
    modelLabel: "Synthetic transport only", bindings: [bindings[13]], allowedCommands: [{ domain: "fulfillment", kind: "delivery_feedback" }],
    executionContract: pin(), limits: defaultAgentNativeV4Limits(), cost: { capUsd: "1", knownCostUsd: "0", reservedUsd: "0", coverage: "known", modelTurns: 1 },
    toolCalls: 1, observedRows: 0, stopRequestedAt: null, errorCode: null, createdAt: now, updatedAt: now, deadlineAt: later, expiresAt: later,
    privateAvailable: true, stepsComplete: true, steps: [{ id: stepId, sequence: 1, kind: "read", phase: "completed", label: "Original bounded source",
      tool: AGENT_FULFILLMENT_TOOL, inputChecksum: hash, outputChecksum: originalHash, submissionState: "not_submitted", providerRequestId: null,
      inputTokens: null, outputTokens: null, costUsd: null, errorCode: null, createdAt: now, completedAt: now }],
    definitions: [{ stepId, definition: commandDefinition() }], observations: [observation()], result: result(), items: [requiredItem()],
    readContracts: { legacy: pin(), resources: pin(), fulfillment: pin() },
    verification: "native_scalar_values_and_current_source_basis_only", businessExecution: "separate_original_confirmation" });
}
function itemReceipt() {
  return { version: AGENT_NATIVE_V4_VERSION, runId, itemId, proposalChecksum: hash, preparationRequestChecksum: preparationHash,
    disposition: "known", agentCommandId: null, ownerCommandId: null, contextAuthority: authority,
    originalProtocol: AGENT_FULFILLMENT_COMMAND_VERSION, fulfillmentIntentId, completionChecksum: completionHash };
}

describe("independent native4 proposal and operator-completion ABI", () => {
  it("accepts the exact51 create keys and preserves strict original37 semantics in every historical native version", () => {
    const current = CreateAgentNativeV4Schema.parse(request()); expect(current.allowedCommands).toHaveLength(51); expect(legacyKeys).toHaveLength(37);
    expect(canonicalAgentNativeV4Request(Object.fromEntries(Object.entries(current).reverse()))).toBe(canonicalAgentNativeV4Request(current));
    const oldInputs = [
      { schema: CreateAgentNativeSchema, version: AGENT_NATIVE_VERSION, limits: defaultAgentNativeLimits(), bindings: bindings.slice(0, 5) },
      { schema: CreateAgentNativeV2Schema, version: AGENT_NATIVE_V2_VERSION, limits: defaultAgentNativeV4Limits(), bindings: bindings.slice(0, 11) },
      { schema: CreateAgentNativeV3Schema, version: AGENT_NATIVE_V3_VERSION, limits: defaultAgentNativeV4Limits(), bindings },
    ];
    for (const old of oldInputs) {
      const original = { ...request(), version: old.version, limits: old.limits, bindings: old.bindings, allowedCommands: legacyKeys,
        executionContract: pin(old.version, "synthetic.original.executor") };
      expect(old.schema.parse(original).allowedCommands).toEqual(legacyKeys);
      expect(old.schema.safeParse({ ...original, allowedCommands: [{ domain: "fulfillment", kind: "delivery_feedback" }] }).success).toBe(false);
      expect(old.schema.safeParse(current).success).toBe(false);
      expect(CreateAgentNativeV4Schema.safeParse(original).success).toBe(false);
    }
    for (const allowedCommands of [[...allKeys, allKeys[0]], [allKeys[0], allKeys[0]], [{ domain: "fulfillment", kind: "bill_record" }],
      [{ domain: "http", kind: "execute" }]]) expect(CreateAgentNativeV4Schema.safeParse({ ...current, allowedCommands }).success).toBe(false);
    expect(CreateAgentNativeV4Schema.safeParse({ ...current, bindings: [bindings[0], bindings[0]] }).success).toBe(false);
    for (const extra of [{ execute: true }, { confirmationToken: "synthetic" }, { tenantId: otherId }])
      expect(CreateAgentNativeV4Schema.safeParse({ ...current, ...extra }).success).toBe(false);
  });

  it("retains exactly twelve read tools and bounded original bindings without admitting caller cursors or a thirteenth tool", () => {
    expect(AgentNativeV4ReadKeySchema.options).toHaveLength(12);
    expect(new Set(bindings.map(value => value.tool))).toEqual(new Set(AgentNativeV4ReadKeySchema.options));
    for (const binding of bindings) expect(AgentNativeV4BindingSchema.parse(binding)).toEqual(binding);
    expect(AgentNativeV2BindingSchema.safeParse(bindings[11]).success).toBe(false);
    for (const scope of [{ orderId, expectedSequence: 0, kind: "production" }, { orderId, expectedSequence: 1, kind: "production", cursor: "caller" },
      { orderId, expectedSequence: 1, kind: "production", pageSize: 10 }])
      expect(AgentNativeV4BindingSchema.safeParse({ tool: AGENT_FULFILLMENT_TOOL, scope }).success).toBe(false);
    expect(AgentNativeV4BindingSchema.safeParse({ tool: "orders.fulfillment.execute", scope: {} }).success).toBe(false);
    expect(AgentNativeV4ReadRequestSchema.parse({ bindingIndex: 15, keyword: null })).toEqual({ bindingIndex: 15, keyword: null });
    for (const extra of [{ bindingIndex: 16 }, { cursor: "caller" }, { pageSize: 10 }, { orderId }])
      expect(AgentNativeV4ReadRequestSchema.safeParse({ bindingIndex: 0, keyword: null, ...extra }).success).toBe(false);
  });

  it("accepts unchanged original read definitions but refuses a valid old command definition in native4", () => {
    const read = readDefinition(), command = commandDefinition();
    expect(AgentNativeV4DefinitionSchema.parse(read)).toEqual(read);
    expect(agentNativeV4DefinitionSelection(AgentNativeV4DefinitionSchema.parse(read))).toEqual(read.selection);
    expect(AgentNativeV4DefinitionSchema.parse(command)).toEqual(command);
    const old = AgentToolDefinitionSchema.parse({ ...read, selection: { kind: "command", command: { domain: "procurement", kind: "purchase_review" } },
      effect: "prepare_original_command", execution: "separate_original_preparation_and_confirmation" });
    expect(AgentNativeV3DefinitionSchema.parse(old)).toEqual(old);
    expect(AgentNativeV4DefinitionSchema.safeParse(old).success).toBe(false);
    expect(AgentNativeV4DefinitionSchema.safeParse({ ...command, version: AGENT_TOOLS_VERSION }).success).toBe(false);
    expect(AgentNativeV4DefinitionSchema.safeParse({ ...command, completion: "legacy_original_request" }).success).toBe(false);
  });

  it("separates model suggestion payloads from all preparation confirmation and completion actions", () => {
    const draft = modelDraft(), model = modelResult();
    expect(AgentNativeV4ModelDraftSchema.parse(draft)).toEqual(draft);
    expect(AgentNativeV4ModelDraftSchema.safeParse({ ...draft, missingInformation: ["Operator must provide an original receipt reference"] }).success).toBe(true);
    expect(AgentNativeDraftSchema.safeParse(draft).success).toBe(false);
    expect(AgentNativeV3ModelResultSchema.safeParse(model).success).toBe(false);
    expect(AgentNativeV4ModelResultSchema.parse(model)).toEqual(model);
    for (const extra of [{ completion: completion() }, { operatorChecks: [] }, { confirmationToken: "synthetic" }, { originalChecksum: hash }])
      expect(AgentNativeV4ModelDraftSchema.safeParse({ ...draft, ...extra }).success).toBe(false);
    expect(AgentNativeV4ModelResultSchema.safeParse({ ...model, proposals: [{ ...draft, position: 1 }] }).success).toBe(false);
    for (const selected of [{ action: "definition", definition: { kind: "command", command: draft.capability }, read: null, result: null },
      { action: "read", definition: null, read: { bindingIndex: 13, keyword: null }, result: null },
      { action: "finish", definition: null, read: null, result: model }])
      expect(AgentNativeV4DecisionSchema.parse({ ...selected, label: "Synthetic selected action" })).toEqual({ ...selected, label: "Synthetic selected action" });
    for (const action of ["prepare", "confirm", "execute", "submit", "publish"])
      expect(AgentNativeV4DecisionSchema.safeParse({ action, label: "Forbidden", definition: null, read: null, result: null }).success).toBe(false);
    expect(AgentNativeV4DecisionSchema.safeParse({ action: "finish", label: "Conflicting payload", definition: null,
      read: { bindingIndex: 0, keyword: null }, result: model }).success).toBe(false);
  });

  it.each(FulfillmentCommandKindSchema.options)("keeps %s birth hashes null and operator checks exactly server-derived pending", kind => {
    const value = proposal(kind); expect(value.originalChecksum).toBeNull(); expect(value.preparationRequestChecksum).toBeNull();
    expect(value.operatorChecks).toEqual(agentFulfillmentOperatorChecks(kind));
    for (const extra of [{ originalChecksum: hash }, { preparationRequestChecksum: hash }, { originalChecksum: hash, preparationRequestChecksum: hash },
      { operatorChecks: [{ key: "verified_by_operator", path: ["input", "verifiedByOperator"], state: "confirmed", requiredWhen: "always" }] }])
      expect(AgentNativeV4ResolvedProposalSchema.safeParse({ ...value, ...extra }).success).toBe(false);
    if (value.operatorChecks.length) {
      expect(AgentNativeV4ResolvedProposalSchema.safeParse({ ...value, operatorChecks: [] }).success).toBe(false);
      expect(AgentNativeV4ResolvedProposalSchema.safeParse({ ...value, operatorChecks: [{ ...value.operatorChecks[0], path: ["forged"] }] }).success).toBe(false);
    }
  });

  it("keeps resolved families exclusive and source claims in immutable indexed parent facts", () => {
    const value = proposal(), legacy = legacyProposal();
    expect(AgentNativeV4ResolvedProposalSchema.parse(legacy)).toEqual(legacy);
    const validOldClaim = AgentLoopClaimSchema.parse({ stepId, sourceId: orderId, sourceChecksum: hash, field: "sequence", value: 1 });
    for (const draft of [{ ...value.draft, claims: [validOldClaim] }, { ...value.draft, original: legacyOriginal() },
      { ...value.draft, capability: { domain: "fulfillment", kind: "shipment_review" } },
      { ...value.draft, fulfillment: null }, { ...legacy.draft, fulfillment: suggestion() }])
      expect(AgentNativeV4ResolvedDraftSchema.safeParse(draft).success).toBe(false);
    expect(AgentNativeV4ResolvedDraftSchema.safeParse({ ...value.draft, fulfillment: null, missingInformation: ["Original source unavailable"] }).success).toBe(true);
    expect(AgentNativeV4ResultSchema.parse(result(value)).proposals[0]!.claimIndexes).toEqual([0]);
    for (const extra of [{ claims: [] }, { proposals: [{ ...value, claimIndexes: [1] }] }, { proposals: [{ ...value, position: 1, draft: { ...value.draft, position: 1 } }] }])
      expect(AgentNativeV4ResultSchema.safeParse({ ...result(value), ...extra }).success).toBe(false);
    const before = canonicalJson(agentNativeV4ProposalChecksumPayload(value, [claim]));
    expect(before).toContain('"claims"'); expect(before).not.toContain("completionChecksum");
    expect(canonicalJson(agentNativeV4ProposalChecksumPayload(value, [{ ...claim, value: 2 }]))).not.toBe(before);
  });

  it("keeps the model proposal immutable when a person later binds a distinct full request", () => {
    const original = view(), before = canonicalJson(original.result), bound = boundItem();
    const completedView = AgentNativeV4ViewSchema.parse({ ...original, items: [bound] });
    expect(canonicalJson(completedView.result)).toBe(before);
    expect(completedView.result!.proposals[0]!.originalChecksum).toBeNull();
    expect(completedView.items[0]!.completionChecksum).toBe(completionHash);
    for (const items of [[], [{ ...bound, id: runId }], [{ ...bound, position: 1 }], [{ ...bound, proposalChecksum: originalHash }],
      [{ ...bound, originalProtocol: AGENT_COMMAND_VERSION }], [{ ...bound, completionState: "operator_required" }]])
      expect(AgentNativeV4ViewSchema.safeParse({ ...original, items }).success).toBe(false);
    expect(AgentNativeV3ViewSchema.safeParse(original).success).toBe(false);
    const payload = agentNativeV4ProposalChecksumPayload(proposal(), [claim]);
    expect(createHash("sha256").update(canonicalJson(payload)).digest("hex")).not.toBe(completionHash);
    const oldView = { ...original, result: result(legacyProposal()), items: [legacyItem()], allowedCommands: [{ domain: "procurement", kind: "purchase_review" }] };
    expect(AgentNativeV4ViewSchema.parse(oldView).items[0]!.originalProtocol).toBe(AGENT_COMMAND_VERSION);
  });

  it("rejects dual original references and incomplete binding hashes in item projections", () => {
    const value = boundItem(); expect(AgentNativeV4ItemViewSchema.parse(value)).toEqual(value);
    const unknown = { ...value, preparationState: "requested_unknown", fulfillmentIntentId: null };
    expect(AgentNativeV4ItemViewSchema.parse(unknown).completionState).toBe("bound");
    for (const extra of [{ agentCommandId }, { ownerCommandId }, { completionChecksum: null }, { originalChecksum: null }])
      expect(AgentNativeV4ItemViewSchema.safeParse({ ...value, ...extra }).success).toBe(false);
    expect(AgentNativeV4ItemViewSchema.safeParse({ ...legacyItem(), fulfillmentIntentId }).success).toBe(false);
  });

  it("requires a known fulfillment item to identify its actual original intent", () => {
    expect(AgentNativeV4ItemViewSchema.parse(boundItem()).fulfillmentIntentId).toBe(fulfillmentIntentId);
    expect(AgentNativeV4ItemViewSchema.safeParse({ ...boundItem(), fulfillmentIntentId: null }).success).toBe(false);
  });

  it("does not label already bound completion hashes as operator-required in a standalone item", () => {
    expect(AgentNativeV4ItemViewSchema.parse(requiredItem()).completionChecksum).toBeNull();
    expect(AgentNativeV4ItemViewSchema.safeParse({ ...boundItem(), fulfillmentIntentId: null, preparationState: "not_requested",
      completionState: "operator_required" }).success).toBe(false);
  });

  it("requires both exact legacy preparation references for a known legacy item", () => {
    expect(AgentNativeV4ItemViewSchema.parse(legacyItem()).ownerCommandId).toBe(ownerCommandId);
    expect(AgentNativeV4ItemViewSchema.safeParse({ ...legacyItem(), ownerCommandId: null }).success).toBe(false);
  });

  it("does not allow a known item to erase its original protocol while retaining legacy references", () => {
    expect(AgentNativeV4ItemViewSchema.safeParse({ ...legacyItem(), originalProtocol: null }).success).toBe(false);
  });

  it("projects only exact original preparation identities in receipts without claiming original business success", () => {
    const item = itemReceipt(); expect(AgentNativeV4ItemReceiptSchema.parse(item)).toEqual(item);
    expect(AgentNativeV3ItemReceiptSchema.safeParse(item).success).toBe(false);
    for (const extra of [{ agentCommandId }, { ownerCommandId }, { fulfillmentIntentId: null }, { completionChecksum: null },
      { originalProtocol: AGENT_COMMAND_VERSION }, { businessStatus: "succeeded" }, { businessExecuted: true }, { receipt: { kind: "delivery_feedback" } },
      { confirmationToken: "synthetic" }, { status: "succeeded" }])
      expect(AgentNativeV4ItemReceiptSchema.safeParse({ ...item, ...extra }).success).toBe(false);
    const notRequested = { ...item, disposition: "not_requested", preparationRequestChecksum: null, originalProtocol: null,
      fulfillmentIntentId: null, completionChecksum: null };
    expect(AgentNativeV4ItemReceiptSchema.parse(notRequested).disposition).toBe("not_requested");
    const parent = { version: AGENT_NATIVE_V4_VERSION, requestId, requestChecksum: hash, disposition: "known", runId,
      status: "completed", contextAuthority: authority, privateAvailable: false };
    expect(AgentNativeV4ReceiptSchema.parse(parent)).toEqual(parent);
    for (const extra of [{ fulfillmentIntentId }, { businessExecuted: true }, { receipt: {} }, { status: "succeeded" }])
      expect(AgentNativeV4ReceiptSchema.safeParse({ ...parent, ...extra }).success).toBe(false);
    expect(runId).not.toBe(itemId); expect(itemId).not.toBe(fulfillmentIntentId);
  });

  it("requires a known legacy item receipt to identify a non-null original protocol", () => {
    const legacy = { ...itemReceipt(), originalProtocol: AGENT_COMMAND_VERSION, fulfillmentIntentId: null, completionChecksum: null,
      agentCommandId, ownerCommandId };
    expect(AgentNativeV4ItemReceiptSchema.parse(legacy)).toEqual(legacy);
    expect(AgentNativeV4ItemReceiptSchema.safeParse({ ...legacy, originalProtocol: null }).success).toBe(false);
  });

  it("accepts complete human input only on explicit preparation while GET identity and browser markers reject all bodies and tokens", () => {
    const query = { version: AGENT_NATIVE_V4_VERSION, requestId, proposalChecksum: hash }, body = { ...query, completion: completion() };
    expect(AgentNativeV4ItemReceiptQuerySchema.parse(query)).toEqual(query);
    expect(PrepareAgentNativeV4ItemSchema.parse(body)).toEqual(body);
    expect(PrepareAgentNativeV4ItemSchema.parse({ ...query, completion: null }).completion).toBeNull();
    expect(body.requestId).not.toBe(body.completion.original.requestId);
    expect(PrepareAgentNativeV4ItemSchema.safeParse(query).success).toBe(false);
    expect(PrepareAgentNativeV4ItemSchema.safeParse({ ...body, completion: suggestion() }).success).toBe(false);
    for (const extra of [{ completion: completion() }, { input: {} }, { original: completion().original }, { confirmationToken: "synthetic" },
      { confirmationExpiresAt: later }, { execute: true }, { runId }, { itemId }])
      expect(AgentNativeV4ItemReceiptQuerySchema.safeParse({ ...query, ...extra }).success).toBe(false);
    expect(PrepareAgentNativeV4ItemSchema.safeParse({ ...body, confirmationToken: "synthetic" }).success).toBe(false);
    const parentMarker = { version: 1, ownerScope: hash, requestId, requestChecksum: hash, runId, state: "known", createdAt: now };
    const childMarker = { version: 1, ownerScope: hash, runId, itemId, proposalChecksum: hash, state: "unknown", createdAt: now };
    expect(Object.keys(AgentNativeV4IntentSchema.parse(parentMarker))).toHaveLength(7);
    expect(Object.keys(AgentNativeV4PreparationIntentSchema.parse(childMarker))).toHaveLength(7);
    for (const extra of [{ completion: completion() }, { confirmationToken: "synthetic" }, { draft: modelDraft() }, { claims: [claim] }]) {
      expect(AgentNativeV4IntentSchema.safeParse({ ...parentMarker, ...extra }).success).toBe(false);
      expect(AgentNativeV4PreparationIntentSchema.safeParse({ ...childMarker, ...extra }).success).toBe(false);
    }
  });

  it("clears every private binding command definition observation result and source body when the view is unavailable", () => {
    const original = view(), minimal = { ...original, privateAvailable: false, readContracts: null, goal: null, contextText: null,
      bindings: [], allowedCommands: [], steps: [], definitions: [], observations: [], result: null,
      items: [{ ...requiredItem(), completionState: "unavailable", blockReason: "input_unavailable" }] };
    expect(AgentNativeV4ViewSchema.parse(minimal).privateAvailable).toBe(false);
    for (const field of ["readContracts", "goal", "contextText", "bindings", "allowedCommands", "steps", "definitions", "observations", "result"] as const)
      expect(AgentNativeV4ViewSchema.safeParse({ ...minimal, [field]: original[field] }).success).toBe(false);
  });
});
