import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { canonicalJson } from "../common/canonical-json.js";
import { CreateAgentNativeSchema, AgentNativeBindingSchema, defaultAgentNativeLimits } from "./agent-native.js";
import { AgentResourceResultSchema } from "./agent-resources.js";
import {
  AGENT_NATIVE_V2_VERSION, AGENT_NATIVE_V2_MAX_STEPS, AgentNativeV2BindingSchema, AgentNativeV2ReadKeySchema,
  CreateAgentNativeV2Schema, AgentNativeV2DecisionSchema, AgentNativeV2ObservationSchema, AgentNativeV2ReceiptSchema,
  AgentNativeV2ItemReceiptSchema, AgentNativeV2IntentSchema, AgentNativeV2PreparationIntentSchema,
  defaultAgentNativeV2Limits, maximumAgentNativeV2Limits, canonicalAgentNativeV2Request,
  agentNativeV2ClaimValue, agentNativeV2SourceBasis, agentNativeV2ObservationBasisPayload, agentNativeV2ProposalChecksumPayload,
  type AgentNativeV2Observation,
} from "./agent-native-v2.js";

const id = createEntityId(), hash = "a".repeat(64), time = "2026-10-22T00:00:00.000Z";
const pin = { contractVersion: "native-harness-v1", executorKey: "erp.agent.native.v2",
  skill: { key: "erp.agent.native.v2", version: AGENT_NATIVE_V2_VERSION, checksum: hash },
  tools: [{ key: "agent.native.v2.decide", version: AGENT_NATIVE_V2_VERSION, checksum: hash }], checksum: hash };
const bindings = [
  { tool: "orders.exceptions.page", scope: { status: "all" } }, { tool: "inventory.balances.page", scope: { stockItemId: id } },
  { tool: "knowledge.search", scope: { topic: "all", platform: "all", market: "ALL", spuIds: [] } },
  { tool: "creative.history", scope: { scope: "inspection", ownerId: id } }, { tool: "factory.capacity", scope: { factoryId: id, query: { from: "2026-10-22", days: 2 } } },
  { tool: "research.evidence", scope: { researchItemId: id, snapshotId: createEntityId(), studyRevisionId: null } },
  { tool: "catalog.sku", scope: { skuId: id, recipeId: null } }, { tool: "listing.version", scope: { listingId: id, versionId: createEntityId() } },
  { tool: "orders.order", scope: { orderId: id, expectedSequence: 1 } }, { tool: "finance.profit_run", scope: { runId: id } },
  { tool: "advertising.analysis", scope: { accountId: id, analysisId: createEntityId() } },
];
const request = () => ({ version: AGENT_NATIVE_V2_VERSION, requestId: randomUUID(), goal: "Read eleven independently authorized original sources",
  contextText: "An operator statement is unverified data", modelId: id, bindings, allowedCommands: [],
  limits: defaultAgentNativeV2Limits(), maxCostUsd: 1, executionContract: pin });
function researchObservation(): AgentNativeV2Observation {
  const result = AgentResourceResultSchema.parse({ version: "erp-agent-resources-v1", tool: "research.evidence", callId: id,
    checkedAt: time, contextAuthority: "synthetic-authority", definitionChecksum: hash, inputChecksum: hash, dataChecksum: hash,
    input: { researchItemId: id, snapshotId: id, studyRevisionId: null }, sources: [{ owner: "research", kind: "capture_snapshot", id, versionId: id, revision: null }],
    coverage: { kind: "single_object_projection", complete: false, limitation: "One original snapshot only" },
    data: { source: { domain: "research", researchItemId: id, snapshotId: id, studyRevisionId: null, studyVersion: 0,
      title: "Original synthetic source", sourceUrl: "https://www.etsy.com/listing/123456789/synthetic", platform: "etsy", capturedAt: time, mediaCount: 0, content: null },
    snapshot: { platform: "etsy", parserVersion: "etsy@1", extensionVersion: "0.0.0", marketplace: "www.etsy.com",
      sourceUrl: "https://www.etsy.com/listing/123456789/synthetic", externalId: "123456789", title: "Original synthetic source", domain: "research",
      price: { raw: "$20.00", amount: 20, currency: "USD" }, rating: null, reviewCount: null, taxonomy: [], listingPublishedAt: null,
      favoriteCount: null, bullets: [], missingFields: [], diagnostics: [], captureStatus: "complete", capturedAt: time } } });
  return AgentNativeV2ObservationSchema.parse({ stepId: id, tool: result.tool, request: { bindingIndex: 5, keyword: null }, results: [result],
    basisChecksum: hash, observedRows: 1, collectionComplete: null, truncatedBy: null });
}

describe("independent native v2 full-reader bounded contract", () => {
  it("admits all eleven fixed original bindings while v1 remains five readers with its original bounds", () => {
    const value = CreateAgentNativeV2Schema.parse(request());
    expect(value.bindings.map(row => row.tool)).toEqual(AgentNativeV2ReadKeySchema.options);
    for (const binding of bindings) expect(AgentNativeV2BindingSchema.safeParse(binding).success).toBe(true);
    expect(AgentNativeBindingSchema.safeParse(bindings[5]).success).toBe(false);
    expect(CreateAgentNativeSchema.safeParse({ ...value, version: "erp-agent-native-v1" }).success).toBe(false);
    expect(defaultAgentNativeLimits()).toMatchObject({ maxModelTurns: 12, maxToolCalls: 32 });
    for (const invalid of [{ ...value, bindings: [...value.bindings, value.bindings[0]] }, { ...value, tenantId: id },
      { ...value, bindings: [{ tool: "finance.payment", scope: {} }] }, { ...value, version: "erp-agent-native-v1" }])
      expect(CreateAgentNativeV2Schema.safeParse(invalid).success).toBe(false);
  });

  it("bounds a genuine eleven-reader run without silently widening old protocols or accepting client-controlled pagination", () => {
    const limits = maximumAgentNativeV2Limits(); expect(limits).toMatchObject({ maxModelTurns: 48, maxToolCalls: 192, maxRows: 10000, deadlineSeconds: 1800 });
    expect(AGENT_NATIVE_V2_MAX_STEPS).toBe(96); expect(defaultAgentNativeV2Limits()).toMatchObject({ maxModelTurns: 32, maxToolCalls: 128, maxRows: 5000 });
    const value = CreateAgentNativeV2Schema.parse(request());
    for (const limit of [{ ...limits, maxModelTurns: 49 }, { ...limits, maxToolCalls: 193 }, { ...limits, maxRows: 10001 }, { ...limits, deadlineSeconds: 1801 }])
      expect(CreateAgentNativeV2Schema.safeParse({ ...value, limits: limit }).success).toBe(false);
    expect(CreateAgentNativeV2Schema.safeParse({ ...value, maxCostUsd: 0.0000001 }).success).toBe(false);
    for (const scope of [{ stockItemId: id, cursor: "invented" }, { stockItemId: id, pageSize: 500 }])
      expect(AgentNativeV2BindingSchema.safeParse({ tool: "inventory.balances.page", scope }).success).toBe(false);
    expect(canonicalAgentNativeV2Request(Object.fromEntries(Object.entries(value).reverse()))).toBe(canonicalAgentNativeV2Request(value));
  });

  it("requires exactly one model decision and preserves bounded object coverage instead of claiming a complete corpus", () => {
    const definition = { action: "definition", label: "Discover one fixed source", definition: { kind: "read", tool: "finance.profit_run" }, read: null, result: null };
    expect(AgentNativeV2DecisionSchema.safeParse(definition).success).toBe(true);
    for (const invalid of [{ ...definition, action: "prepare" }, { ...definition, action: "execute" }, { ...definition, read: { bindingIndex: 9, keyword: null } },
      { action: "read", label: "Override source", definition: null, read: { bindingIndex: 9, keyword: null, runId: id }, result: null }])
      expect(AgentNativeV2DecisionSchema.safeParse(invalid).success).toBe(false);
    const observation = researchObservation();
    expect(observation.results[0]!.coverage.complete).toBe(false);
    for (const invalid of [{ ...observation, collectionComplete: true }, { ...observation, truncatedBy: "row_limit" }, { ...observation, results: [...observation.results, ...observation.results] }])
      expect(AgentNativeV2ObservationSchema.safeParse(invalid).success).toBe(false);
  });

  it("binds claims to the actual original scalar source and retains currency nulls and stable source data", () => {
    const observation = researchObservation(), claim = { stepId: id, resultIndex: 0, dataChecksum: hash, path: ["snapshot", "price", "amount"], value: 999 };
    expect(agentNativeV2ClaimValue(observation, claim)).toBe(20);
    expect(agentNativeV2ClaimValue(observation, { ...claim, path: ["snapshot", "price", "currency"], value: "EUR" })).toBe("USD");
    expect(agentNativeV2ClaimValue(observation, { ...claim, path: ["source", "content"], value: null })).toBeNull();
    for (const invalid of [{ ...claim, dataChecksum: "b".repeat(64) }, { ...claim, stepId: createEntityId() },
      { ...claim, path: ["__proto__"] }, { ...claim, path: ["contextAuthority"] }, { ...claim, path: ["snapshot", "price"] }])
      expect(() => agentNativeV2ClaimValue(observation, invalid)).toThrow();
    const original = observation.results[0]!, later = { ...original, callId: createEntityId(), checkedAt: "2026-10-23T00:00:00.000Z", contextAuthority: "another-envelope" };
    expect(agentNativeV2SourceBasis(later)).toEqual(agentNativeV2SourceBasis(original));
    expect(canonicalJson(agentNativeV2ObservationBasisPayload(observation))).toContain('"currency":"USD"');
    // Claim equality proves source scalars only, never business causality or the draft's semantic correctness.
    const proposal = { draft: { synthetic: "unconfirmed" }, claimIndexes: [0] } as unknown as Parameters<typeof agentNativeV2ProposalChecksumPayload>[0];
    expect(canonicalJson(agentNativeV2ProposalChecksumPayload(proposal, [claim]))).not.toBe(canonicalJson(agentNativeV2ProposalChecksumPayload(proposal, [{ ...claim, value: 20 }])));
  });

  it("keeps parent child and pure-ID recovery strict and never labels a born coordinator as a known original command", () => {
    const requestId = randomUUID(), unknown = { version: AGENT_NATIVE_V2_VERSION, requestId, requestChecksum: hash, disposition: "not_found", runId: null,
      status: null, contextAuthority: "current-member", privateAvailable: false };
    expect(AgentNativeV2ReceiptSchema.safeParse(unknown).success).toBe(true);
    expect(AgentNativeV2ReceiptSchema.safeParse({ ...unknown, runId: id }).success).toBe(false);
    const item = { version: AGENT_NATIVE_V2_VERSION, runId: id, itemId: id, proposalChecksum: hash, preparationRequestChecksum: hash,
      disposition: "known", agentCommandId: createEntityId(), ownerCommandId: createEntityId(), contextAuthority: "current-member" };
    expect(AgentNativeV2ItemReceiptSchema.safeParse(item).success).toBe(true);
    expect(AgentNativeV2ItemReceiptSchema.safeParse({ ...item, ownerCommandId: null }).success).toBe(false);
    const parent = { version: 1, ownerScope: hash, requestId, requestChecksum: hash, runId: null, state: "unknown", createdAt: time };
    expect(Object.keys(AgentNativeV2IntentSchema.parse(parent))).toHaveLength(7);
    expect(AgentNativeV2IntentSchema.safeParse({ ...parent, goal: "private" }).success).toBe(false);
    const child = { version: 1, ownerScope: hash, runId: id, itemId: id, proposalChecksum: hash, state: "unknown", createdAt: time };
    expect(Object.keys(AgentNativeV2PreparationIntentSchema.parse(child))).toHaveLength(7);
    expect(AgentNativeV2PreparationIntentSchema.safeParse({ ...child, draftJson: "private" }).success).toBe(false);
  });
});
