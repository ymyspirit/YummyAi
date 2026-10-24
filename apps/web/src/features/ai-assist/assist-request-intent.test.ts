import { createHash, randomUUID, webcrypto } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { CreateAssistSchema } from "@yummyai/contracts/ai/assist";
import { assistRequestRecoveryText } from "@yummyai/contracts/ai/assist-recovery";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistIntentIdentity, prepareAssistIntent, saveAssistIntent, recordAssistIntentRun, readAssistIntents, forgetAssistIntent, ASSIST_INTENT_PREFIX } from "./assist-request-intent";

function storage() {
  class MemoryStorage implements Storage {
    #values = new Map<string, string>();
    get length() { return this.#values.size; }
    getItem(key: string) { return this.#values.get(key) ?? null; }
    setItem(key: string, value: string) { this.#values.set(key, String(value)); }
    removeItem(key: string) { this.#values.delete(key); }
    clear() { this.#values.clear(); }
    key(index: number) { return [...this.#values.keys()][index] ?? null; }
    keys() { return [...this.#values.keys()]; }
  }
  const value = new MemoryStorage();
  return new Proxy(value, {
    ownKeys: () => value.keys(),
    getOwnPropertyDescriptor: (_, key) => typeof key === "string" && value.getItem(key) !== null
      ? { configurable: true, enumerable: true, value: value.getItem(key), writable: true } : undefined,
    get: (target, key) => {
      if (typeof key === "string" && value.getItem(key) !== null) return value.getItem(key);
      const result: unknown = Reflect.get(target, key, target);
      return typeof result === "function" ? result.bind(target) : result;
    },
  });
}
const request = () => CreateAssistSchema.options[0].parse({ kind: "knowledge_answer", requestId: randomUUID(), scopeId: randomUUID(), modelId: createEntityId(),
  search: { query: "Synthetic private original question", topic: "operations", platform: "all", market: "ALL", spuIds: [] } });

describe("Ordinary Assist pure ID intent markers", () => {
  beforeEach(() => { vi.stubGlobal("sessionStorage", storage()); vi.stubGlobal("window", new EventTarget()); vi.stubGlobal("crypto", webcrypto); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("retains one original proof across remount reads without storing a body and blocks a second ambiguous paid intent", async () => {
    const input = request(), scope = `knowledge:${input.scopeId}`, prepared = await prepareAssistIntent(input, "synthetic-personal-session-A", scope);
    expect(prepared.intent.requestChecksum).toBe(createHash("sha256").update(assistRequestRecoveryText(input)).digest("hex"));
    saveAssistIntent(prepared.intent);
    const identity = await assistIntentIdentity("synthetic-personal-session-A", input.kind, scope);
    expect(readAssistIntents(identity.ownerScope, identity.taskScope)).toEqual([prepared.intent]);
    expect(JSON.stringify(sessionStorage)).not.toContain(input.search.query);
    expect(Object.keys(JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage)[0]!)!) as object).sort()).toEqual([
      "version", "ownerScope", "taskScope", "kind", "requestId", "requestChecksum", "runId"].sort());
    await expect(prepareAssistIntent({ ...input, requestId: randomUUID() }, "synthetic-personal-session-A", scope)).rejects.toMatchObject({ status: 409 });
    await expect(prepareAssistIntent({ ...input, requestId: randomUUID(), scopeId: randomUUID() }, "synthetic-personal-session-A", "another-object")).rejects.toMatchObject({ status: 409 });
    const saved = recordAssistIntentRun(prepared.intent, createEntityId());
    expect(readAssistIntents(identity.ownerScope)[0]).toEqual(saved);
    const other = await assistIntentIdentity("synthetic-personal-session-B", input.kind, scope); expect(readAssistIntents(other.ownerScope)).toEqual([]);
    forgetAssistIntent(saved); expect(readAssistIntents(identity.ownerScope)).toEqual([]);
  });

  it("rejects corrupt or private-bearing markers and fails closed when browser storage cannot retain the original ID", async () => {
    const input = request(), prepared = await prepareAssistIntent(input, "synthetic-personal-session-A", "synthetic-task"), key = ASSIST_INTENT_PREFIX + prepared.intent.ownerScope + ":" + prepared.intent.requestId;
    sessionStorage.setItem(key, JSON.stringify({ ...prepared.intent, prompt: "synthetic private body" }));
    expect(readAssistIntents(prepared.intent.ownerScope)).toEqual([]); expect(sessionStorage.getItem(key)).toBeNull();
    sessionStorage.setItem(key, "{invalid"); expect(readAssistIntents(prepared.intent.ownerScope)).toEqual([]);
    const broken = { ...sessionStorage, getItem: () => null, setItem: () => { throw new Error("Synthetic quota exhausted"); } };
    vi.stubGlobal("sessionStorage", broken);
    expect(() => saveAssistIntent(prepared.intent)).toThrow("本次不发送");
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {} });
    expect(() => saveAssistIntent(prepared.intent)).toThrow("本次不发送");
  });
});
