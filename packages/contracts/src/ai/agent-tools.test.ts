import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createEntityId } from "@yummyai/contracts";
import { AGENT_READ_VERSION, AgentReadToolKeySchema } from "./agent-read.js";
import { AGENT_LOOP_VERSION } from "./agent-loop.js";
import { AGENT_PLAN_VERSION } from "./agent-plan.js";
import { AGENT_TOOLS_VERSION, AgentToolCallSchema, AgentToolDefinitionRequestSchema, AgentToolKeySchema,
  AgentToolResultSchema, agentToolCommandInput } from "./agent-tools.js";

const hash = "a".repeat(64), time = "2026-10-22T00:00:00.000Z";
const contract = { contractVersion: "native-harness-v1", executorKey: "erp.agent.tools",
  skill: { key: "erp.agent.tools", version: AGENT_TOOLS_VERSION, checksum: hash },
  tools: [{ key: "knowledge.search", version: AGENT_TOOLS_VERSION, checksum: hash }], checksum: hash };
const search = { query: "Synthetic approved reference", topic: "all", platform: "all", market: "ALL", spuIds: [] };
const result = { version: AGENT_TOOLS_VERSION, callId: createEntityId(), contextAuthority: "synthetic-current-authority",
  definitionChecksum: hash, checkedAt: time, dataChecksum: hash, inputChecksum: hash };

describe("independent native Agent tools and selected original definitions", () => {
  it("keeps the five native readers independent from unchanged old read loop and plan versions", () => {
    expect(AgentToolKeySchema.options).toEqual(["orders.exceptions.page", "inventory.balances.page", "knowledge.search", "creative.history", "factory.capacity"]);
    expect(AgentReadToolKeySchema.options).toEqual(["orders.exceptions.page", "inventory.balances.page"]);
    expect([AGENT_READ_VERSION, AGENT_LOOP_VERSION, AGENT_PLAN_VERSION]).toEqual(["erp-agent-read-v1", "erp-agent-loop-v1", "erp-agent-plan-v1"]);
    const call = { version: AGENT_TOOLS_VERSION, executionContract: contract, definitionChecksum: hash, tool: "knowledge.search", input: search };
    expect(AgentToolCallSchema.parse(call).tool).toBe("knowledge.search");
    for (const invalid of [{ ...call, version: AGENT_READ_VERSION }, { ...call, tool: "knowledge.answer" },
      { ...call, tenantId: createEntityId() }, { ...call, input: { ...search, url: "https://synthetic.invalid" } },
      { ...call, action: "execute" }]) expect(AgentToolCallSchema.safeParse(invalid).success).toBe(false);
  });

  it("loads one real native command branch with its original quantity rules rather than the complete37 union", () => {
    const selected = agentToolCommandInput({ domain: "procurement", kind: "requisition_create" });
    const input = { domain: "procurement", command: { kind: "requisition_create", targetId: null, input: {
      code: "SYNTHETIC-TOOL", reasonCode: "SYNTHETIC", idempotencyKey: createEntityId(),
      lines: [{ lineKey: "L1", stockItemId: createEntityId(), destinationLocationId: createEntityId(), quantity: "2.5", unit: "gram" }] } } };
    expect(selected.parse(input)).toEqual(input);
    const wire = JSON.stringify(z.toJSONSchema(selected, { io: "input" }));
    expect(wire).toContain("requisition_create");
    for (const unselected of ["payment_record", "purchase_review", "reviewed_order", "observation_record"]) expect(wire.includes(unselected)).toBe(false);
    expect(selected.safeParse({ ...input, command: { ...input.command, kind: "purchase_create" } }).success).toBe(false);
    expect(selected.safeParse({ ...input, command: { ...input.command, input: { ...input.command.input,
      lines: [{ ...input.command.input.lines[0], unit: "each" }] } } }).success).toBe(false);
    expect(selected.safeParse({ ...input, command: { ...input.command, input: { ...input.command.input, bypassReview: true } } }).success).toBe(false);
  });

  it("binds native collection and ranked-subset coverage to the actual owner data instead of accepting a fabricated complete total", () => {
    const data = { version: AGENT_READ_VERSION, effect: "read", contextAuthority: "synthetic-current-authority", checkedAt: time,
      collectionFingerprint: hash, total: 0, readCount: 0, consistency: "unchanged_collection", complete: true, nextCursor: null,
      tool: "inventory.balances.page", query: { pageSize: 25, cursor: null }, items: [] };
    const value = { ...result, tool: "inventory.balances.page", data,
      coverage: { kind: "paged_collection", complete: true, total: 0, readCount: 0, nextCursor: null } };
    expect(AgentToolResultSchema.safeParse(value).success).toBe(true);
    expect(AgentToolResultSchema.safeParse({ ...value, coverage: { ...value.coverage, total: 1, readCount: 1 } }).success).toBe(false);
    const ranked = { ...result, tool: "knowledge.search", data: { references: [], diagnostics: [], retrievedAt: time, mode: "keyword", scanned: 9 },
      coverage: { kind: "ranked_subset", complete: false, scanned: 9, returned: 0 } };
    expect(AgentToolResultSchema.safeParse(ranked).success).toBe(true);
    for (const coverage of [{ ...ranked.coverage, complete: true }, { ...ranked.coverage, scanned: 10 }, { ...ranked.coverage, returned: 1 }])
      expect(AgentToolResultSchema.safeParse({ ...ranked, coverage }).success).toBe(false);
  });

  it("keeps definition discovery free of execution payloads and rejects caller-selected identities or bulk branch selection", () => {
    const input = { version: AGENT_TOOLS_VERSION, selection: { kind: "command", command: { domain: "finance", kind: "bill_record" } } };
    expect(AgentToolDefinitionRequestSchema.parse(input)).toEqual(input);
    for (const invalid of [{ ...input, selection: [input.selection] }, { ...input, original: {} }, { ...input, ownerId: createEntityId() },
      { ...input, selection: { kind: "command", command: { domain: "finance", kind: "bank_transfer" } } }])
      expect(AgentToolDefinitionRequestSchema.safeParse(invalid).success).toBe(false);
  });
});
