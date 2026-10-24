import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AGENT_COMMAND_VERSION, AgentCommandOriginalSchema, canonicalAgentCommandOriginal, canonicalAgentCommandRequest } from "@yummyai/contracts/ai/agent-command";
import { AGENT_FULFILLMENT_COMMAND_VERSION } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { AGENT_COMMAND_V2_DEFINITION_VERSION, AgentCommandV2DefinitionSchema, AgentCommandV2KeySchema,
  agentCommandV2DefinitionPayload, type AgentCommandV2Key } from "@yummyai/contracts/ai/agent-command-v2-discovery";
import { AGENT_FULFILLMENT_PROPOSAL_VERSION, AgentFulfillmentSuggestionSchema, AgentFulfillmentSuggestionOriginalSchema,
  agentFulfillmentModelForbiddenKeys, agentFulfillmentOperatorChecks } from "@yummyai/contracts/ai/agent-fulfillment-proposal";
import { FulfillmentCommandKindSchema, type FulfillmentCommandKind } from "@yummyai/contracts/order/fulfillment-command";
import { AgentPlanCommandKeySchema } from "@yummyai/contracts/ai/agent-plan";
import { AGENT_TOOLS_VERSION, AgentToolDefinitionSchema, agentToolCommandInput, agentToolDefinitionPayload } from "@yummyai/contracts/ai/agent-tools";
import { AGENT_NATIVE_V4_VERSION, agentNativeV4ProposalChecksumPayload } from "@yummyai/contracts/ai/agent-native-v4";
import { resolveAgentNativeV3Result } from "./agent-native-v3-model.js";
import {
  resolveAgentNativeV4Result, agentNativeV4Slots, agentNativeV4Harness, agentNativeV4Skill,
  agentNativeV4DecisionWireSchema, agentNativeV4DecisionJsonSchema,
} from "./agent-native-v4-model.js";

const runId = "01999cab-abcd-7000-8000-000000000001", orderId = "01999cab-abcd-7000-8000-000000000002";
const targetId = "01999cab-abcd-7000-8000-000000000003", versionId = "01999cab-abcd-7000-8000-000000000004";
const packageId = "01999cab-abcd-7000-8000-000000000005", stepId = "01999cab-abcd-7000-8000-000000000006";
const otherRun = "01999cab-abcd-7000-8000-000000000007", hash = "a".repeat(64);
const checksum = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
const textChecksum = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const legacyKeys = AgentPlanCommandKeySchema.options.flatMap(schema => schema.shape.kind.options.map(kind =>
  AgentPlanCommandKeySchema.parse({ domain: schema.shape.domain.value, kind })));
const allowed = [...legacyKeys, ...FulfillmentCommandKindSchema.options.map(kind => AgentCommandV2KeySchema.parse({ domain: "fulfillment", kind }))];
const key = (kind: FulfillmentCommandKind) => AgentCommandV2KeySchema.parse({ domain: "fulfillment", kind });
function definition(command: AgentCommandV2Key) {
  const fulfillment = command.domain === "fulfillment";
  let inputSchema: Record<string, unknown>;
  if (fulfillment) {
    const original = AgentFulfillmentSuggestionOriginalSchema.options.find(option => option.shape.kind.value === command.kind);
    if (!original) throw new Error("synthetic_exact_kind_missing");
    inputSchema = z.toJSONSchema(AgentFulfillmentSuggestionSchema.safeExtend({ original }), { io: "input" });
  } else inputSchema = z.toJSONSchema(agentToolCommandInput(AgentPlanCommandKeySchema.parse(command)), { io: "input" });
  const value = AgentCommandV2DefinitionSchema.parse({ version: AGENT_COMMAND_V2_DEFINITION_VERSION, selection: { kind: "command", command },
    protocol: fulfillment ? AGENT_FULFILLMENT_COMMAND_VERSION : AGENT_COMMAND_VERSION,
    contextAuthority: "synthetic-current-original-authority", available: true, blockReason: null, inputSchema,
    effect: "suggest_original_command", execution: "separate_original_preparation_and_confirmation",
    completion: fulfillment ? "operator_completed_original_request" : "legacy_original_request",
    operatorChecks: fulfillment ? agentFulfillmentOperatorChecks(command.kind) : [],
    limitations: ["A schema is not an operator action or a business result"], definitionChecksum: hash });
  value.definitionChecksum = checksum(agentCommandV2DefinitionPayload(value)); return value;
}
function suggestion(kind: FulfillmentCommandKind) {
  return { version: AGENT_FULFILLMENT_PROPOSAL_VERSION, domain: "fulfillment", source: { stepId, resultIndex: 0, dataChecksum: hash, orderId, expectedSequence: 3 },
    original: { kind, targetId, input: {}, ...(kind === "delivery_feedback" ? { packageId } : {}), ...(kind === "shipment_review" ? { versionId } : {}) } };
}
const claim = { stepId, resultIndex: 0, dataChecksum: hash, path: ["order", "sequence"], value: 3 };
function model(kind: FulfillmentCommandKind = "delivery_feedback", raw: unknown = suggestion(kind)) {
  return { summary: "Synthetic unapproved original suggestion", claims: [claim], missingInformation: [], proposals: [{ position: 0,
    capability: key(kind), label: "Synthetic original suggestion", reason: "Original fields and physical checks remain separate",
    draftJson: JSON.stringify(raw), claimIndexes: [0], missingInformation: ["Operator must complete the original form"] }] };
}
function resolve(kind: FulfillmentCommandKind, raw: unknown = model(kind)) {
  return resolveAgentNativeV4Result(runId, raw, allowed, 8, [{ stepId, definition: definition(key(kind)) }]);
}
function legacyModel(id = agentNativeV4Slots(runId, 8)[0]!.id) {
  const original = AgentCommandOriginalSchema.parse({ domain: "procurement", command: { kind: "purchase_review", targetId,
    input: { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC", idempotencyKey: id } } });
  return { original, model: { summary: "Synthetic legacy original suggestion", claims: [claim], missingInformation: [], proposals: [{ position: 0,
    capability: { domain: "procurement", kind: "purchase_review" }, label: "Original owner review", reason: "No automatic original confirmation",
    draftJson: JSON.stringify(original), claimIndexes: [0], missingInformation: [] }] } };
}

describe("native4 model resolution is suggestion-only", () => {
  it.each(FulfillmentCommandKindSchema.options)("resolves %s under the complete51 allowlist without original inputs hashes keys or synthetic approval", kind => {
    const raw = model(kind), before = structuredClone(raw), current = resolve(kind, raw), value = current.proposals[0]!;
    expect(allowed).toHaveLength(51); expect(legacyKeys).toHaveLength(37);
    expect(value.id).toBe(agentNativeV4Slots(runId, 8)[0]!.id); expect(value.id).not.toBe(runId);
    expect(value.originalChecksum).toBeNull(); expect(value.preparationRequestChecksum).toBeNull(); expect(value.draft.original).toBeNull();
    expect(value.draft.fulfillment).toEqual(suggestion(kind)); expect(value.draft.claims).toEqual([]); expect(value.claimIndexes).toEqual([0]);
    expect(value.operatorChecks).toEqual(agentFulfillmentOperatorChecks(kind)); expect(value.operatorChecks.every(check => check.state === "pending")).toBe(true);
    expect(value.proposalChecksum).toBe(checksum(agentNativeV4ProposalChecksumPayload(value, current.claims)));
    expect(raw).toEqual(before);
    const changed = resolve(kind, { ...raw, claims: [{ ...claim, value: 4 }] });
    expect(changed.proposals[0]!.proposalChecksum).not.toBe(value.proposalChecksum);
  });

  it("retains the original37 canonical input and preparation hashes while sealing a distinct v4 proposal checksum", () => {
    const legacy = legacyModel(), command = AgentPlanCommandKeySchema.parse(legacy.model.proposals[0]!.capability), loaded = definition(command);
    const oldDefinition = AgentToolDefinitionSchema.parse({ version: AGENT_TOOLS_VERSION, selection: { kind: "command", command },
      contextAuthority: loaded.contextAuthority, available: true, blockReason: null, definitionChecksum: hash, inputSchema: loaded.inputSchema,
      outputSchema: { type: "null" }, effect: "prepare_original_command", execution: "separate_original_preparation_and_confirmation", limitations: ["No automatic writes"] });
    oldDefinition.definitionChecksum = checksum(agentToolDefinitionPayload(oldDefinition));
    const current = resolveAgentNativeV4Result(runId, legacy.model, allowed, 8, [{ stepId, definition: loaded }]).proposals[0]!;
    const old = resolveAgentNativeV3Result(runId, legacy.model, legacyKeys, 8, [{ stepId, definition: oldDefinition }]).proposals[0]!;
    expect(current.id).toBe(old.id); expect(current.draft.original).toEqual(old.draft.original);
    expect(current.originalChecksum).toBe(old.originalChecksum); expect(current.preparationRequestChecksum).toBe(old.preparationRequestChecksum);
    expect(current.originalChecksum).toBe(textChecksum(canonicalAgentCommandOriginal(legacy.original)));
    expect(current.preparationRequestChecksum).toBe(textChecksum(canonicalAgentCommandRequest("prepare", {
      version: AGENT_COMMAND_VERSION, requestId: current.id, original: legacy.original })));
    expect(current.proposalChecksum).not.toBe(old.proposalChecksum); expect(current.operatorChecks).toEqual([]);
    expect(() => resolveAgentNativeV3Result(runId, model(), legacyKeys, 8, [{ stepId, definition: oldDefinition }])).toThrow();
  });

  it.each(agentFulfillmentModelForbiddenKeys)("rejects model-supplied %s at every nested and array position even when false null or an exact server slot", field => {
    for (const value of [true, false, null, 0, "", agentNativeV4Slots(runId, 8)[0]!.id, [], {}]) {
      const raw = suggestion("delivery_feedback");
      for (const altered of [{ ...raw, [field]: value }, { ...raw, source: { ...raw.source, [field]: value } },
        { ...raw, original: { ...raw.original, [field]: value } },
        { ...raw, original: { ...raw.original, input: { nested: [[{ [field]: value }]] } } }])
        expect(() => resolve("delivery_feedback", model("delivery_feedback", altered))).toThrow("agent_proposal_operator_field_forbidden");
    }
    const recovery = suggestion("production_recovery");
    expect(() => resolve("production_recovery", model("production_recovery", { ...recovery, original: { ...recovery.original,
      input: { manufacturing: { versionId, [field]: true } } } }))).toThrow("agent_proposal_operator_field_forbidden");
  });

  it("does not allow old37 payloads to bypass operator-field rejection or copy a foreign server slot", () => {
    const current = legacyModel(), command = AgentPlanCommandKeySchema.parse(current.model.proposals[0]!.capability), defs = [{ stepId, definition: definition(command) }];
    expect(() => resolveAgentNativeV4Result(runId, legacyModel(otherRun).model, allowed, 8, defs)).toThrow("agent_proposal_key_invalid");
    expect(() => resolveAgentNativeV4Result(otherRun, current.model, allowed, 8, defs)).toThrow("agent_proposal_key_invalid");
    for (const field of ["verifiedByOperator", "segregationConfirmed", "physicalSelectionConfirmed", "orderUnitConfirmed", "operatorChecks", "confirmationToken", "confirmationExpiresAt"])
      expect(() => resolveAgentNativeV4Result(runId, { ...current.model, proposals: [{ ...current.model.proposals[0],
        draftJson: JSON.stringify({ ...current.original, nested: [{ [field]: false }] }) }] }, allowed, 8, defs)).toThrow("agent_proposal_operator_field_forbidden");
  });

  it("requires an allowed exact loaded v2 command definition and refuses unavailable altered or old definitions", () => {
    const raw = model(), loaded = definition(key("delivery_feedback"));
    expect(() => resolveAgentNativeV4Result(runId, raw, allowed, 8, [{ stepId, definition: loaded }])).not.toThrow();
    for (const definitions of [[], [{ stepId, definition: { ...loaded, available: false, blockReason: "original_read_unavailable" } }],
      [{ stepId, definition: { ...loaded, definitionChecksum: "f".repeat(64) } }], [{ stepId, definition: definition(key("shipment_review")) }]])
      expect(() => resolveAgentNativeV4Result(runId, raw, allowed, 8, definitions)).toThrow("agent_proposal_not_allowed");
    for (const selected of [[], legacyKeys, [key("shipment_review")]])
      expect(() => resolveAgentNativeV4Result(runId, raw, selected, 8, [{ stepId, definition: loaded }])).toThrow("agent_proposal_not_allowed");
    expect(() => resolveAgentNativeV4Result(runId, raw, [key("delivery_feedback"), key("delivery_feedback")], 8, [{ stepId, definition: loaded }])).toThrow();
    expect(() => resolveAgentNativeV4Result(runId, raw, allowed, 0, [{ stepId, definition: loaded }])).toThrow();
  });

  it("rejects extra model or suggestion fields malformed JSON cross-kind drafts and borrowed claim indexes", () => {
    const raw = model();
    for (const extra of [{ completion: {} }, { confirmationToken: "synthetic" }, { execute: true }, { operatorChecks: [] }])
      expect(() => resolve("delivery_feedback", { ...raw, proposals: [{ ...raw.proposals[0], ...extra }] })).toThrow();
    for (const altered of [{ ...suggestion("delivery_feedback"), execute: true }, suggestion("shipment_review")])
      expect(() => resolve("delivery_feedback", model("delivery_feedback", altered))).toThrow();
    expect(() => resolve("delivery_feedback", { ...raw, proposals: [{ ...raw.proposals[0], draftJson: "{not-json" }] })).toThrow("agent_proposal_invalid");
    for (const claimIndexes of [[1], [0, 0], [-1]])
      expect(() => resolve("delivery_feedback", { ...raw, proposals: [{ ...raw.proposals[0], claimIndexes }] })).toThrow();
    const missing = { ...raw, proposals: [{ ...raw.proposals[0], draftJson: null, missingInformation: ["Original source is unavailable"] }] };
    expect(resolve("delivery_feedback", missing).proposals[0]!.draft.fulfillment).toBeNull();
    expect(() => resolve("delivery_feedback", { ...missing, proposals: [{ ...missing.proposals[0], missingInformation: [] }] })).toThrow();
  });

  it("publishes a separate on-demand decision harness without a direct write action or51 complete owner schemas", () => {
    const pin = agentNativeV4Harness.pin(agentNativeV4Skill); expect(pin.skill.version).toBe(AGENT_NATIVE_V4_VERSION);
    const wire = JSON.stringify(agentNativeV4DecisionJsonSchema);
    expect(wire).toContain("draftJson"); expect(wire).not.toContain("orderUnitConfirmed"); expect(wire).not.toContain("expectedRootInspectionId");
    for (const action of ["prepare", "confirm", "execute", "publish"])
      expect(agentNativeV4DecisionWireSchema.safeParse({ action, label: "No automatic original owner write", definition: null, read: null, result: null }).success).toBe(false);
    expect(agentNativeV4DecisionWireSchema.safeParse({ action: "definition", label: "Load exact original command", definition: { kind: "command", command: key("delivery_feedback") },
      read: null, result: null }).success).toBe(true);
  });
});
