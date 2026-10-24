import { describe, it, expect } from "vitest";
import { preparePublicationIntent, savePublicationIntent, readPublicationIntents, recordPublicationIntent, forgetKnownPublicationIntent, publicationPreviewOwnerScope } from "./publication-preview-intent";
import { publicationPreviewFixture, previewId } from "./publication-preview.test-fixture";
function memory(): Storage { const rows = new Map<string, string>(); return { get length() { return rows.size; }, key: i => [...rows.keys()][i] ?? null,
  getItem: key => rows.get(key) ?? null, setItem: (key, value) => { rows.set(key, value); }, removeItem: key => { rows.delete(key); }, clear: () => rows.clear() }; }
describe("publication preview pure target recovery", () => {
  it("keeps an unresolved original across remount and isolates the actor without storing content or authority", async () => {
    const { target } = await publicationPreviewFixture(), storage = memory(), scope = await publicationPreviewOwnerScope(`${previewId(1)}:${previewId(2)}`, target.listingId), original = await preparePublicationIntent(target, scope);
    savePublicationIntent(original.intent, storage); const restored = readPublicationIntents(scope, storage)[0]!;
    expect(restored.requestKey).toBe(original.input.requestKey); expect(restored.target).toEqual(target);
    expect(readPublicationIntents("e".repeat(64), storage)).toEqual([]);
    expect(Object.keys(JSON.parse(storage.getItem(storage.key(0)!)!)).sort()).toEqual(["createdAt", "ownerScope", "requestChecksum", "requestId", "requestKey", "state", "target", "version"]);
    expect(() => savePublicationIntent(original.intent, storage)).toThrow(); expect(() => forgetKnownPublicationIntent(restored, storage)).toThrow();
    const known = recordPublicationIntent(restored, previewId(20), storage); forgetKnownPublicationIntent(known, storage); expect(storage.length).toBe(0);
  });
  it("fails closed on corrupt and unwritable recovery storage before a request can be sent", async () => {
    const { target } = await publicationPreviewFixture(), scope = "f".repeat(64), draft = await preparePublicationIntent(target, scope), storage = memory();
    storage.setItem(`yummyai.publication-preview.intent.v1:${scope}:${draft.intent.requestKey}`, JSON.stringify({ ...draft.intent, content: "must not persist" }));
    expect(() => readPublicationIntents(scope, storage)).toThrow();
    const failed = memory(); failed.setItem = () => { throw Error("unavailable"); }; expect(() => savePublicationIntent(draft.intent, failed)).toThrow();
  });
});
