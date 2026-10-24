import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AGENT_FULFILLMENT_COMMAND_VERSION, PrepareAgentFulfillmentCommandSchema } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { AGENT_FULFILLMENT_PROPOSAL_VERSION, agentFulfillmentOperatorChecks, parseAgentFulfillmentSuggestion,
  type AgentFulfillmentSuggestion } from "@yummyai/contracts/ai/agent-fulfillment-proposal";
import { AGENT_FULFILLMENT_TOOL, AGENT_FULFILLMENT_VERSION, AgentFulfillmentCallSchema, AgentFulfillmentDefinitionSchema,
  AgentFulfillmentResultSchema, agentFulfillmentDataPayload, agentFulfillmentDefinitionPayload, canonicalAgentFulfillmentCall,
  type AgentFulfillmentProduction, type AgentFulfillmentShipment, type AgentFulfillmentSource } from "@yummyai/contracts/ai/agent-fulfillment";
import { FulfillmentCommandKindSchema, type FulfillmentCommandKind } from "@yummyai/contracts/order/fulfillment-command";
import { type AgentNativeV3Claim } from "@yummyai/contracts/ai/agent-native-v3";
import { AgentNativeV4ResolvedProposalSchema, agentNativeV4ProposalChecksumPayload, agentNativeV4ObservationBasisPayload,
  type AgentNativeV4Observation } from "@yummyai/contracts/ai/agent-native-v4";
import { agentFulfillmentHarness, agentFulfillmentSkill } from "./agent-fulfillment-gateway.js";
import { agentNativeV4Slots } from "./agent-native-v4-model.js";
import { buildNativeV4Observation, verifyNativeV4Claims, validateNativeV4Completion, verifyNativeV4ReadResult } from "./agent-native-v4-evidence.js";

const id = (value: number) => `01999cab-abcd-7000-8000-${value.toString(16).padStart(12, "0")}`;
const runId = id(1), orderId = id(2), lineId = id(3), productionId = id(4), productionVersionId = id(5);
const packageId = id(6), itemId = id(7), inspectionId = id(8), qualityGroupId = id(9), standardVersionId = id(10);
const manufacturingVersionId = id(11), shipmentId = id(12), shipmentVersionId = id(13), previousShipmentVersionId = id(14);
const factoryId = id(15), supplierId = id(16), slotId = agentNativeV4Slots(runId, 1)[0]!.id;
const now = "2026-10-23T00:00:00.000Z", later = "2026-10-24T00:00:00.000Z", authority = "synthetic-current-original-authority";
const fileHash = "a".repeat(64), contentHash = "b".repeat(64), planHash = "c".repeat(64), packageHash = "d".repeat(64);
const productionProjection = 17, workRevision = 4, workProjection = 9;
const checksum = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const pin = agentFulfillmentHarness.pin(agentFulfillmentSkill);
const absent = { state: "not_present", reason: null, data: null } as const;
const coverage = { returned: 1, originalCount: 1, truncated: false };
const assessment = { formatVersion: 2, criterionResults: [{ code: "PRINT", scoreBps: 10000, passed: true, evidenceAssetIds: [] }] };
const readDefinition = AgentFulfillmentDefinitionSchema.parse({ version: AGENT_FULFILLMENT_VERSION, tool: AGENT_FULFILLMENT_TOOL,
  contextAuthority: authority, label: "Synthetic sealed original fulfillment read", available: true, blockReason: null,
  definitionChecksum: fileHash, inputSchema: { type: "object" }, outputSchema: { type: "object" }, effect: "read",
  execution: "original_owner_fulfillment_projection", limitations: ["A saved owner DTO is not a physical operator action"] });
readDefinition.definitionChecksum = checksum(agentFulfillmentDefinitionPayload(readDefinition));

// This is the actual original owner projection shape, with synthetic references.
// Distinct work/prod projections and content/plan hashes prevent false positives.
function production(): AgentFulfillmentProduction {
  return { id: productionId, orderId, orderLineId: lineId, status: "completed", projectionVersion: productionProjection,
    currentVersionNumber: 2, currentVersionId: productionVersionId, quantity: 5, expectedCompletionAt: later, updatedAt: now,
    manufacturing: { id: id(30), bindingVersion: 1, productionOrderId: productionId, productionVersionId,
      recipeId: id(31), versionId: manufacturingVersionId, reviewId: id(32), versionNumber: 2, code: "SYNTHETIC", name: "Synthetic original manufacturing",
      spuId: id(33), skuId: null, specificationId: id(34), specificationVersionId: id(35), processProfileVersionId: id(36),
      canvasPrintSpecVersionId: null, source: "original_production_binding", workRevisionId: null, originalBindingId: id(37),
      quantity: 5, unit: "each", quantityBasis: "ordered_sku_units", contentChecksum: contentHash, createdAt: now },
    milestones: [{ id: id(38), sequence: 1, type: "completed", evidenceCode: "SYNTHETIC", occurredAt: now }], milestoneCoverage: coverage,
    quantityBasis: absent, quality: { state: "read", reason: null, data: { productionOrderId: productionId, orderId, productionVersionId,
      projectionVersion: productionProjection, rootInspectionId: inspectionId, groups: [{ id: qualityGroupId, inspectionId, productionOrderId: productionId,
        productionVersionId, parentGroupId: null, rootInspectionId: inspectionId, quantity: 5, result: "passed", scoreBps: 10000,
        qualityStandardVersionId: standardVersionId, inspectedAt: now, productionProjectionVersion: productionProjection, active: true,
        shippedQuantity: 0, remakeQuantity: 0, remainingRemakeQuantity: 5, scrappedQuantity: 0, reinspectableQuantity: 5,
        scrapBasisFingerprint: packageHash }], coverage } },
    delivery: { state: "read", reason: null, data: { packageId, itemId, status: "submitted", sequence: 2, productionVersionId,
      fileChecksum: fileHash, manufacturingContentChecksum: contentHash, manufacturingPlanChecksum: planHash,
      packageChecksum: packageHash, fileSourceAvailable: true } }, factory: absent };
}
const allocation = { productionOrderId: productionId, productionVersionId, qualityInspectionId: inspectionId,
  qualityGroupId, expectedProductionProjectionVersion: productionProjection, quantity: 5 };
function shipment(): AgentFulfillmentShipment {
  return { id: shipmentId, orderId, status: "draft", currentVersionNumber: 2, approvedVersionNumber: null, updatedAt: now,
    versions: [{ id: shipmentVersionId, versionNumber: 2, shipDate: now, productionSourceVersion: 2 },
      { id: previousShipmentVersionId, versionNumber: 1, shipDate: now, productionSourceVersion: 2 }],
    packages: [{ id: packageId, shipmentVersionId, trackingPresent: true }],
    packageLines: [{ packageId, orderLineId: lineId, quantity: 5 }],
    allocations: [{ packageId, orderLineId: lineId, shipmentVersionId, productionOrderId: productionId,
      productionVersionId, qualityInspectionId: inspectionId, qualityGroupId, quantity: 5 }],
    tracking: [], writebacks: [], physicalHandover: { shipmentVersionId: null, packageCount: 1, dispatchedPackageCount: 0, allDispatched: false },
    historyCoverage: { versions: { returned: 2, originalCount: 2, truncated: false }, packages: coverage, packageLines: coverage,
      allocations: coverage, tracking: { returned: 0, originalCount: 0, truncated: false }, writebacks: { returned: 0, originalCount: 0, truncated: false } } };
}
function packet(kind: "production" | "shipments", row: AgentFulfillmentProduction | AgentFulfillmentShipment = kind === "production" ? production() : shipment()) {
  const call = AgentFulfillmentCallSchema.parse({ version: AGENT_FULFILLMENT_VERSION, tool: AGENT_FULFILLMENT_TOOL,
    executionContract: pin, definitionChecksum: readDefinition.definitionChecksum, input: { orderId, expectedSequence: 3, kind, pageSize: 10, cursor: null } });
  const sources: AgentFulfillmentSource[] = [{ owner: "orders", kind: "order_projection", id: orderId, versionId: null, revision: 3, checksum: null }];
  if ("orderLineId" in row) {
    sources.push({ owner: "production", kind: "production_projection", id: row.id, versionId: row.currentVersionId, revision: row.projectionVersion, checksum: null });
    if (row.manufacturing) sources.push({ owner: "manufacturing", kind: "production_manufacturing_pin", id: row.manufacturing.id,
      versionId: row.manufacturing.versionId, revision: row.manufacturing.versionNumber, checksum: row.manufacturing.contentChecksum });
    for (const group of row.quality.data?.groups ?? []) sources.push({ owner: "quality", kind: "physical_quality_group", id: group.id,
      versionId: group.productionVersionId, revision: group.productionProjectionVersion, checksum: group.scrapBasisFingerprint ?? null });
    if (row.delivery.data) sources.push({ owner: "production", kind: "delivery_package", id: row.delivery.data.packageId,
      versionId: row.delivery.data.productionVersionId, revision: row.delivery.data.sequence, checksum: row.delivery.data.packageChecksum });
  } else {
    const current = row.versions.find(version => version.versionNumber === row.currentVersionNumber);
    if (!current) throw new Error("synthetic_current_shipment_version_required");
    sources.push({ owner: "shipments", kind: "shipment_projection", id: row.id, versionId: current.id, revision: row.currentVersionNumber, checksum: null });
    for (const allocation of row.allocations) sources.push({ owner: "production", kind: "shipment_production_allocation",
      id: allocation.productionOrderId, versionId: allocation.productionVersionId, revision: null, checksum: null });
  }
  const value = AgentFulfillmentResultSchema.parse({ version: AGENT_FULFILLMENT_VERSION, tool: AGENT_FULFILLMENT_TOOL, contextAuthority: authority,
    callId: id(kind === "production" ? 40 : 41), checkedAt: now, readStartedAt: now, input: call.input,
    definitionChecksum: readDefinition.definitionChecksum, inputChecksum: checksum(JSON.parse(canonicalAgentFulfillmentCall(call))), dataChecksum: fileHash,
    sources,
    data: { kind, order: { id: orderId, number: "SYNTHETIC", sequence: 3, mainState: "in_production", sideState: null,
      lines: [{ id: lineId, quantity: 5, sku: "SYNTHETIC" }] }, rows: [row], coverage: { complete: false, kind: "original_owner_page_projection",
      returned: 1, indexedTotal: 1, hasMore: false, nextCursor: null, collectionChecksum: packageHash,
      limitation: "Index exhaustion is not complete business or physical evidence" } },
    consistency: "owner_reads_fenced_not_single_transaction_snapshot", modelCalled: false, businessExecuted: false });
  value.dataChecksum = checksum(agentFulfillmentDataPayload(value)); verifyNativeV4ReadResult(value, call); return value;
}
function observed(kind: "production" | "shipments", value = packet(kind), stepId = id(kind === "production" ? 42 : 43)): AgentNativeV4Observation {
  return buildNativeV4Observation({ stepId, input: { request: { bindings: [{ tool: AGENT_FULFILLMENT_TOOL, scope: { orderId, expectedSequence: 3, kind } }] },
    fulfillmentExecutionContract: pin }, request: { bindingIndex: 0, keyword: null }, results: [value], truncatedBy: null });
}
function sourceKind(kind: FulfillmentCommandKind) {
  return ["shipment_version", "shipment_review", "shipment_dispatch", "shipment_platform_confirmation"].includes(kind) ? "shipments" as const : "production" as const;
}
function target(kind: FulfillmentCommandKind) {
  if (kind === "delivery_feedback") return itemId;
  if (["production_milestone", "quality_inspection", "quality_group_inspection", "production_recovery"].includes(kind)) return productionId;
  return sourceKind(kind) === "shipments" ? shipmentId : orderId;
}
const partialInputs: Record<FulfillmentCommandKind, Record<string, unknown>> = {
  delivery_create: { items: [{ productionOrderId: productionId, productionVersionId, expectedProjectionVersion: productionProjection }] },
  delivery_feedback: { expectedSequence: 2, fileChecksum: fileHash, manufacturingChecksum: planHash },
  production_milestone: { expectedProjectionVersion: productionProjection },
  quality_inspection: { expectedProductionProjectionVersion: productionProjection, qualityStandardVersionId: standardVersionId },
  quality_group_inspection: { productionVersionId, expectedProductionProjectionVersion: productionProjection,
    expectedRootInspectionId: inspectionId, qualityStandardVersionId: standardVersionId },
  production_recovery: { type: "remake", originalProductionOrderId: productionId, qualityGroupId,
    expectedProductionProjectionVersion: productionProjection, manufacturing: { versionId: manufacturingVersionId } },
  whole_production_milestone: { items: [{ lineId, productionOrderId: productionId, expectedProductionProjectionVersion: productionProjection }] },
  whole_quality_inspection: { items: [{ lineId, productionOrderId: productionId, expectedProductionProjectionVersion: productionProjection }], qualityStandardVersionId: standardVersionId },
  shipment_create: { packages: [{ lines: [{ orderLineId: lineId, productionAllocations: [allocation] }] }] },
  whole_shipment_create: { items: [{ lineId, productionAllocations: [allocation] }] },
  shipment_version: { expectedCurrentVersion: 2, packages: [{ lines: [{ orderLineId: lineId,
    productionAllocations: [{ productionOrderId: productionId, productionVersionId, qualityInspectionId: inspectionId, qualityGroupId }] }] }] },
  shipment_review: { expectedCurrentVersion: 2 }, shipment_dispatch: { expectedVersion: 2 }, shipment_platform_confirmation: { expectedVersion: 2 },
};
function suggested(kind: FulfillmentCommandKind, observation: AgentNativeV4Observation, input: unknown = partialInputs[kind]): AgentFulfillmentSuggestion {
  return parseAgentFulfillmentSuggestion({ version: AGENT_FULFILLMENT_PROPOSAL_VERSION, domain: "fulfillment",
    source: { stepId: observation.stepId, resultIndex: 0, dataChecksum: observation.results[0]!.dataChecksum, orderId, expectedSequence: 3 },
    original: { kind, targetId: target(kind), input, ...(kind === "delivery_feedback" ? { packageId } : {}), ...(kind === "shipment_review" ? { versionId: shipmentVersionId } : {}) } });
}
function resolved(suggestion: AgentFulfillmentSuggestion, observation: AgentNativeV4Observation) {
  const claim: AgentNativeV3Claim = { stepId: observation.stepId, resultIndex: 0, dataChecksum: observation.results[0]!.dataChecksum, path: ["order", "sequence"], value: 3 };
  const draft = { position: 0, capability: { domain: "fulfillment", kind: suggestion.original.kind }, label: "Synthetic pinned original suggestion",
    reason: "Person completes and confirms through the original owner", original: null, fulfillment: suggestion, claims: [], missingInformation: [] };
  const value = AgentNativeV4ResolvedProposalSchema.parse({ id: slotId, position: 0, proposalChecksum: fileHash, originalChecksum: null,
    preparationRequestChecksum: null, draft, claimIndexes: [0], operatorChecks: agentFulfillmentOperatorChecks(suggestion.original.kind) });
  value.proposalChecksum = checksum(agentNativeV4ProposalChecksumPayload(value, [claim]));
  return { claims: [claim], proposals: [value] };
}
function setup(kind: FulfillmentCommandKind, input?: unknown) {
  const observation = observed(sourceKind(kind)), suggestion = suggested(kind, observation, input ?? partialInputs[kind]);
  return { observation, suggestion, result: resolved(suggestion, observation) };
}
function completed(kind: FulfillmentCommandKind) {
  const evidence = { code: "SYNTHETIC", note: "Explicit synthetic operator observation", assetIds: [] };
  const wholeLine = { lineId, quantity: 5, expectedRevision: workRevision, expectedProjectionVersion: workProjection,
    productionOrderId: productionId, expectedProductionProjectionVersion: productionProjection };
  const shipping = { shipDate: now, shipFromCountryCode: "US", packages: [{ packageReferenceId: "SYNTHETIC-1", trackingNumber: "SYNTHETIC-TRACKING",
    carrierCode: "SYNTHETIC", carrierName: "Synthetic only", carrierService: "Synthetic only", lines: [{ orderLineId: lineId, quantity: 5, productionAllocations: [allocation] }] }] };
  const full: Record<FulfillmentCommandKind, Record<string, unknown>> = {
    delivery_create: { factoryId, supplierId, ...partialInputs.delivery_create },
    delivery_feedback: { kind: "received", ...partialInputs.delivery_feedback, reference: "SYNTHETIC", note: "Explicit synthetic original operator receipt",
      occurredAt: now, verifiedByOperator: true },
    production_milestone: { type: "started", ...partialInputs.production_milestone, occurredAt: now, evidence },
    quality_inspection: { ...partialInputs.quality_inspection, result: "passed", scoreBps: 10000, inspectedAt: now, assessment, defects: [], evidenceAssetIds: [] },
    quality_group_inspection: { ...partialInputs.quality_group_inspection, formatVersion: 3, inspectedAt: now, segregationConfirmed: true,
      groups: [{ key: "good", label: "Synthetic physical bin", quantity: 5, criterionResults: assessment.criterionResults, defects: [] }] },
    production_recovery: { ...partialInputs.production_recovery, remakeQuantity: 1, reason: "Synthetic original recovery", expectedCompletionAt: later,
      physicalSelectionConfirmed: true, manufacturing: { versionId: manufacturingVersionId, orderUnitConfirmed: true },
      reviewedArtwork: { renderId: id(50), expectedRevision: workRevision, expectedProjectionVersion: workProjection, instructions: "Independently checked in the original form" } },
    whole_production_milestone: { type: "started", occurredAt: now, evidence, items: [wholeLine] },
    whole_quality_inspection: { qualityStandardVersionId: standardVersionId, scoreBps: 10000, inspectedAt: now, assessment, evidenceAssetIds: [], items: [wholeLine] },
    shipment_create: shipping,
    whole_shipment_create: { shipDate: now, shipFromCountryCode: "US", trackingNumber: "SYNTHETIC-TRACKING", carrierCode: "SYNTHETIC",
      carrierName: "Synthetic only", carrierService: "Synthetic only", items: [{ lineId, quantity: 5, expectedRevision: workRevision,
        expectedProjectionVersion: workProjection, productionAllocations: [allocation] }] },
    shipment_version: { ...shipping, expectedCurrentVersion: 2 },
    shipment_review: { expectedCurrentVersion: 2, decision: "approved", reasonCode: "SYNTHETIC", reason: "Explicit original package review" },
    shipment_dispatch: { expectedVersion: 2, reason: "Synthetic physical handover", occurredAt: now },
    shipment_platform_confirmation: { expectedVersion: 2, evidenceReference: "Synthetic platform observation only", confirmedAt: now },
  };
  return PrepareAgentFulfillmentCommandSchema.parse({ version: AGENT_FULFILLMENT_COMMAND_VERSION, orderId,
    original: { kind, requestId: slotId, targetId: target(kind), input: { ...full[kind], ...(kind === "production_milestone" ? { externalEventId: slotId } : { idempotencyKey: slotId }) },
      ...(kind === "delivery_feedback" ? { packageId } : {}), ...(kind === "shipment_review" ? { versionId: shipmentVersionId } : {}) } });
}

describe("native4 exact original fulfillment source evidence", () => {
  it.each(FulfillmentCommandKindSchema.options)("keeps %s on its selected original source and accepts a separate complete original form", kind => {
    const value = setup(kind), original = structuredClone(value);
    expect(() => verifyNativeV4Claims(value.result, [value.observation])).not.toThrow();
    expect(() => validateNativeV4Completion(value.result.proposals[0]!, completed(kind), [value.observation])).not.toThrow();
    expect(value).toEqual(original);
    expect(value.result.proposals[0]!.originalChecksum).toBeNull(); expect(value.result.proposals[0]!.preparationRequestChecksum).toBeNull();
    expect(value.observation.collectionComplete).toBeNull(); expect(value.observation.indexComplete).toBe(true);
  });

  it("binds the exact source step result checksum order and sequence without borrowing another same-order read", () => {
    const value = setup("production_milestone");
    for (const extra of [{ stepId: id(70) }, { resultIndex: 1 }, { dataChecksum: packageHash }, { orderId: id(71) }, { expectedSequence: 4 }]) {
      const altered = { ...value.suggestion, source: { ...value.suggestion.source, ...extra } };
      expect(() => verifyNativeV4Claims(resolved(altered, value.observation), [value.observation])).toThrow("agent_native_fulfillment_source_invalid");
    }
    const empty = packet("production");
    if (empty.data.kind !== "production") throw new Error("synthetic_production_packet_required");
    empty.callId = id(72); empty.data.rows = []; empty.data.coverage = { ...empty.data.coverage, returned: 0, indexedTotal: 0 };
    empty.dataChecksum = checksum(agentFulfillmentDataPayload(empty));
    const other = observed("production", empty, id(73)), borrowed = { ...value.suggestion, source: { ...value.suggestion.source,
      stepId: other.stepId, dataChecksum: other.results[0]!.dataChecksum } };
    expect(() => verifyNativeV4Claims(resolved(borrowed, other), [value.observation, other])).toThrow("agent_native_fulfillment_source_invalid");
  });

  it("rejects altered sealed bytes fake claim values and a result hash that does not cover the actual original data", () => {
    const value = setup("production_milestone"), changed = structuredClone(value.observation);
    const packet = changed.results[0]; if (!packet || packet.version !== AGENT_FULFILLMENT_VERSION || packet.data.kind !== "production") throw new Error("synthetic_production_packet_required");
    packet.data.rows[0]!.projectionVersion++;
    expect(() => verifyNativeV4Claims(value.result, [changed])).toThrow("agent_native_evidence_invalid");
    expect(() => verifyNativeV4Claims({ ...value.result, claims: [{ ...value.result.claims[0]!, value: 4 }] }, [value.observation])).toThrow("agent_native_claim_invalid");
    const oldBasis = { ...value.observation, basisChecksum: fileHash };
    expect(() => verifyNativeV4Claims(value.result, [oldBasis])).toThrow("agent_native_evidence_invalid");
  });

  it("uses the actual manufacturing plan checksum for delivery feedback rather than the different content checksum", () => {
    expect(contentHash).not.toBe(planHash);
    const value = setup("delivery_feedback");
    expect(() => verifyNativeV4Claims(value.result, [value.observation])).not.toThrow();
    expect(() => validateNativeV4Completion(value.result.proposals[0]!, completed("delivery_feedback"), [value.observation])).not.toThrow();
    for (const extra of [{ expectedSequence: 1 }, { fileChecksum: packageHash }, { manufacturingChecksum: contentHash }]) {
      const input = { ...partialInputs.delivery_feedback, ...extra }, altered = suggested("delivery_feedback", value.observation, input);
      expect(() => verifyNativeV4Claims(resolved(altered, value.observation), [value.observation])).toThrow();
    }
    for (const original of [{ ...value.suggestion.original, targetId: id(74) }, { ...value.suggestion.original, packageId: id(75) }])
      expect(() => verifyNativeV4Claims(resolved(parseAgentFulfillmentSuggestion({ ...value.suggestion, original }), value.observation), [value.observation])).toThrow();
  });

  it("rejects foreign production versions projections quality groups and a historical shipment version posing as current", () => {
    for (const [kind, input] of [
      ["production_milestone", { expectedProjectionVersion: workProjection }],
      ["quality_group_inspection", { ...partialInputs.quality_group_inspection, productionVersionId: id(76) }],
      ["quality_group_inspection", { ...partialInputs.quality_group_inspection, expectedRootInspectionId: id(77) }],
      ["production_recovery", { ...partialInputs.production_recovery, qualityGroupId: id(78) }],
      ["shipment_version", { ...partialInputs.shipment_version, expectedCurrentVersion: 1 }],
      ["shipment_dispatch", { expectedVersion: 1 }],
    ] as const) {
      const value = setup(kind, input); expect(() => verifyNativeV4Claims(value.result, [value.observation])).toThrow();
    }
    const value = setup("shipment_review"), altered = parseAgentFulfillmentSuggestion({ ...value.suggestion,
      original: { ...value.suggestion.original, versionId: previousShipmentVersionId } });
    expect(() => verifyNativeV4Claims(resolved(altered, value.observation), [value.observation])).toThrow("agent_native_fulfillment_source_invalid");
  });

  it("keeps the inspected physical-group projection when recording quality advances production", () => {
    const row = production(), groupProjection = productionProjection - 1;
    if (row.quality.state !== "read" || !row.quality.data) throw new Error("synthetic_quality_required");
    row.quality.data.groups[0]!.productionProjectionVersion = groupProjection;
    const observation = observed("production", packet("production", row));
    const pinnedAllocation = { ...allocation, expectedProductionProjectionVersion: groupProjection };
    const input = { packages: [{ packageReferenceId: "SYNTHETIC-NEW-PACKAGE", lines: [{ orderLineId: lineId, productionAllocations: [pinnedAllocation] }] }] };
    const suggestion = suggested("shipment_create", observation, input), result = resolved(suggestion, observation);
    expect(() => verifyNativeV4Claims(result, [observation])).not.toThrow();
    const completion = completed("shipment_create");
    if (completion.original.kind !== "shipment_create") throw new Error("synthetic_shipping_required");
    completion.original.input.packages[0]!.packageReferenceId = "SYNTHETIC-NEW-PACKAGE";
    completion.original.input.packages[0]!.lines[0]!.productionAllocations = [pinnedAllocation];
    expect(() => validateNativeV4Completion(result.proposals[0]!, completion, [observation])).not.toThrow();
    for (const [altered, expectedError] of [
      [{ ...pinnedAllocation, expectedProductionProjectionVersion: productionProjection }, "agent_native_fulfillment_source_invalid"],
      [{ ...pinnedAllocation, qualityGroupId: id(96) }, "agent_native_fulfillment_source_unavailable"],
      [{ ...pinnedAllocation, productionVersionId: id(97) }, "agent_native_fulfillment_source_unavailable"],
      [{ ...pinnedAllocation, qualityInspectionId: id(98) }, "agent_native_fulfillment_source_unavailable"],
    ] as const) {
      const changed = suggested("shipment_create", observation, { packages: [{ lines: [{ orderLineId: lineId, productionAllocations: [altered] }] }] });
      expect(() => verifyNativeV4Claims(resolved(changed, observation), [observation])).toThrow(expectedError);
    }
    const ungrouped = { ...allocation, qualityGroupId: null, expectedProductionProjectionVersion: productionProjection };
    const plain = suggested("shipment_create", observation, { packages: [{ lines: [{ orderLineId: lineId, productionAllocations: [ungrouped] }] }] });
    expect(() => verifyNativeV4Claims(resolved(plain, observation), [observation])).not.toThrow();
    ungrouped.expectedProductionProjectionVersion = groupProjection;
    const stale = suggested("shipment_create", observation, { packages: [{ lines: [{ orderLineId: lineId, productionAllocations: [ungrouped] }] }] });
    expect(() => verifyNativeV4Claims(resolved(stale, observation), [observation])).toThrow("agent_native_fulfillment_source_invalid");
  });

  it("does not infer unseen work revisions or work projections from a production projection or other same-order read", () => {
    expect(productionProjection).not.toBe(workProjection); expect(productionProjection).not.toBe(workRevision);
    for (const kind of ["whole_production_milestone", "whole_quality_inspection"] as const) {
      const value = setup(kind); expect(() => verifyNativeV4Claims(value.result, [value.observation])).not.toThrow();
      for (const workPin of [{ expectedRevision: productionProjection }, { expectedProjectionVersion: productionProjection }]) {
        const input = { ...partialInputs[kind], items: [{ lineId, productionOrderId: productionId,
          expectedProductionProjectionVersion: productionProjection, ...workPin }] };
        const altered = suggested(kind, value.observation, input);
        expect(() => verifyNativeV4Claims(resolved(altered, value.observation), [value.observation])).toThrow("agent_native_fulfillment_source_unavailable");
      }
      const beforeClaims = structuredClone(value.result.claims), beforeProposal = structuredClone(value.result.proposals[0]);
      expect(() => validateNativeV4Completion(value.result.proposals[0]!, completed(kind), [value.observation])).not.toThrow();
      expect(value.result.claims).toEqual(beforeClaims); expect(value.result.proposals[0]).toEqual(beforeProposal);
      expect(value.result.claims.some(claim => claim.path.includes("expectedRevision") || claim.path.includes("expectedProjectionVersion"))).toBe(false);
    }
    const recovery = setup("production_recovery", { ...partialInputs.production_recovery,
      reviewedArtwork: { renderId: id(50), expectedRevision: workRevision, expectedProjectionVersion: workProjection } });
    expect(() => verifyNativeV4Claims(recovery.result, [recovery.observation])).toThrow("agent_native_fulfillment_source_unavailable");
  });

  it("refuses an unseen model manufacturing version but permits independent original-form additions without adding model claims", () => {
    const source = packet("production"); if (source.data.kind !== "production") throw new Error("synthetic_production_packet_required");
    source.data.rows[0]!.manufacturing = null; source.dataChecksum = checksum(agentFulfillmentDataPayload(source));
    const observation = observed("production", source), model = suggested("production_recovery", observation, {
      originalProductionOrderId: productionId, expectedProductionProjectionVersion: productionProjection });
    const value = resolved(model, observation); expect(() => verifyNativeV4Claims(value, [observation])).not.toThrow();
    const invented = suggested("production_recovery", observation, { ...model.original.input, manufacturing: { versionId: manufacturingVersionId } });
    expect(() => verifyNativeV4Claims(resolved(invented, observation), [observation])).toThrow("agent_native_fulfillment_source_unavailable");
    const before = structuredClone(value); expect(() => validateNativeV4Completion(value.proposals[0]!, completed("production_recovery"), [observation])).not.toThrow();
    expect(value).toEqual(before);
  });

  it("locks original source pins when a person completes the fixed slot without adopting another target package or version", () => {
    const value = setup("delivery_feedback"), original = completed("delivery_feedback");
    for (const raw of [{ ...original, orderId: id(80) }, { ...original, original: { ...original.original, requestId: id(81) } },
      { ...original, original: { ...original.original, packageId: id(82) } },
      { ...original, original: { ...original.original, input: { ...original.original.input, idempotencyKey: id(83) } } },
      { ...original, original: { ...original.original, input: { ...original.original.input, fileChecksum: packageHash } } }])
      expect(() => validateNativeV4Completion(value.result.proposals[0]!, raw, [value.observation])).toThrow();
    const shipment = setup("shipment_review"), completedReview = completed("shipment_review");
    expect(() => validateNativeV4Completion(shipment.result.proposals[0]!, { ...completedReview,
      original: { ...completedReview.original, versionId: previousShipmentVersionId } }, [shipment.observation])).toThrow();
    const whole = setup("whole_production_milestone"), full = completed("whole_production_milestone");
    const changed = { ...full, original: { ...full.original, input: { ...full.original.input,
      items: [{ lineId, productionOrderId: id(84), quantity: 5, expectedRevision: workRevision,
        expectedProjectionVersion: workProjection, expectedProductionProjectionVersion: productionProjection }] } } };
    expect(() => validateNativeV4Completion(whole.result.proposals[0]!, changed, [whole.observation])).toThrow();
  });

  it("keeps raw temporal envelope changes separate from immutable source content hashes", () => {
    const value = setup("production_milestone"), changed = structuredClone(value.observation), first = changed.results[0];
    if (!first || first.version !== AGENT_FULFILLMENT_VERSION) throw new Error("synthetic_original_packet_required");
    first.callId = id(85); first.checkedAt = later; first.readStartedAt = later; first.contextAuthority = "synthetic-later-real-authority";
    changed.basisChecksum = checksum(agentNativeV4ObservationBasisPayload(changed));
    expect(first.dataChecksum).toBe(value.observation.results[0]!.dataChecksum);
    expect(() => verifyNativeV4Claims(value.result, [changed])).not.toThrow();
    expect(value.observation.results[0]!.checkedAt).toBe(now);
  });
});
