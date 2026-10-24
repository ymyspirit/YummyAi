import { createHash, randomUUID, webcrypto } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { AGENT_PLAN_VERSION, CreateAgentPlanSchema, defaultAgentPlanLimits } from "@yummyai/contracts/ai/agent-plan";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_PLAN_INTENT_PREFIX, AGENT_PLAN_PREPARATION_INTENT_PREFIX, agentPlanOwnerScope,
  prepareAgentPlanIntent, saveAgentPlanIntent, readAgentPlanIntents, updateAgentPlanIntent, forgetAgentPlanIntent,
  readAgentPlanPreparationIntents, saveAgentPlanPreparationIntent, updateAgentPlanPreparationIntent, forgetAgentPlanPreparationIntent } from "./agent-plan-intent";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); }, removeItem: key => { values.delete(key); }, clear: () => values.clear() };
}
const request = () => CreateAgentPlanSchema.parse({ version: AGENT_PLAN_VERSION, requestId: randomUUID(), modelId: createEntityId(),
  goal: "Synthetic private goal", contextText: "Synthetic unverified private operator statements", allowedReads: ["inventory.balances.page"],
  allowedCommands: [{ domain: "procurement", kind: "requisition_create" }], maxCostUsd: 0.1, limits: defaultAgentPlanLimits(),
  executionContract: { contractVersion: "native-harness-v1", executorKey: "erp.agent.plan",
    skill: { key: "erp.agent.plan", version: AGENT_PLAN_VERSION, checksum: "a".repeat(64) },
    tools: [{ key: "agent.plan.decide", version: AGENT_PLAN_VERSION, checksum: "b".repeat(64) }], checksum: "c".repeat(64) } });

describe("separate Agent plan and original preparation recovery storage", () => {
  beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("sessionStorage", memoryStorage()); vi.stubGlobal("window", new EventTarget()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("stores only canonical seven-scalar planning proof and blocks a second paid task even when its first ID is known", async () => {
    const input = request(), { intent } = await prepareAgentPlanIntent(input, "synthetic personal A"); saveAgentPlanIntent(intent);
    expect(intent.requestChecksum).toBe(createHash("sha256").update(canonicalJson(input)).digest("hex"));
    const stored = sessionStorage.getItem(sessionStorage.key(0)!)!;
    expect(Object.keys(JSON.parse(stored) as object).sort()).toEqual(["version", "ownerScope", "requestId", "requestChecksum", "runId", "state", "createdAt"].sort());
    expect(stored).not.toContain(input.goal); expect(stored).not.toContain(input.contextText);
    const known = updateAgentPlanIntent({ ...intent, state: "known", runId: createEntityId() });
    await expect(prepareAgentPlanIntent({ ...input, requestId: randomUUID() }, "synthetic personal A")).rejects.toMatchObject({ status: 409 });
    expect(readAgentPlanIntents(await agentPlanOwnerScope("synthetic personal B"))).toEqual([]);
    forgetAgentPlanIntent(known); expect(readAgentPlanIntents(intent.ownerScope)).toEqual([]);
  });

  it("preserves a separate original-item unknown marker across reload and rejects changed proof or repeated preparation rather than inventing a new native key", async () => {
    const ownerScope = await agentPlanOwnerScope("synthetic personal A"), intent = { version: 1 as const, ownerScope, runId: createEntityId(), itemId: createEntityId(),
      proposalChecksum: "a".repeat(64), state: "prepared" as const, createdAt: new Date().toISOString() };
    saveAgentPlanPreparationIntent(intent); const unknown = updateAgentPlanPreparationIntent({ ...intent, state: "unknown" });
    expect(readAgentPlanPreparationIntents(ownerScope)).toEqual([unknown]);
    expect(sessionStorage.key(0)?.startsWith(AGENT_PLAN_PREPARATION_INTENT_PREFIX)).toBe(true);
    expect(Object.keys(JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!) as object)).toHaveLength(7);
    expect(() => saveAgentPlanPreparationIntent(intent)).toThrow();
    expect(() => updateAgentPlanPreparationIntent({ ...unknown, proposalChecksum: "f".repeat(64) })).toThrow();
    const known = updateAgentPlanPreparationIntent({ ...unknown, state: "known" });
    expect(() => updateAgentPlanPreparationIntent(unknown)).toThrow(); forgetAgentPlanPreparationIntent(known);
    expect(readAgentPlanPreparationIntents(ownerScope)).toEqual([]);
  });

  it("cannot resurrect either planning or original-item markers after logout explicit clearing or another actor removes their exact original proof", async () => {
    const { intent } = await prepareAgentPlanIntent(request(), "synthetic personal A"); saveAgentPlanIntent(intent);
    const item = { version: 1 as const, ownerScope: intent.ownerScope, runId: createEntityId(), itemId: createEntityId(), proposalChecksum: "a".repeat(64), state: "prepared" as const, createdAt: intent.createdAt };
    saveAgentPlanPreparationIntent(item); sessionStorage.clear();
    expect(() => updateAgentPlanIntent({ ...intent, state: "known", runId: item.runId })).toThrow();
    expect(() => updateAgentPlanPreparationIntent({ ...item, state: "known" })).toThrow(); expect(sessionStorage.length).toBe(0);
  });

  it("discards private-bearing corrupt copies and fails before either POST if browser storage cannot retain the original marker", async () => {
    const { intent } = await prepareAgentPlanIntent(request(), "synthetic personal A"), key = AGENT_PLAN_INTENT_PREFIX + intent.ownerScope + ":" + intent.requestId;
    sessionStorage.setItem(key, JSON.stringify({ ...intent, contextText: "synthetic private" })); expect(readAgentPlanIntents(intent.ownerScope)).toEqual([]);
    const broken = memoryStorage(); broken.setItem = () => {}; vi.stubGlobal("sessionStorage", broken);
    expect(() => saveAgentPlanIntent(intent)).toThrow();
    expect(() => saveAgentPlanPreparationIntent({ version: 1, ownerScope: intent.ownerScope, runId: createEntityId(), itemId: createEntityId(), proposalChecksum: "a".repeat(64), state: "prepared", createdAt: intent.createdAt })).toThrow();
    const unreadable = memoryStorage(); unreadable.key = () => { throw new Error("synthetic storage failure"); }; unreadable.setItem("x", "y"); vi.stubGlobal("sessionStorage", unreadable);
    expect(() => readAgentPlanIntents(intent.ownerScope)).toThrow();
  });
});
