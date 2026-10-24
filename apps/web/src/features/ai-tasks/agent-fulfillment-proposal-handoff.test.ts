import { describe, expect, it } from "vitest";
import { AGENT_COMMAND_VERSION } from "@yummyai/contracts/ai/agent-command";
import { AGENT_FULFILLMENT_COMMAND_VERSION } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { AGENT_FULFILLMENT_PROPOSAL_VERSION, AgentFulfillmentSuggestionSchema } from "@yummyai/contracts/ai/agent-fulfillment-proposal";
import { PrepareFulfillmentCommandSchema } from "@yummyai/contracts/order/fulfillment-command";
import {
  agentFulfillmentProposalFormIdentity, agentFulfillmentProposalOperationHref, agentFulfillmentProposalParentQuery,
  bindAgentFulfillmentProposalForm, retainAgentFulfillmentProposalDraft,
} from "./agent-fulfillment-proposal-handoff";

const id = (value: number) => `01900000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
const orderId = id(1), runId = id(2), itemId = id(3), nativeKey = id(4), hash = "a".repeat(64);
const first = { productionOrderId: id(11), productionVersionId: id(21), expectedProjectionVersion: 2 };
const second = { productionOrderId: id(12), productionVersionId: id(22), expectedProjectionVersion: 3 };
const source = { stepId: id(5), resultIndex: 0, dataChecksum: hash, orderId, expectedSequence: 7 };
function deliverySuggestion(items: unknown[] = [second, first]) {
  return AgentFulfillmentSuggestionSchema.parse({ version: AGENT_FULFILLMENT_PROPOSAL_VERSION, domain: "fulfillment", source,
    original: { kind: "delivery_create", targetId: orderId, input: { items } } });
}
function deliveryCommand() {
  return PrepareFulfillmentCommandSchema.parse({ kind: "delivery_create", targetId: orderId, requestId: nativeKey,
    input: { factoryId: id(31), supplierId: id(32), items: [first, second], idempotencyKey: nativeKey } });
}

describe("native v4 original-form handoff coordinates and pinned draft identity", () => {
  it("keeps only unique valid parent task coordinates and removes stale form data and nested return URLs", () => {
    const raw = new URLSearchParams({ agentNativeV4: runId, agentPlan: id(40), agentCommand: id(41), order: id(42), line: id(43),
      delivery: id(44), agentNativeV4Item: id(45), agentFulfillmentCommand: id(46), returnTo: "/production?delivery=stale", contextText: "synthetic private text" });
    raw.append("agentNativeV3", id(47)); raw.append("agentNativeV3", id(48)); raw.set("run", "not-a-task");
    expect([...agentFulfillmentProposalParentQuery(raw.toString(), runId)]).toEqual([
      ["agentPlan", id(40)], ["agentNativeV4", runId], ["agentCommand", id(41)],
    ]);
  });

  it("opens the exact original confirmation with its parent version while excluding stale delivery and return coordinates", () => {
    const raw = new URLSearchParams({ agentNativeV4: runId, agentDependencyPlan: id(40), agentCommand: id(41), delivery: id(42),
      line: id(43), order: id(44), agentNativeV4Item: itemId, returnTo: "/ai-tasks?returnTo=stale" }).toString();
    const fulfillment = new URL(agentFulfillmentProposalOperationHref(raw, runId, id(50), AGENT_FULFILLMENT_COMMAND_VERSION, orderId), "https://erp.invalid");
    expect(fulfillment.pathname).toBe("/ai-tasks");
    expect(Object.fromEntries(fulfillment.searchParams)).toEqual({ agentDependencyPlan: id(40), agentNativeV4: runId,
      agentCommand: id(41), agentFulfillmentCommand: id(50), order: orderId });
    const original = new URL(agentFulfillmentProposalOperationHref(raw, runId, id(51), AGENT_COMMAND_VERSION), "https://erp.invalid");
    expect(Object.fromEntries(original.searchParams)).toEqual({ agentDependencyPlan: id(40), agentNativeV4: runId, agentCommand: id(51) });
  });

  it("retains the same suggestion reference after an equal pinned read but resets it on source identity or clear", () => {
    const suggestion = deliverySuggestion(), identityInput = { authority: "synthetic personal authority", runId, itemId, proposalChecksum: hash, suggestion, orderSequence: 7 };
    const identity = agentFulfillmentProposalFormIdentity(identityInput), draft = retainAgentFulfillmentProposalDraft(null, identity, suggestion);
    const repeated = deliverySuggestion();
    expect(retainAgentFulfillmentProposalDraft(draft, agentFulfillmentProposalFormIdentity({ ...identityInput, suggestion: repeated }), repeated)).toBe(draft);
    expect(draft?.suggestion).toBe(suggestion);
    const changed = AgentFulfillmentSuggestionSchema.parse({ ...repeated, source: { ...source, dataChecksum: "b".repeat(64) } });
    for (const next of [{ ...identityInput, authority: "another personal authority" }, { ...identityInput, orderSequence: 8 },
      { ...identityInput, proposalChecksum: "c".repeat(64) }, { ...identityInput, suggestion: changed }]) {
      const nextIdentity = agentFulfillmentProposalFormIdentity(next);
      expect(nextIdentity).not.toBe(identity);
      expect(retainAgentFulfillmentProposalDraft(draft, nextIdentity, next.suggestion)).not.toBe(draft);
    }
    expect(retainAgentFulfillmentProposalDraft(draft, identity, null)).toBeNull();
  });

  it("matches complete suggested rows by original identity despite normalization sorting and fixes only the approved slot key", () => {
    const result = bindAgentFulfillmentProposalForm(deliverySuggestion(), itemId, deliveryCommand());
    expect(result.version).toBe(AGENT_FULFILLMENT_COMMAND_VERSION);
    expect(result.orderId).toBe(orderId);
    expect(result.original).toMatchObject({ kind: "delivery_create", targetId: orderId, requestId: itemId, input: { idempotencyKey: itemId } });
    if (result.original.kind !== "delivery_create") throw new Error("fixture_kind_mismatch");
    expect(result.original.input.items).toEqual([first, second]);
  });

  it("allows a uniquely identified partial source but rejects missing or ambiguous row identity rather than matching by position", () => {
    expect(() => bindAgentFulfillmentProposalForm(deliverySuggestion([{ productionVersionId: second.productionVersionId, expectedProjectionVersion: 3 }]), itemId, deliveryCommand())).not.toThrow();
    expect(() => bindAgentFulfillmentProposalForm(deliverySuggestion([{ expectedProjectionVersion: 3 }]), itemId, deliveryCommand())).toThrow("原建议缺少能唯一核对的原行或生产来源编号");
    expect(() => bindAgentFulfillmentProposalForm(deliverySuggestion([{ productionVersionId: first.productionVersionId }, { productionVersionId: first.productionVersionId }]), itemId, deliveryCommand())).toThrow("原建议的来源未能唯一匹配本页原记录");
  });

  it("refuses changed pinned versions and projection values instead of substituting today's production source", () => {
    expect(() => bindAgentFulfillmentProposalForm(deliverySuggestion([{ ...first, productionVersionId: second.productionVersionId }]), itemId, deliveryCommand())).toThrow("原建议的来源未能唯一匹配本页原记录");
    expect(() => bindAgentFulfillmentProposalForm(deliverySuggestion([{ ...first, expectedProjectionVersion: 99 }]), itemId, deliveryCommand())).toThrow("原建议的固定来源或版本与本页不符");
  });

  it("keeps explicit operator feedback and its exact package pin when binding the model slot", () => {
    const suggestion = AgentFulfillmentSuggestionSchema.parse({ version: AGENT_FULFILLMENT_PROPOSAL_VERSION, domain: "fulfillment", source,
      original: { kind: "delivery_feedback", targetId: id(60), packageId: id(61), input: { expectedSequence: 2, fileChecksum: hash } } });
    const command = PrepareFulfillmentCommandSchema.parse({ kind: "delivery_feedback", targetId: id(60), packageId: id(61), requestId: nativeKey,
      input: { kind: "submitted", expectedSequence: 2, fileChecksum: hash, idempotencyKey: nativeKey, reference: "synthetic operator reference",
        note: "synthetic operator verified feedback", occurredAt: "2026-10-23T00:00:00.000Z", verifiedByOperator: true } });
    expect(bindAgentFulfillmentProposalForm(suggestion, itemId, command).original).toMatchObject({ kind: "delivery_feedback", packageId: id(61),
      requestId: itemId, input: { idempotencyKey: itemId, verifiedByOperator: true } });
    expect(() => bindAgentFulfillmentProposalForm(suggestion, itemId, PrepareFulfillmentCommandSchema.parse({ ...command, packageId: id(62) }))).toThrow("agent_fulfillment_completion_identity_mismatch");
  });
});
