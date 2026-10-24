import { randomUUID, webcrypto } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { AssistViewSchema, CreateAssistSchema, type CreateAssist } from "@yummyai/contracts/ai/assist";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertAssistEntryResponse, assistEntryVerification, unverifiedAssistEntryIntents, recordAssistEntryRun } from "./assist-entry-recovery";
import { assistIntentHash, assistIntentIdentity, prepareAssistIntent, readAssistIntents, recordAssistIntentRun, saveAssistIntent, forgetAssistIntent } from "./assist-request-intent";

const question = () => CreateAssistSchema.options[0].parse({ kind: "knowledge_answer", scopeId: randomUUID(), requestId: randomUUID(), modelId: createEntityId(),
  search: { query: "Synthetic private original question", topic: "operations", platform: "all", market: "ALL", spuIds: [] } });
const order = () => CreateAssistSchema.options[2].parse({ kind: "order_review", orderLineId: createEntityId(), expectedRevision: 0,
  expectedSourceVersionId: null, requestId: randomUUID(), modelId: createEntityId() });
const scope = (input: CreateAssist) => input.kind === "knowledge_answer" ? "knowledge:" + input.scopeId : input.kind === "order_review" ? "order:" + input.orderLineId : "unsupported";
function view(input: CreateAssist) {
  return AssistViewSchema.parse({ id: createEntityId(), kind: input.kind, scope: scope(input), status: "queued", createdAt: "2026-10-22T00:00:00.000Z", completedAt: null,
    modelLabel: "Synthetic model", model: "synthetic", promptVersion: "original-v1", inputFingerprint: "a".repeat(64), stale: false, maxTaskCostUsd: 1,
    request: input, inputTokens: null, outputTokens: null, costUsd: null, error: null, diagnostics: [], sources: [], checks: [], result: null });
}
function memoryStorage() {
  const result: Record<string, unknown> = {};
  Object.defineProperties(result, {
    getItem: { value: (key: string) => typeof result[key] === "string" ? result[key] : null },
    setItem: { value: (key: string, value: string) => { result[key] = String(value); } },
    removeItem: { value: (key: string) => { delete result[key]; } },
  });
  return result;
}

describe("Independent knowledge and batch entry original-request recovery", () => {
  beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("sessionStorage", memoryStorage()); vi.stubGlobal("window", new EventTarget()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("accepts only the exact submitted knowledge or order request instead of treating another successful run as its receipt", async () => {
    for (const request of [question(), order()]) {
      const original = view(request);
      expect(await assertAssistEntryResponse(original, request, scope(request))).toEqual(original);
      for (const changed of [
        { scope: "another-private-object" }, { request: { ...request, requestId: randomUUID() } },
        { request: { ...request, modelId: createEntityId() } }, { request: null },
      ]) await expect(assertAssistEntryResponse({ ...original, ...changed }, request, scope(request))).rejects.toMatchObject({ status: 502 });
      const verification = await assistEntryVerification(original);
      expect(verification).toMatchObject({ requestId: request.requestId, runId: original.id });
      expect(verification?.requestChecksum).toMatch(/^[a-f0-9]{64}$/);
      expect(await assistEntryVerification({ ...original, request: null })).toBeNull();
      await expect(assistEntryVerification({ ...original, scope: "another-private-object" })).rejects.toMatchObject({ status: 502 });
    }
  });

  it("keeps known-ID markers blocked after refresh until the same actual request, run and checksum have all been read", async () => {
    const input = question(), prepared = await prepareAssistIntent(input, "synthetic-person-A", scope(input));
    saveAssistIntent(prepared.intent);
    const saved = view(input), known = recordAssistIntentRun(prepared.intent, saved.id), proof = await assistEntryVerification(saved);
    if (!proof) throw new Error("Synthetic actual request proof missing");
    const markers = readAssistIntents(known.ownerScope);
    expect(unverifiedAssistEntryIntents(markers, "knowledge_answer", [])).toEqual([known]);
    for (const wrong of [{ ...proof, runId: createEntityId() }, { ...proof, requestId: randomUUID() }, { ...proof, requestChecksum: "b".repeat(64) }])
      expect(unverifiedAssistEntryIntents(markers, "knowledge_answer", [wrong])).toEqual([known]);
    expect(unverifiedAssistEntryIntents(markers, "knowledge_answer", [proof])).toEqual([]);
    expect(unverifiedAssistEntryIntents([{ ...known, runId: null }], "knowledge_answer", [proof])).toHaveLength(1);
    const another = await assistIntentIdentity("synthetic-person-B", input.kind, scope(input));
    expect(readAssistIntents(another.ownerScope)).toEqual([]);
    expect(JSON.stringify(sessionStorage)).not.toContain(input.search.query);
  });

  it("retains a later selected order's unknown marker even after another order's known receipt has been verified", async () => {
    const first = order(), second = order(), owner = "synthetic-batch-person";
    const one = await prepareAssistIntent(first, owner, scope(first)); saveAssistIntent(one.intent);
    const knownOne = recordAssistIntentRun(one.intent, createEntityId());
    const two = await prepareAssistIntent(second, owner, scope(second)); saveAssistIntent(two.intent);
    const selectedTaskScopes = new Set(await Promise.all([first, second].map(input => assistIntentIdentity(owner, input.kind, scope(input)).then(value => value.taskScope))));
    const selected = readAssistIntents(knownOne.ownerScope).filter(marker => selectedTaskScopes.has(marker.taskScope));
    expect(selected).toHaveLength(2);
    expect(unverifiedAssistEntryIntents(selected, "order_review", [])).toHaveLength(2);
    const readOne = { runId: knownOne.runId!, requestId: knownOne.requestId, requestChecksum: knownOne.requestChecksum };
    expect(unverifiedAssistEntryIntents(selected, "order_review", [readOne])).toEqual([two.intent]);
    expect(await assistIntentHash(scope(first))).not.toBe(await assistIntentHash(scope(second)));
  });

  it("fails before any new submission when the original entry ID cannot be saved or existing IDs cannot be read", async () => {
    const prepared = await prepareAssistIntent(question(), "synthetic-entry-person", "synthetic-conversation");
    const send = vi.fn();
    vi.stubGlobal("sessionStorage", { setItem: () => { throw new Error("Synthetic storage quota unavailable"); }, getItem: () => null });
    expect(() => { saveAssistIntent(prepared.intent); send(); }).toThrow("本次不发送"); expect(send).not.toHaveBeenCalled();
    vi.stubGlobal("sessionStorage", new Proxy({}, { ownKeys: () => { throw new Error("Synthetic private storage inaccessible"); } }));
    expect(() => readAssistIntents(prepared.intent.ownerScope)).toThrow("本次不发起新的付费任务"); expect(send).not.toHaveBeenCalled();
  });

  it("never recreates a cleared original marker from a late entry response or replaces another actual run ID", async () => {
    const input = question(), prepared = await prepareAssistIntent(input, "synthetic-late-entry", scope(input)), id = createEntityId();
    saveAssistIntent(prepared.intent);
    expect(recordAssistEntryRun(prepared.intent, id).runId).toBe(id);
    expect(recordAssistEntryRun(prepared.intent, id).runId).toBe(id);
    expect(() => recordAssistEntryRun(prepared.intent, createEntityId())).toThrow();
    forgetAssistIntent(prepared.intent);
    expect(() => recordAssistEntryRun(prepared.intent, id)).toThrow();
    expect(readAssistIntents(prepared.intent.ownerScope)).toEqual([]);
    const changed = { ...prepared.intent, taskScope: "b".repeat(64) }; saveAssistIntent(changed);
    expect(() => recordAssistEntryRun(prepared.intent, id)).toThrow();
    expect(readAssistIntents(prepared.intent.ownerScope)).toEqual([changed]);
  });
});
