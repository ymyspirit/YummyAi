import { createHash, randomUUID, webcrypto } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { AGENT_LOOP_VERSION, CreateAgentLoopSchema, defaultAgentLoopLimits } from "@yummyai/contracts/ai/agent-loop";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_LOOP_INTENT_PREFIX, prepareAgentLoopIntent, saveAgentLoopIntent, readAgentLoopIntents,
  updateAgentLoopIntent, forgetAgentLoopIntent, agentLoopOwnerScope } from "./agent-loop-intent";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); }, clear: () => values.clear() };
}
const request = () => CreateAgentLoopSchema.parse({ version: AGENT_LOOP_VERSION, requestId: randomUUID(), modelId: createEntityId(),
  goal: "Synthetic private goal must never enter session storage", allowedTools: ["inventory.balances.page"], maxCostUsd: 0.1,
  limits: defaultAgentLoopLimits(), executionContract: { contractVersion: "native-harness-v1", executorKey: "erp.agent.loop",
    skill: { key: "erp.agent.loop", version: AGENT_LOOP_VERSION, checksum: "a".repeat(64) },
    tools: [{ key: "agent.loop.decide", version: AGENT_LOOP_VERSION, checksum: "b".repeat(64) }], checksum: "c".repeat(64) } });

describe("Agent loop original paid-intent storage", () => {
  beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("sessionStorage", memoryStorage()); vi.stubGlobal("window", new EventTarget()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("stores only seven scalar fields, freezes the shared canonical proof and blocks a second task even after its original ID becomes known", async () => {
    const input = request(), prepared = await prepareAgentLoopIntent(input, "synthetic personal A");
    expect(prepared.intent.requestChecksum).toBe(createHash("sha256").update(canonicalJson(input)).digest("hex"));
    saveAgentLoopIntent(prepared.intent);
    const key = sessionStorage.key(0)!;
    expect(Object.keys(JSON.parse(sessionStorage.getItem(key)!) as object).sort()).toEqual([
      "version", "ownerScope", "requestId", "requestChecksum", "runId", "state", "createdAt"].sort());
    expect(sessionStorage.getItem(key)).not.toContain(input.goal);
    expect(readAgentLoopIntents(prepared.intent.ownerScope)).toEqual([prepared.intent]);
    const known = updateAgentLoopIntent({ ...prepared.intent, state: "known", runId: createEntityId() });
    await expect(prepareAgentLoopIntent({ ...input, requestId: randomUUID() }, "synthetic personal A")).rejects.toMatchObject({ status: 409 });
    expect(readAgentLoopIntents(await agentLoopOwnerScope("synthetic personal B"))).toEqual([]);
    forgetAgentLoopIntent(known); expect(readAgentLoopIntents(known.ownerScope)).toEqual([]);
  });

  it("rejects altered or missing original markers and cannot resurrect a paid response after explicit clearing or actor logout", async () => {
    const { intent } = await prepareAgentLoopIntent(request(), "synthetic personal A"); saveAgentLoopIntent(intent);
    expect(() => updateAgentLoopIntent({ ...intent, requestChecksum: "f".repeat(64), state: "known", runId: createEntityId() })).toThrow();
    const known = updateAgentLoopIntent({ ...intent, state: "known", runId: createEntityId() });
    expect(() => updateAgentLoopIntent({ ...known, state: "unknown" })).toThrow();
    forgetAgentLoopIntent(known);
    expect(() => updateAgentLoopIntent(known)).toThrow(); expect(sessionStorage.length).toBe(0);
    saveAgentLoopIntent(intent); sessionStorage.clear();
    expect(() => updateAgentLoopIntent(known)).toThrow(); expect(sessionStorage.length).toBe(0);
  });

  it("discards private-bearing corrupt copies and fails closed before a paid request when storage cannot retain or read back its marker", async () => {
    const { intent } = await prepareAgentLoopIntent(request(), "synthetic personal A"), key = AGENT_LOOP_INTENT_PREFIX + intent.ownerScope + ":" + intent.requestId;
    sessionStorage.setItem(key, JSON.stringify({ ...intent, goal: "synthetic private body" }));
    expect(readAgentLoopIntents(intent.ownerScope)).toEqual([]); expect(sessionStorage.getItem(key)).toBeNull();
    sessionStorage.setItem(key, "{corrupt"); expect(readAgentLoopIntents(intent.ownerScope)).toEqual([]);
    const failing = memoryStorage(); failing.setItem = () => { throw new Error("synthetic storage quota"); };
    vi.stubGlobal("sessionStorage", failing); expect(() => saveAgentLoopIntent(intent)).toThrow("本次不发送");
    const lost = memoryStorage(); lost.setItem = () => {}; vi.stubGlobal("sessionStorage", lost);
    expect(() => saveAgentLoopIntent(intent)).toThrow("本次不发送");
  });
});
