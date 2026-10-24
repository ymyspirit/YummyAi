import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createEntityId } from "../common/ids.js";
import { AGENT_PLAN_VERSION, CreateAgentPlanSchema } from "./agent-plan.js";
import { AGENT_TOOLS_VERSION } from "./agent-tools.js";
import { AGENT_NATIVE_VERSION, AgentNativeBindingSchema, AgentNativeDecisionSchema, AgentNativeClaimSchema, AgentNativeObservationSchema,
  AgentNativeReceiptSchema, AgentNativeItemReceiptSchema, AgentNativeIntentSchema, AgentNativePreparationIntentSchema,
  CreateAgentNativeSchema, canonicalAgentNativeRequest, defaultAgentNativeLimits, StopAgentNativeSchema } from "./agent-native.js";

const hash = "a".repeat(64), time = "2026-10-22T00:00:00.000Z", id = createEntityId();
const pin = { contractVersion: "native-harness-v1", executorKey: "erp.agent.native", skill: { key: "erp.agent.native", version: AGENT_NATIVE_VERSION, checksum: hash },
  tools: [{ key: "agent.native.decide", version: AGENT_NATIVE_VERSION, checksum: hash }], checksum: hash };
const bindings = [{ tool: "orders.exceptions.page", scope: { status: "all" } }, { tool: "inventory.balances.page", scope: { stockItemId: id } },
  { tool: "knowledge.search", scope: { topic: "all", platform: "all", market: "ALL", spuIds: [] } },
  { tool: "creative.history", scope: { scope: "inspection", ownerId: id } }, { tool: "factory.capacity", scope: { factoryId: id, query: { from: "2026-10-22", days: 2 } } }];
const request = () => ({ version: AGENT_NATIVE_VERSION, requestId: randomUUID(), goal: "Read actual native evidence", contextText: "Operator statements remain unverified",
  modelId: id, bindings, allowedCommands: [{ domain: "procurement", kind: "requisition_create" }], limits: defaultAgentNativeLimits(), maxCostUsd: 1, executionContract: pin });

describe("independent native planner fixed scopes and on-demand definitions", () => {
  it("pins all five original read scopes while leaving only the knowledge keyword to a model and preserving old plan admission", () => {
    const value = CreateAgentNativeSchema.parse(request()); expect(value.bindings.map(binding => binding.tool)).toEqual(bindings.map(binding => binding.tool));
    expect(AGENT_PLAN_VERSION).toBe("erp-agent-plan-v1"); expect(CreateAgentPlanSchema.safeParse(value).success).toBe(false);
    for (const binding of bindings) expect(AgentNativeBindingSchema.safeParse(binding).success).toBe(true);
    for (const scope of [{ ...bindings[1]!.scope, pageSize: 100 }, { ...bindings[1]!.scope, cursor: "caller-cursor" }])
      expect(AgentNativeBindingSchema.safeParse({ tool: "inventory.balances.page", scope }).success).toBe(false);
    expect(AgentNativeBindingSchema.safeParse({ tool: "knowledge.search", scope: { ...bindings[2]!.scope, query: "Model cannot repin a fixed search scope" } }).success).toBe(false);
    for (const invalid of [{ ...value, bindings: [...value.bindings, value.bindings[0]] }, { ...value, tenantId: createEntityId() },
      { ...value, bindings: [{ tool: "creative.generate", scope: {} }] }, { ...value, version: AGENT_PLAN_VERSION }]) expect(CreateAgentNativeSchema.safeParse(invalid).success).toBe(false);
  });

  it("accepts exactly definition read or finish and keeps full37 native argument schemas out of the paid decision envelope", () => {
    const define = { action: "definition", label: "Read one exact original schema", definition: { kind: "command", command: { domain: "finance", kind: "bill_record" } }, read: null, result: null };
    expect(AgentNativeDecisionSchema.safeParse(define).success).toBe(true);
    expect(AgentNativeDecisionSchema.safeParse({ action: "read", label: "Read a fixed binding", definition: null, read: { bindingIndex: 0, keyword: null }, result: null }).success).toBe(true);
    for (const invalid of [{ ...define, action: "execute" }, { ...define, read: { bindingIndex: 0, keyword: null } },
      { ...define, definition: { ...define.definition, ownerId: id } }, { action: "read", label: "Attempt cursor control", definition: null, read: { bindingIndex: 0, keyword: null, cursor: "invented" }, result: null }])
      expect(AgentNativeDecisionSchema.safeParse(invalid).success).toBe(false);
    const wire = JSON.stringify(z.toJSONSchema(AgentNativeDecisionSchema, { io: "input" }));
    expect(wire).toContain("draftJson"); for (const nativeArgument of ["unitCostMinor", "procurementInvoiceId", "expectedPurchaseOrderVersionId"])
      expect(wire.includes(nativeArgument)).toBe(false);
  });

  it("bounds native turns rows prompt and precision and hashes strict parsed requests without silently altering old saved bodies", () => {
    const raw = request(), value = CreateAgentNativeSchema.parse({ ...raw, limits: { ...raw.limits, maxModelTurns: 16, maxRows: 10000, maxToolCalls: 32 } });
    expect(CreateAgentNativeSchema.safeParse({ ...value, limits: { ...value.limits, maxModelTurns: 17 } }).success).toBe(false);
    expect(CreateAgentNativeSchema.safeParse({ ...value, limits: { ...value.limits, maxRows: 10001 } }).success).toBe(false);
    expect(CreateAgentNativeSchema.safeParse({ ...value, maxCostUsd: 0.0000001 }).success).toBe(false);
    const reversed = Object.fromEntries(Object.entries(raw).reverse()); expect(canonicalAgentNativeRequest(reversed)).toBe(canonicalAgentNativeRequest(raw));
    expect(StopAgentNativeSchema.parse({ version: AGENT_NATIVE_VERSION, requestId: raw.requestId })).toEqual({ version: AGENT_NATIVE_VERSION, requestId: raw.requestId });
    expect(StopAgentNativeSchema.safeParse({ version: AGENT_NATIVE_VERSION, requestId: raw.requestId, revision: 1 }).success).toBe(false);
  });

  it("preserves typed scalar paths and honest bounded-native observations instead of inventing whole-corpus collection completion", () => {
    const claim = { stepId: id, resultIndex: 0, dataChecksum: hash, path: ["calendar", 0, "capacityUnits"], value: null };
    expect(AgentNativeClaimSchema.parse(claim).value).toBeNull(); expect(AgentNativeClaimSchema.safeParse({ ...claim, path: ["__proto__", "polluted"] }).success).toBe(false);
    expect(AgentNativeClaimSchema.safeParse({ ...claim, path: ["references", -1] }).success).toBe(false);
    const result = { version: AGENT_TOOLS_VERSION, callId: id, contextAuthority: "synthetic-current", definitionChecksum: hash, checkedAt: time, inputChecksum: hash, dataChecksum: hash,
      tool: "knowledge.search", data: { references: [], diagnostics: [], retrievedAt: time, mode: "keyword", scanned: 9 }, coverage: { kind: "ranked_subset", complete: false, scanned: 9, returned: 0 } };
    const observation = { stepId: id, tool: "knowledge.search", request: { bindingIndex: 2, keyword: "Synthetic native evidence" }, results: [result], basisChecksum: hash,
      observedRows: 0, collectionComplete: null, truncatedBy: null };
    expect(AgentNativeObservationSchema.safeParse(observation).success).toBe(true);
    for (const invalid of [{ ...observation, collectionComplete: true }, { ...observation, collectionComplete: false }, { ...observation, truncatedBy: "row_limit" },
      { ...observation, results: [result, result] }, { ...observation, tool: "factory.capacity" }]) expect(AgentNativeObservationSchema.safeParse(invalid).success).toBe(false);
  });

  it("keeps parent and child recovery metadata-only and refuses to call a born coordinator a completed native preparation", () => {
    const requestId = randomUUID(), receipt = { version: AGENT_NATIVE_VERSION, requestId, requestChecksum: hash, disposition: "not_found", runId: null,
      status: null, contextAuthority: "synthetic-current", privateAvailable: false };
    expect(AgentNativeReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(AgentNativeReceiptSchema.safeParse({ ...receipt, runId: id }).success).toBe(false);
    const known = { version: AGENT_NATIVE_VERSION, runId: id, itemId: createEntityId(), proposalChecksum: hash, preparationRequestChecksum: hash,
      disposition: "known", agentCommandId: createEntityId(), ownerCommandId: createEntityId(), contextAuthority: "synthetic-current" };
    expect(AgentNativeItemReceiptSchema.safeParse(known).success).toBe(true);
    expect(AgentNativeItemReceiptSchema.safeParse({ ...known, ownerCommandId: null }).success).toBe(false);
    const parent = { version: 1, ownerScope: hash, requestId, requestChecksum: hash, runId: null, state: "unknown", createdAt: time };
    expect(Object.keys(AgentNativeIntentSchema.parse(parent))).toHaveLength(7);
    expect(AgentNativeIntentSchema.safeParse({ ...parent, goal: "Private original goal" }).success).toBe(false);
    const child = { version: 1, ownerScope: hash, runId: id, itemId: known.itemId, proposalChecksum: hash, state: "unknown", createdAt: time };
    expect(Object.keys(AgentNativePreparationIntentSchema.parse(child))).toHaveLength(7);
    expect(AgentNativePreparationIntentSchema.safeParse({ ...child, draftJson: "Private native input" }).success).toBe(false);
  });
});
