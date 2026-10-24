import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { AGENT_LOOP_VERSION, AgentLoopCollectionSchema, AgentLoopDecisionSchema, AgentLoopIntentSchema,
  AgentLoopReceiptSchema, CreateAgentLoopSchema, defaultAgentLoopLimits, maximumAgentLoopLimits } from "./agent-loop.js";

const hash = "a".repeat(64), time = "2026-10-22T00:00:00.000Z";
const contract = { contractVersion: "native-harness-v1", executorKey: "erp.agent.loop",
  skill: { key: "erp.agent.loop", version: AGENT_LOOP_VERSION, checksum: hash },
  tools: [{ key: "erp.agent.loop", version: AGENT_LOOP_VERSION, checksum: hash }], checksum: hash };
const request = () => ({ version: AGENT_LOOP_VERSION, requestId: randomUUID(), modelId: createEntityId(), goal: "  Synthetic bounded inventory read  ",
  allowedTools: ["inventory.balances.page" as const], maxCostUsd: 0.1, limits: defaultAgentLoopLimits(), executionContract: contract });

describe("Bounded single-task Agent loop contract", () => {
  it("pins an explicit paid cap, selected read tools and all bounds without accepting caller authority or a dynamic executor", () => {
    const raw = request(), parsed = CreateAgentLoopSchema.parse(raw);
    expect(parsed.goal).toBe("Synthetic bounded inventory read"); expect(parsed.limits).toEqual(defaultAgentLoopLimits());
    expect(CreateAgentLoopSchema.parse({ ...raw, limits: maximumAgentLoopLimits() }).limits.maxModelTurns).toBe(8);
    for (const value of [{ ...raw, allowedTools: [] }, { ...raw, allowedTools: ["inventory.balances.page", "inventory.balances.page"] },
      { ...raw, allowedTools: ["inventory.recordMovement"] }, { ...raw, maxCostUsd: 0 }, { ...raw, maxCostUsd: 0.0000001 },
      { ...raw, tenantId: createEntityId() }, { ...raw, originCeiling: { dataScope: "tenant" } }])
      expect(CreateAgentLoopSchema.safeParse(value).success).toBe(false);
    for (const limits of [{ ...raw.limits, maxModelTurns: 9 }, { ...raw.limits, maxModelTurns: 1 }, { ...raw.limits, maxToolCalls: 33 },
      { ...raw.limits, maxRows: 1001 }, { ...raw.limits, deadlineSeconds: 601 }, { ...raw.limits, maxPromptBytes: 1_048_577 }])
      expect(CreateAgentLoopSchema.safeParse({ ...raw, limits }).success).toBe(false);
  });

  it("accepts only a typed read or final result and rejects mixed actions, extra queries and textual execution commands", () => {
    const read = { action: "read", label: "Read original inventory", read: { tool: "inventory.balances.page", query: { stockItemId: null, locationId: null } }, result: null };
    const result = { summary: "Synthetic bounded result", claims: [], missingInformation: [] };
    expect(AgentLoopDecisionSchema.parse(read)).toEqual(read);
    expect(AgentLoopDecisionSchema.parse({ action: "finish", label: "Finish", read: null, result }).result).toEqual(result);
    for (const value of [{ ...read, result }, { ...read, read: null }, { ...read, action: "execute" },
      { ...read, read: { tool: "orders.cancel", query: {} } },
      { ...read, read: { tool: "inventory.balances.page", query: { stockItemId: null, locationId: null, cursor: "model-supplied-cursor" } } },
      { action: "finish", label: "Unsupported reference", read: null, result: { ...result, claims: [{ stepId: createEntityId(), sourceId: createEntityId(), sourceChecksum: hash, field: "customerName", value: "private" }] } }])
      expect(AgentLoopDecisionSchema.safeParse(value).success).toBe(false);
  });

  it("keeps exact owner quantities and proves honest bounded collection shape instead of deduplicating or calling a prefix complete", () => {
    const id = createEntityId(), data = { id, dimensionKey: "synthetic exact dimension", stockItemId: createEntityId(), locationId: createEntityId(), lotId: null,
      unit: "meter", physicalQuantity: "9007199254740993.000000001", reservedQuantity: "0.000000001", availableQuantity: "9007199254740993",
      inTransitQuantity: 0, providerQuantity: 0, virtualQuantity: 0, projectionVersion: 1, updatedAt: time };
    const row = { sourceId: id, sourceChecksum: hash, data }, collection = { stepId: createEntityId(), tool: "inventory.balances.page",
      query: { stockItemId: null, locationId: null }, queryChecksum: hash, collectionFingerprint: hash, checkedAt: time,
      total: 2, readCount: 1, complete: false, limitReason: "row_limit", rows: [row] };
    expect(AgentLoopCollectionSchema.parse(collection).rows[0]!.data).toEqual(data);
    expect(AgentLoopCollectionSchema.parse({ ...collection, total: 1, complete: true, limitReason: null }).complete).toBe(true);
    for (const value of [{ ...collection, complete: true }, { ...collection, limitReason: null }, { ...collection, readCount: 2 },
      { ...collection, total: 3, readCount: 2, rows: [row, row] },
      { ...collection, rows: [{ ...row, sourceId: createEntityId() }] },
      { ...collection, rows: [{ ...row, data: { ...data, physicalQuantity: "0.0000000001" } }] }])
      expect(AgentLoopCollectionSchema.safeParse(value).success).toBe(false);
  });

  it("keeps recovery metadata to seven scalar fields and never lets not-found imply a new paid request or contain private data", () => {
    const intent = { version: 1, ownerScope: hash, requestId: randomUUID(), requestChecksum: hash, runId: null, state: "unknown", createdAt: time };
    const saved = AgentLoopIntentSchema.parse(intent); expect(Object.keys(saved)).toHaveLength(7); expect(saved).toEqual(intent);
    for (const extra of [{ goal: "private" }, { prompt: "private" }, { cursor: "private" }, { bearerToken: "private" }])
      expect(AgentLoopIntentSchema.safeParse({ ...intent, ...extra }).success).toBe(false);
    const receipt = { version: AGENT_LOOP_VERSION, requestId: intent.requestId, requestChecksum: hash, disposition: "not_found", runId: null,
      status: null, contextAuthority: "synthetic authority", privateAvailable: false };
    expect(AgentLoopReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(AgentLoopReceiptSchema.safeParse({ ...receipt, runId: createEntityId() }).success).toBe(false);
    expect(AgentLoopReceiptSchema.safeParse({ ...receipt, privateAvailable: true }).success).toBe(false);
    expect(AgentLoopReceiptSchema.safeParse({ ...receipt, disposition: "known" }).success).toBe(false);
  });
});
