import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { canonicalJson } from "../common/canonical-json.js";
import { AgentNativeV2BindingSchema, CreateAgentNativeV2Schema } from "./agent-native-v2.js";
import { AgentFulfillmentResultSchema, AGENT_FULFILLMENT_TOOL } from "./agent-fulfillment.js";
import {
  AGENT_NATIVE_V3_VERSION, AgentNativeV3BindingSchema, AgentNativeV3ReadKeySchema, CreateAgentNativeV3Schema,
  AgentNativeV3ObservationSchema, AgentNativeV3DecisionSchema, AgentNativeV3ReceiptSchema, AgentNativeV3ItemReceiptSchema,
  AgentNativeV3IntentSchema, AgentNativeV3PreparationIntentSchema, defaultAgentNativeV3Limits, canonicalAgentNativeV3Request,
  agentNativeV3ClaimValue, agentNativeV3SourceBasis, agentNativeV3ObservationBasisPayload, type AgentNativeV3Observation,
} from "./agent-native-v3.js";

const hash = "a".repeat(64), time = "2026-10-22T00:00:00.000Z", id = createEntityId();
const pin = { contractVersion: "native-harness-v1", executorKey: "erp.agent.native.v3", checksum: hash,
  skill: { key: "erp.agent.native.v3", version: AGENT_NATIVE_V3_VERSION, checksum: hash },
  tools: [{ key: "agent.native.v3.decide", version: AGENT_NATIVE_V3_VERSION, checksum: hash }] };
const bindings = [
  { tool: "orders.exceptions.page", scope: { status: "all" } }, { tool: "inventory.balances.page", scope: { stockItemId: id } },
  { tool: "knowledge.search", scope: { topic: "all", platform: "all", market: "ALL", spuIds: [] } },
  { tool: "creative.history", scope: { scope: "inspection", ownerId: id } }, { tool: "factory.capacity", scope: { factoryId: id, query: { from: "2026-10-22", days: 1 } } },
  { tool: "research.evidence", scope: { researchItemId: id, snapshotId: id, studyRevisionId: null } },
  { tool: "catalog.sku", scope: { skuId: id, recipeId: null } }, { tool: "listing.version", scope: { listingId: id, versionId: id } },
  { tool: "orders.order", scope: { orderId: id, expectedSequence: 1 } }, { tool: "finance.profit_run", scope: { runId: id } },
  { tool: "advertising.analysis", scope: { accountId: id, analysisId: id } },
  ...["production", "shipments", "logistics"].map(kind => ({ tool: AGENT_FULFILLMENT_TOOL, scope: { orderId: id, expectedSequence: 1, kind } })),
];
function request() { return { version: AGENT_NATIVE_V3_VERSION, requestId: randomUUID(), goal: "Read the fourteen separately fixed original sources",
  contextText: "Unverified operator notes", modelId: id, bindings, allowedCommands: [], limits: defaultAgentNativeV3Limits(), maxCostUsd: 1, executionContract: pin }; }
function observation(): AgentNativeV3Observation {
  const result = AgentFulfillmentResultSchema.parse({ version: "erp-agent-fulfillment-v1", tool: AGENT_FULFILLMENT_TOOL,
    contextAuthority: "synthetic-current-authority", callId: createEntityId(), checkedAt: time, readStartedAt: time,
    input: { orderId: id, expectedSequence: 1, kind: "logistics", pageSize: 1, cursor: null }, definitionChecksum: hash, inputChecksum: hash, dataChecksum: hash,
    sources: [{ owner: "orders", kind: "order", id, versionId: null, revision: 1, checksum: null }],
    data: { kind: "logistics", order: { id, number: "SYNTHETIC-ORIGINAL", sequence: 1, mainState: "in_production", sideState: null,
      lines: [{ id: createEntityId(), quantity: 5, sku: "SYNTHETIC" }] }, rows: [{ id: createEntityId(), orderId: id, factoryId: createEntityId(),
      status: "completed", privateAvailable: true, createdAt: time, updatedAt: time, expiresAt: time,
      connectionVersionId: createEntityId(), ruleVersionId: createEntityId(), productionVersionIds: [], snapshotChecksum: hash,
      quotedCostMinor: 500, actualCostMinor: 600, quotedCurrency: "USD", actualCurrency: "USD", minorUnitDigits: 2, trackingCount: 1, labelCount: 0 }],
      coverage: { complete: false, kind: "original_owner_page_projection", returned: 1, indexedTotal: 1, hasMore: false, nextCursor: null,
        collectionChecksum: hash, limitation: "The fixed index is exhausted, not a complete account of physical fulfillment" } },
    consistency: "owner_reads_fenced_not_single_transaction_snapshot", modelCalled: false, businessExecuted: false });
  return AgentNativeV3ObservationSchema.parse({ stepId: createEntityId(), tool: result.tool, request: { bindingIndex: 13, keyword: null },
    results: [result], basisChecksum: hash, observedRows: 1, collectionComplete: null, indexComplete: true, truncatedBy: null });
}

describe("independent native v3 same-order fulfillment contract", () => {
  it("fixes fourteen bindings and twelve tool keys without widening the historical eleven-reader protocol", () => {
    const value = CreateAgentNativeV3Schema.parse(request()); expect(value.bindings).toHaveLength(14);
    expect(new Set(value.bindings.map(binding => binding.tool))).toEqual(new Set(AgentNativeV3ReadKeySchema.options));
    expect(AgentNativeV3ReadKeySchema.options).toHaveLength(12);
    expect(AgentNativeV2BindingSchema.safeParse(value.bindings[11]).success).toBe(false);
    expect(CreateAgentNativeV2Schema.safeParse({ ...value, version: "erp-agent-native-v2" }).success).toBe(false);
    for (const scope of [{ orderId: id, expectedSequence: 0, kind: "production" },
      { orderId: id, expectedSequence: 1, kind: "production", cursor: "caller-controlled" },
      { orderId: id, expectedSequence: 1, kind: "production", pageSize: 10 }])
      expect(AgentNativeV3BindingSchema.safeParse({ tool: AGENT_FULFILLMENT_TOOL, scope }).success).toBe(false);
    expect(CreateAgentNativeV3Schema.safeParse({ ...value, bindings: [...value.bindings, value.bindings[11]] }).success).toBe(false);
    expect(canonicalAgentNativeV3Request(Object.fromEntries(Object.entries(value).reverse()))).toBe(canonicalAgentNativeV3Request(value));
  });

  it("separates fulfillment index exhaustion from complete business coverage and refuses automatic business actions", () => {
    const value = observation(); expect(value.indexComplete).toBe(true); expect(value.collectionComplete).toBeNull();
    expect(value.results[0]!.version).toBe("erp-agent-fulfillment-v1");
    for (const invalid of [{ ...value, collectionComplete: true }, { ...value, indexComplete: null },
      { ...value, indexComplete: false }, { ...value, truncatedBy: "row_limit" }, { ...value, tool: "catalog.sku" }])
      expect(AgentNativeV3ObservationSchema.safeParse(invalid).success).toBe(false);
    const firstPage = AgentFulfillmentResultSchema.parse(value.results[0]);
    firstPage.data.coverage = { ...firstPage.data.coverage, indexedTotal: 2, hasMore: true, nextCursor: "original-next-page" };
    expect(AgentNativeV3ObservationSchema.safeParse({ ...value, results: [firstPage], indexComplete: false, truncatedBy: "row_limit" }).success).toBe(true);
    for (const action of ["prepare", "confirm", "execute", "approve", "publish"])
      expect(AgentNativeV3DecisionSchema.safeParse({ action, label: "Forbidden automatic action", definition: null, read: null, result: null }).success).toBe(false);
  });

  it("retains exact minor units currency nulls and every sealed source value while excluding only the call envelope", () => {
    const value = observation(), original = value.results[0]!;
    if (original.version !== "erp-agent-fulfillment-v1" || original.data.kind !== "logistics") throw new Error("Synthetic logistics packet expected");
    const claim = { stepId: value.stepId, resultIndex: 0, dataChecksum: hash, path: ["rows", 0, "actualCostMinor"], value: 6 };
    expect(agentNativeV3ClaimValue(value, claim)).toBe(600);
    expect(agentNativeV3ClaimValue(value, { ...claim, path: ["rows", 0, "actualCurrency"], value: "EUR" })).toBe("USD");
    for (const path of [["coverage", "indexedTotal"], ["rows", 0, "constructor"], ["rows", "0", "actualCostMinor"], ["rows", 0]])
      expect(() => agentNativeV3ClaimValue(value, { ...claim, path })).toThrow();
    const later = structuredClone(original); later.callId = createEntityId(); later.checkedAt = "2026-10-23T00:00:00.000Z";
    later.readStartedAt = later.checkedAt; later.contextAuthority = "another-current-authority";
    expect(agentNativeV3SourceBasis(later)).toEqual(agentNativeV3SourceBasis(original));
    if (later.data.kind !== "logistics") throw new Error("Synthetic logistics packet expected");
    later.data.rows[0]!.actualCostMinor = null;
    expect(canonicalJson(agentNativeV3SourceBasis(later))).not.toBe(canonicalJson(agentNativeV3SourceBasis(original)));
    expect(canonicalJson(agentNativeV3ObservationBasisPayload({ ...value, indexComplete: false, truncatedBy: "tool_limit" })))
      .not.toBe(canonicalJson(agentNativeV3ObservationBasisPayload(value)));
  });

  it("keeps parent child and seven-scalar recovery distinct from a new paid or prepared business request", () => {
    const requestId = randomUUID(), unknown = { version: AGENT_NATIVE_V3_VERSION, requestId, requestChecksum: hash, disposition: "not_found",
      runId: null, status: null, contextAuthority: "current", privateAvailable: false };
    expect(AgentNativeV3ReceiptSchema.safeParse(unknown).success).toBe(true);
    expect(AgentNativeV3ReceiptSchema.safeParse({ ...unknown, runId: id }).success).toBe(false);
    const item = { version: AGENT_NATIVE_V3_VERSION, runId: id, itemId: id, proposalChecksum: hash, preparationRequestChecksum: hash,
      disposition: "known", agentCommandId: createEntityId(), ownerCommandId: createEntityId(), contextAuthority: "current" };
    expect(AgentNativeV3ItemReceiptSchema.safeParse(item).success).toBe(true);
    expect(AgentNativeV3ItemReceiptSchema.safeParse({ ...item, ownerCommandId: null }).success).toBe(false);
    const parent = { version: 1, ownerScope: hash, requestId, requestChecksum: hash, runId: null, state: "unknown", createdAt: time };
    const child = { version: 1, ownerScope: hash, runId: id, itemId: id, proposalChecksum: hash, state: "unknown", createdAt: time };
    expect(Object.keys(AgentNativeV3IntentSchema.parse(parent))).toHaveLength(7);
    expect(Object.keys(AgentNativeV3PreparationIntentSchema.parse(child))).toHaveLength(7);
    expect(AgentNativeV3IntentSchema.safeParse({ ...parent, goal: "private text" }).success).toBe(false);
    expect(AgentNativeV3PreparationIntentSchema.safeParse({ ...child, original: {} }).success).toBe(false);
  });
});
