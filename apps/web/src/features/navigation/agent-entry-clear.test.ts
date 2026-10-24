import { randomUUID, webcrypto } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { CreateAssistSchema } from "@yummyai/contracts/ai/assist";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSessionTaskDrafts } from "./task-draft";
import { prepareAssistIntent, saveAssistIntent, readAssistIntents } from "../ai-assist/assist-request-intent";
import { recordAssistEntryRun } from "../ai-assist/assist-entry-recovery";

describe("Independent Assist entry synchronous identity clearing", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("announces invalidation before logout clears storage, preserves same-actor markers, and rejects a late response instead of recreating an ID", async () => {
    const storage: Record<string, unknown> = {};
    Object.defineProperties(storage, { getItem: { value: (key: string) => typeof storage[key] === "string" ? storage[key] : null },
      setItem: { value: (key: string, value: string) => { storage[key] = value; } }, removeItem: { value: (key: string) => { delete storage[key]; } } });
    const surface = new EventTarget(); Object.defineProperty(surface, "sessionStorage", { value: storage });
    vi.stubGlobal("window", surface); vi.stubGlobal("sessionStorage", storage); vi.stubGlobal("crypto", webcrypto);
    const input = CreateAssistSchema.options[0].parse({ kind: "knowledge_answer", scopeId: randomUUID(), modelId: createEntityId(), requestId: randomUUID(),
      search: { query: "Synthetic private clear test", topic: "operations", platform: "all", market: "ALL", spuIds: [] } });
    const prepared = await prepareAssistIntent(input, "synthetic-original-person", "knowledge:" + input.scopeId); saveAssistIntent(prepared.intent);
    const observed: { existing: boolean; carriesPrivateDetail: boolean }[] = [];
    surface.addEventListener(ASSIST_INTENT_CLEAR_EVENT, event => { observed.push({ existing: readAssistIntents(prepared.intent.ownerScope).length === 1, carriesPrivateDetail: "detail" in event }); });
    clearSessionTaskDrafts({ preserveAssistIntents: true }); expect(observed).toEqual([]); expect(readAssistIntents(prepared.intent.ownerScope)).toEqual([prepared.intent]);
    clearSessionTaskDrafts(); expect(observed).toEqual([{ existing: true, carriesPrivateDetail: false }]); expect(readAssistIntents(prepared.intent.ownerScope)).toEqual([]);
    expect(() => recordAssistEntryRun(prepared.intent, createEntityId())).toThrow(); expect(readAssistIntents(prepared.intent.ownerScope)).toEqual([]);
  });
});
