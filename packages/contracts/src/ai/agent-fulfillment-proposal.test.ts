import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJson } from "../common/canonical-json.js";
import { FulfillmentCommandKindSchema, PrepareFulfillmentCommandSchema, fulfillmentCommandCanonicalJson,
  fulfillmentCommandRequestKey, type FulfillmentCommandKind } from "../order/fulfillment-command.js";
import { AGENT_FULFILLMENT_COMMAND_VERSION, PrepareAgentFulfillmentCommandSchema } from "./agent-fulfillment-command.js";
import {
  AGENT_FULFILLMENT_PROPOSAL_VERSION, AgentFulfillmentOperatorCheckSchema, AgentFulfillmentSuggestionSchema,
  agentFulfillmentModelForbiddenKeys, agentFulfillmentOperatorChecks, agentFulfillmentSuggestionInputSchemas,
  agentModelOperatorFieldNames, assertAgentFulfillmentModelFields, assertAgentModelOperatorFields,
  bindAgentFulfillmentCompletion, canonicalAgentFulfillmentSuggestion, parseAgentFulfillmentSuggestion,
} from "./agent-fulfillment-proposal.js";

const targetId = "01999cab-abcd-7000-8000-000000000001";
const packageId = "01999cab-abcd-7000-8000-000000000002";
const versionId = "01999cab-abcd-7000-8000-000000000003";
const orderId = "01999cab-abcd-7000-8000-000000000004";
const stepId = "01999cab-abcd-7000-8000-000000000005";
const slotId = "01999cab-abcd-7000-8000-000000000006";
const otherId = "01999cab-abcd-7000-8000-000000000007";
const hash = "a".repeat(64), now = "2026-10-23T00:00:00.000Z";
const evidence = { code: "SYNTHETIC_ONLY", note: "Authored observation", assetIds: [] };
const assessment = { formatVersion: 2, criterionResults: [{ code: "PRINT", scoreBps: 10000, passed: true, evidenceAssetIds: [] }] };
const line = { lineId: targetId, quantity: 1, expectedRevision: 0, expectedProjectionVersion: 0 };
const productionLine = { ...line, productionOrderId: targetId, expectedProductionProjectionVersion: 1 };
const shipping = { shipDate: now, shipFromCountryCode: "US", packages: [{ packageReferenceId: "SYNTHETIC-1",
  trackingNumber: "SYNTHETIC-TRACKING", carrierCode: "SYNTHETIC", carrierName: "Synthetic only", carrierService: "Synthetic only",
  lines: [{ orderLineId: targetId, quantity: 1 }] }] };

// Synthetic contract values only: no owner success, physical evidence or business
// execution is claimed by these inputs. Real owner validation remains separate.
const inputs: Record<FulfillmentCommandKind, Record<string, unknown>> = {
  delivery_create: { factoryId: targetId, supplierId: targetId,
    items: [{ productionOrderId: targetId, productionVersionId: versionId, expectedProjectionVersion: 1 }] },
  delivery_feedback: { kind: "submitted", expectedSequence: 0, fileChecksum: hash, reference: "SYNTHETIC",
    note: "Synthetic original receipt", occurredAt: now, verifiedByOperator: true },
  production_milestone: { type: "started", expectedProjectionVersion: 1, occurredAt: now, evidence },
  quality_inspection: { qualityStandardVersionId: versionId, expectedProductionProjectionVersion: 1, result: "passed",
    scoreBps: 10000, inspectedAt: now, assessment, defects: [], evidenceAssetIds: [] },
  quality_group_inspection: { formatVersion: 3, productionVersionId: versionId, expectedProductionProjectionVersion: 1,
    expectedRootInspectionId: null, qualityStandardVersionId: versionId, inspectedAt: now, segregationConfirmed: true,
    groups: [{ key: "good", label: "Synthetic physical bin", quantity: 1, criterionResults: assessment.criterionResults, defects: [] }] },
  production_recovery: { type: "remake", originalProductionOrderId: targetId, reason: "Synthetic original recovery",
    remakeQuantity: 1, expectedCompletionAt: "2026-10-24T00:00:00.000Z" },
  whole_production_milestone: { type: "started", occurredAt: now, evidence, items: [productionLine] },
  whole_quality_inspection: { qualityStandardVersionId: versionId, scoreBps: 10000, inspectedAt: now,
    assessment, evidenceAssetIds: [], items: [productionLine] },
  shipment_create: shipping,
  whole_shipment_create: { items: [line], trackingNumber: "SYNTHETIC-TRACKING", carrierCode: "SYNTHETIC",
    carrierName: "Synthetic only", carrierService: "Synthetic only", shipFromCountryCode: "US", shipDate: now },
  shipment_version: { ...shipping, expectedCurrentVersion: 1 },
  shipment_review: { decision: "approved", reasonCode: "SYNTHETIC", reason: "Synthetic original review", expectedCurrentVersion: 1 },
  shipment_dispatch: { expectedVersion: 1, reason: "Synthetic handover observation", occurredAt: now },
  shipment_platform_confirmation: { expectedVersion: 1, evidenceReference: "Synthetic operator observation", confirmedAt: now },
};

function withoutModelForbidden(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutModelForbidden);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !agentFulfillmentModelForbiddenKeys.some(field => field === key))
    .map(([key, child]) => [key, withoutModelForbidden(child)]));
}
function suggestion(kind: FulfillmentCommandKind, input: unknown = withoutModelForbidden(inputs[kind])) {
  return parseAgentFulfillmentSuggestion({ version: AGENT_FULFILLMENT_PROPOSAL_VERSION, domain: "fulfillment",
    source: { stepId, resultIndex: 0, dataChecksum: hash, orderId, expectedSequence: 1 },
    original: { kind, targetId, input, ...(kind === "delivery_feedback" ? { packageId } : {}), ...(kind === "shipment_review" ? { versionId } : {}) } });
}
function completed(kind: FulfillmentCommandKind) {
  const key = kind === "production_milestone" ? { externalEventId: slotId } : { idempotencyKey: slotId };
  return PrepareAgentFulfillmentCommandSchema.parse({ version: AGENT_FULFILLMENT_COMMAND_VERSION, orderId,
    original: { kind, requestId: slotId, targetId, input: { ...inputs[kind], ...key },
      ...(kind === "delivery_feedback" ? { packageId } : {}), ...(kind === "shipment_review" ? { versionId } : {}) } });
}
const checksum = (value: string) => createHash("sha256").update(value).digest("hex");

describe("model fulfillment suggestions and separate operator completion", () => {
  it.each(FulfillmentCommandKindSchema.options)("keeps %s partial and strict without manufacturing defaults keys or operator checks", kind => {
    const schema = agentFulfillmentSuggestionInputSchemas[kind], empty = {}, partial = withoutModelForbidden(inputs[kind]);
    expect(schema.parse(empty)).toEqual({}); expect(empty).toEqual({});
    expect(schema.parse(partial)).toEqual(partial);
    expect(suggestion(kind, {}).original.input).toEqual({});
    expect(suggestion(kind).original.kind).toBe(kind);
    expect(schema.safeParse({ arbitraryModelField: "unsupported" }).success).toBe(false);
    expect(schema.safeParse({ execute: true }).success).toBe(false);
  });

  it("removes nested defaults from every projected input schema and preserves explicit partial values", () => {
    expect(Object.keys(agentFulfillmentSuggestionInputSchemas).sort()).toEqual([...FulfillmentCommandKindSchema.options].sort());
    function inspect(value: unknown) {
      if (Array.isArray(value)) { value.forEach(inspect); return; }
      if (!value || typeof value !== "object") return;
      expect(Object.hasOwn(value, "default")).toBe(false);
      for (const [key, child] of Object.entries(value)) {
        if (key === "properties" && child && typeof child === "object")
          for (const field of agentFulfillmentModelForbiddenKeys) expect(Object.hasOwn(child, field)).toBe(false);
        inspect(child);
      }
    }
    for (const kind of FulfillmentCommandKindSchema.options) inspect(z.toJSONSchema(agentFulfillmentSuggestionInputSchemas[kind], { io: "input" }));
    expect(agentFulfillmentSuggestionInputSchemas.production_milestone.parse({ evidence: {} })).toEqual({ evidence: {} });
    expect(agentFulfillmentSuggestionInputSchemas.shipment_create.parse({ packages: [{ lines: [{}] }] })).toEqual({ packages: [{ lines: [{}] }] });
    expect(agentFulfillmentSuggestionInputSchemas.quality_group_inspection.parse({ groups: [{}] })).toEqual({ groups: [{}] });
  });

  it.each(agentFulfillmentModelForbiddenKeys)("rejects model field %s with every JSON value at object nested and array positions", field => {
    const valid = suggestion("production_milestone");
    expect(parseAgentFulfillmentSuggestion(valid)).toEqual(valid);
    for (const value of [true, false, null, 0, "", "synthetic-value", {}, [], [false], { nested: null }, undefined]) {
      for (const raw of [{ [field]: value }, { nested: { [field]: value } }, [{ [field]: value }], { nested: [[{ [field]: value }]] }])
        expect(() => assertAgentFulfillmentModelFields(raw)).toThrow("agent_proposal_operator_field_forbidden");
      for (const raw of [{ ...valid, [field]: value }, { ...valid, original: { ...valid.original, [field]: value } },
        { ...valid, original: { ...valid.original, input: { ...valid.original.input, [field]: value } } },
        { ...valid, original: { ...valid.original, input: { evidence: { [field]: value } } } }])
        expect(() => parseAgentFulfillmentSuggestion(raw)).toThrow();
      if (agentModelOperatorFieldNames.some(name => name === field)) expect(() => assertAgentModelOperatorFields([{ [field]: value }])).toThrow();
    }
    for (const kind of FulfillmentCommandKindSchema.options) expect(agentFulfillmentSuggestionInputSchemas[kind].safeParse({ [field]: false }).success).toBe(false);
  });

  it("keeps actual scalar types source coordinates and finite model syntax strict", () => {
    const value = suggestion("production_milestone");
    for (const original of [{ ...value.original, kind: "marketplace_submit" }, { ...value.original, targetId: targetId.toUpperCase() },
      { ...value.original, input: { expectedProjectionVersion: "1" } }, { ...value.original, input: { evidence: { assetIds: ["not-an-entity"] } } }])
      expect(AgentFulfillmentSuggestionSchema.safeParse({ ...value, original }).success).toBe(false);
    for (const source of [{ ...value.source, stepId: "not-a-parent-step" }, { ...value.source, resultIndex: -1 },
      { ...value.source, resultIndex: 128 }, { ...value.source, expectedSequence: 0 }, { ...value.source, dataChecksum: hash.toUpperCase() }])
      expect(AgentFulfillmentSuggestionSchema.safeParse({ ...value, source }).success).toBe(false);
    for (const extra of [{ version: AGENT_FULFILLMENT_COMMAND_VERSION }, { domain: "finance" }, { execute: true }, { operatorConfirmed: true }])
      expect(AgentFulfillmentSuggestionSchema.safeParse({ ...value, ...extra }).success).toBe(false);
  });

  it("derives fresh pending checks only for the exact physical or operator conditions", () => {
    const expected = { delivery_feedback: [{ key: "verified_by_operator", path: ["input", "verifiedByOperator"], state: "pending", requiredWhen: "always" }],
      quality_group_inspection: [{ key: "physical_segregation", path: ["input", "segregationConfirmed"], state: "pending", requiredWhen: "always" }],
      production_recovery: [{ key: "physical_selection", path: ["input", "physicalSelectionConfirmed"], state: "pending", requiredWhen: "quality_group_selected" },
        { key: "order_unit_confirmed", path: ["input", "manufacturing", "orderUnitConfirmed"], state: "pending", requiredWhen: "manufacturing_selected" }] };
    for (const kind of FulfillmentCommandKindSchema.options) {
      const checks = agentFulfillmentOperatorChecks(kind);
      expect(checks).toEqual(Object.hasOwn(expected, kind) ? Reflect.get(expected, kind) : []);
      for (const check of checks) {
        expect(AgentFulfillmentOperatorCheckSchema.parse(check)).toEqual(check);
        for (const state of [true, false, null, "checked", "confirmed", "done"])
          expect(AgentFulfillmentOperatorCheckSchema.safeParse({ ...check, state }).success).toBe(false);
        expect(AgentFulfillmentOperatorCheckSchema.safeParse({ ...check, verifiedByOperator: true }).success).toBe(false);
      }
    }
    const altered = agentFulfillmentOperatorChecks("delivery_feedback"); altered[0]!.path[0] = "forged";
    expect(agentFulfillmentOperatorChecks("delivery_feedback")).toEqual(expected.delivery_feedback);
  });

  it("rejects model orderUnitConfirmed at the real recovery manufacturing path while requiring separate original human confirmation", () => {
    const partial = { type: "remake", originalProductionOrderId: targetId, manufacturing: { versionId: otherId } };
    expect(agentFulfillmentSuggestionInputSchemas.production_recovery.parse(partial)).toEqual(partial);
    expect(suggestion("production_recovery", partial).original.input).toEqual(partial);
    expect(agentModelOperatorFieldNames).toContain("orderUnitConfirmed");
    for (const value of [true, false, null, 0, "", [], {}, undefined]) {
      const input = { ...partial, manufacturing: { ...partial.manufacturing, orderUnitConfirmed: value } };
      expect(agentFulfillmentSuggestionInputSchemas.production_recovery.safeParse(input).success).toBe(false);
      expect(() => suggestion("production_recovery", input)).toThrow();
      expect(() => assertAgentModelOperatorFields({ nested: [[{ orderUnitConfirmed: value }]] })).toThrow("agent_proposal_operator_field_forbidden");
    }
    const original = completed("production_recovery"), input = { ...original.original.input,
      manufacturing: { versionId: otherId, orderUnitConfirmed: true } };
    expect(bindAgentFulfillmentCompletion(suggestion("production_recovery", partial), slotId,
      { ...original, original: { ...original.original, input } }).original.kind).toBe("production_recovery");
    for (const value of [undefined, false, null]) expect(() => bindAgentFulfillmentCompletion(suggestion("production_recovery", partial), slotId,
      { ...original, original: { ...original.original, input: { ...input, manufacturing: { versionId: otherId, orderUnitConfirmed: value } } } })).toThrow();
    expect(agentFulfillmentOperatorChecks("production_recovery")).toContainEqual({ key: "order_unit_confirmed",
      path: ["input", "manufacturing", "orderUnitConfirmed"], state: "pending", requiredWhen: "manufacturing_selected" });
  });

  it("accepts all fourteen completions only through the unchanged original owner Prepare schema and exact server slot", () => {
    for (const kind of FulfillmentCommandKindSchema.options) {
      const model = suggestion(kind), input = completed(kind), before = structuredClone(input);
      expect(bindAgentFulfillmentCompletion(model, slotId, input)).toEqual(PrepareAgentFulfillmentCommandSchema.parse(input));
      expect(PrepareFulfillmentCommandSchema.parse(input.original)).toEqual(input.original);
      expect(fulfillmentCommandRequestKey(input.original)).toBe(slotId); expect(input.original.requestId).toBe(slotId);
      expect(input).toEqual(before);
      expect(() => bindAgentFulfillmentCompletion(model, stepId, input)).toThrow("agent_fulfillment_completion_identity_mismatch");
      expect(() => bindAgentFulfillmentCompletion(model, "not-a-slot", input)).toThrow();
    }
  });

  it("locks order kind target package version request and the distinct original key without conflating a parent ID", () => {
    const model = suggestion("shipment_review"), input = completed("shipment_review");
    const alternate = completed("shipment_dispatch");
    for (const raw of [{ ...input, orderId: otherId }, { ...input, original: { ...input.original, requestId: otherId } },
      { ...input, original: { ...input.original, targetId: otherId } }, { ...input, original: { ...input.original, versionId: otherId } }, alternate,
      { ...input, original: { ...input.original, input: { ...input.original.input, idempotencyKey: otherId } } }]) {
      expect(PrepareAgentFulfillmentCommandSchema.safeParse(raw).success).toBe(true);
      expect(() => bindAgentFulfillmentCompletion(model, slotId, raw)).toThrow("agent_fulfillment_completion_identity_mismatch");
    }
    const feedback = completed("delivery_feedback");
    expect(() => bindAgentFulfillmentCompletion(suggestion("delivery_feedback"), slotId, { ...feedback, original: { ...feedback.original, packageId: otherId } }))
      .toThrow("agent_fulfillment_completion_identity_mismatch");
    const milestone = completed("production_milestone");
    expect(() => bindAgentFulfillmentCompletion(suggestion("production_milestone"), slotId,
      { ...milestone, original: { ...milestone.original, input: { ...milestone.original.input, externalEventId: otherId } } }))
      .toThrow("agent_fulfillment_completion_identity_mismatch");
  });

  it("does not weaken the original physical confirmation rules when a person completes the request", () => {
    for (const [kind, field] of [["delivery_feedback", "verifiedByOperator"], ["quality_group_inspection", "segregationConfirmed"]] as const) {
      const input = completed(kind);
      for (const value of [undefined, false, null]) expect(() => bindAgentFulfillmentCompletion(suggestion(kind), slotId,
        { ...input, original: { ...input.original, input: { ...input.original.input, [field]: value } } })).toThrow();
    }
    const recovery = completed("production_recovery"), input = { ...recovery.original.input, qualityGroupId: packageId,
      expectedProductionProjectionVersion: 1, physicalSelectionConfirmed: true };
    expect(bindAgentFulfillmentCompletion(suggestion("production_recovery"), slotId, { ...recovery, original: { ...recovery.original, input } }).original.kind)
      .toBe("production_recovery");
    expect(() => bindAgentFulfillmentCompletion(suggestion("production_recovery"), slotId,
      { ...recovery, original: { ...recovery.original, input: { ...input, physicalSelectionConfirmed: false } } })).toThrow();
    expect(() => bindAgentFulfillmentCompletion(suggestion("shipment_review"), slotId, { ...completed("shipment_review"), execute: true })).toThrow();
  });

  it("keeps proposal canonical identity independent from the later complete original checksum and preserves model content", () => {
    const raw = suggestion("delivery_feedback"), before = structuredClone(raw), originalCanonical = canonicalAgentFulfillmentSuggestion(raw);
    expect(originalCanonical).toBe(canonicalJson(raw));
    const input = completed("delivery_feedback"), bound = bindAgentFulfillmentCompletion(raw, slotId, input);
    const completeCanonical = fulfillmentCommandCanonicalJson(bound.original);
    expect(checksum(originalCanonical)).not.toBe(checksum(completeCanonical));
    expect(raw).toEqual(before); expect(canonicalAgentFulfillmentSuggestion(raw)).toBe(originalCanonical);
    expect(completeCanonical).toContain("verifiedByOperator"); expect(originalCanonical).not.toContain("verifiedByOperator");
    const changed = { ...raw, source: { ...raw.source, dataChecksum: "b".repeat(64) } };
    expect(checksum(canonicalAgentFulfillmentSuggestion(changed))).not.toBe(checksum(originalCanonical));
    const edited = { ...input, original: { ...input.original, input: { ...input.original.input, note: "Explicit operator authored correction" } } };
    expect(checksum(fulfillmentCommandCanonicalJson(bindAgentFulfillmentCompletion(raw, slotId, edited).original))).not.toBe(checksum(completeCanonical));
  });
});
