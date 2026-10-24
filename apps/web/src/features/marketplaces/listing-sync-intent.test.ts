import { afterEach, describe, expect, it, vi } from "vitest";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { clearSessionTaskDrafts } from "../navigation/task-draft";
import { forgetKnownListingSyncIntent, LISTING_SYNC_INTENT_PREFIX, listingSyncOwnerScope, prepareListingSyncRequest, readListingSyncIntents,
  recordListingSyncRequest, saveListingSyncIntent } from "./listing-sync-intent";
import { syncIds, syncInput, syncStorage } from "./listing-sync.test-fixture";

afterEach(() => vi.unstubAllGlobals());
describe("original Listing sync intent safety", () => {
  it("stores only seven scalars and blocks another target until the first request is read and explicitly released", async () => {
    const storage = syncStorage(), scope = await listingSyncOwnerScope(`${syncIds.tenant}:${syncIds.actor}`, syncIds.listing), draft = await prepareListingSyncRequest(syncInput(), scope);
    saveListingSyncIntent(draft.intent, storage);
    const text = storage.getItem(storage.key(0)!)!, saved = JSON.parse(text);
    expect(Object.keys(saved).sort()).toEqual(["createdAt", "ownerScope", "requestChecksum", "requestId", "requestKey", "state", "version"]);
    for (const field of ["accountId", "listingId", "listingVersionId", "action", "desiredState", "prompt"]) expect(text).not.toContain(`"${field}"`);
    const other = await prepareListingSyncRequest({ ...syncInput(), action: "push_full_content" }, scope);
    expect(() => saveListingSyncIntent(other.intent, storage)).toThrow(); expect(() => forgetKnownListingSyncIntent(draft.intent, storage)).toThrow();
    const known = recordListingSyncRequest(draft.intent, syncIds.request, storage); expect(readListingSyncIntents(scope, storage)[0]).toEqual(known);
    forgetKnownListingSyncIntent(known, storage); expect(storage.length).toBe(0); expect(saveListingSyncIntent(other.intent, storage).state).toBe("unknown");
  });
  it("fails closed on unavailable storage, lost readback, corrupt markers and attempts to recreate a marker after logout", async () => {
    const draft = await prepareListingSyncRequest(syncInput(), "a".repeat(64)), unavailable = syncStorage(); unavailable.setItem = () => { throw Error("synthetic denied"); };
    expect(() => saveListingSyncIntent(draft.intent, unavailable)).toThrow();
    const lost = syncStorage(); lost.getItem = () => null; expect(() => saveListingSyncIntent(draft.intent, lost)).toThrow();
    const storage = syncStorage(); saveListingSyncIntent(draft.intent, storage); const name = storage.key(0)!;
    storage.setItem(name, JSON.stringify({ ...draft.intent, privateBody: "synthetic forbidden field" })); expect(() => readListingSyncIntents(draft.intent.ownerScope, storage)).toThrow();
    storage.clear(); expect(() => recordListingSyncRequest(draft.intent, syncIds.request, storage)).toThrow(); expect(storage.length).toBe(0);
  });
  it("keeps unresolved original keys isolated by actor and listing and binds every original target while ignoring key rotation in the target checksum", async () => {
    const storage = syncStorage(), scope = await listingSyncOwnerScope("synthetic-actor-a", syncIds.listing), other = await listingSyncOwnerScope("synthetic-actor-b", syncIds.listing);
    const first = await prepareListingSyncRequest(syncInput(), scope), same = await prepareListingSyncRequest(syncInput(), scope);
    expect(first.input.requestKey).not.toBe(same.input.requestKey); expect(first.intent.requestChecksum).toBe(same.intent.requestChecksum);
    saveListingSyncIntent(first.intent, storage); expect(readListingSyncIntents(other, storage)).toEqual([]);
    for (const change of [{ accountId: syncIds.other }, { listingId: syncIds.other }, { listingVersionId: syncIds.other }, { sourcePublicationRequestId: syncIds.other }, { action: "read_full_content" as const }]) {
      expect((await prepareListingSyncRequest({ ...syncInput(), ...change }, scope)).intent.requestChecksum).not.toBe(first.intent.requestChecksum);
    }
    expect(() => recordListingSyncRequest({ ...first.intent, requestChecksum: "f".repeat(64) }, syncIds.request, storage)).toThrow();
  });
  it("purges this prefix on logout after the synchronous clear event while preserving same-actor authority-change markers", async () => {
    const storage = syncStorage(), draft = await prepareListingSyncRequest(syncInput(), "a".repeat(64)); saveListingSyncIntent(draft.intent, storage);
    // Browser Storage enumerates its keys as own properties.
    const browserStorage = new Proxy(storage, { ownKeys: target => Array.from({ length: target.length }, (_, index) => target.key(index)!),
      getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }) });
    const events: string[] = []; vi.stubGlobal("window", { sessionStorage: browserStorage, dispatchEvent(event: Event) {
      if (event.type === ASSIST_INTENT_CLEAR_EVENT) { expect(storage.length).toBe(1); events.push(event.type); } return true;
    } });
    clearSessionTaskDrafts({ preserveAssistIntents: true }); expect(storage.length).toBe(1); expect(events).toEqual([]);
    clearSessionTaskDrafts(); expect(events).toEqual([ASSIST_INTENT_CLEAR_EVENT]); expect(storage.length).toBe(0);
    expect(LISTING_SYNC_INTENT_PREFIX).toBe("yummyai.listing-sync.intent.v1:");
  });
});
