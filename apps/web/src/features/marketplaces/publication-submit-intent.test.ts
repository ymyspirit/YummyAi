import { describe, expect, it } from "vitest";
import { publicationStatusRequestText, publicationSubmitRequestText, type PublicationStatusTarget, type PublicationSubmitTarget } from "@yummyai/contracts/marketplace/publication-submit";
import { previewId, publicationPreviewFixture } from "./publication-preview.test-fixture";
import { publicationSubmitHash } from "./publication-submit-client";
import { PUBLICATION_SUBMIT_INTENT_PREFIX, publicationSubmitOwnerScope, preparePublicationSubmit, preparePublicationStatus, savePublicationSubmitIntent,
  recordPublicationSubmitIntent, readPublicationSubmitIntents, forgetPublicationSubmitIntent } from "./publication-submit-intent";

function storage(): Storage {
  const entries = new Map<string, string>();
  return { get length() { return entries.size; }, key: index => [...entries.keys()][index] ?? null, getItem: name => entries.get(name) ?? null,
    setItem: (name, text) => { entries.set(name, text); }, removeItem: name => { entries.delete(name); }, clear: () => entries.clear() };
}
async function source() {
  const preview = await publicationPreviewFixture();
  const target: PublicationSubmitTarget = { ...preview.target, previewRequestId: preview.value.request.id, previewEventId: preview.value.request.current.id,
    previewEventSequence: 1, previewExecutionId: preview.value.execution!.id, sku: "SYNTHETIC-SKU-NOT-STORED" };
  const owner = await publicationSubmitOwnerScope("synthetic:actor", target.listingId, target.listingVersionId, target.previewRequestId);
  const status: PublicationStatusTarget = { ...preview.target, publicationRequestId: previewId(20), submissionExecutionId: previewId(21),
    submissionTargetChecksum: await publicationSubmitHash(publicationSubmitRequestText(target)), sourceEventId: previewId(22), sourceEventSequence: 2, sourceSubmissionId: null, sku: target.sku };
  return { target, owner, status };
}
describe("publication submit scalar recovery", () => {
  it("persists and reads back only original scalar identifiers before an operation without retaining SKU or payload", async () => {
    const { target, owner } = await source(), store = storage(), draft = await preparePublicationSubmit(target, owner);
    expect(draft.input.acknowledgeReplacement).toBe(true);
    expect(draft.input.requestChecksum).toBe(await publicationSubmitHash(publicationSubmitRequestText(target)));
    expect(store.length).toBe(0); savePublicationSubmitIntent(draft.intent, store);
    expect(readPublicationSubmitIntents(owner, store)).toEqual([draft.intent]);
    const text = store.getItem(store.key(0)!)!;
    expect(store.key(0)).toBe(`${PUBLICATION_SUBMIT_INTENT_PREFIX}${owner}:${draft.input.requestKey}`);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["version", "ownerScope", "operation", "previewRequestId", "sourceId", "requestKey", "requestChecksum", "resultId", "state", "createdAt"].sort());
    for (const privateText of [target.sku, target.marketplaceId, target.nodeId, target.payloadChecksum, "acknowledgeReplacement"]) expect(text.includes(privateText)).toBe(false);
  });
  it("blocks a new key and status operation while the original submission is unknown and permits ending only a verified known marker", async () => {
    const { target, owner, status } = await source(), store = storage(), draft = await preparePublicationSubmit(target, owner);
    savePublicationSubmitIntent(draft.intent, store);
    expect(() => forgetPublicationSubmitIntent(draft.intent, store)).toThrow();
    expect(() => savePublicationSubmitIntent({ ...draft.intent, requestKey: previewId(30) }, store)).toThrow();
    const observation = await preparePublicationStatus(status, target.previewRequestId, owner);
    expect(() => savePublicationSubmitIntent(observation.intent, store)).toThrow();
    const known = recordPublicationSubmitIntent(draft.intent, status.publicationRequestId, store);
    expect(() => recordPublicationSubmitIntent(draft.intent, previewId(31), store)).toThrow();
    savePublicationSubmitIntent(observation.intent, store);
    expect(readPublicationSubmitIntents(owner, store)).toHaveLength(2);
    expect(() => forgetPublicationSubmitIntent({ ...known, requestChecksum: "0".repeat(64) }, store)).toThrow();
    forgetPublicationSubmitIntent(known, store);
    expect(readPublicationSubmitIntents(owner, store).map(value => value.operation)).toEqual(["status"]);
  });
  it("separates actor and immutable preview scope and rejects poisoned local records without inventing recovery bodies", async () => {
    const { target, owner } = await source(), store = storage(), draft = await preparePublicationSubmit(target, owner);
    savePublicationSubmitIntent(draft.intent, store);
    for (const alternate of [await publicationSubmitOwnerScope("synthetic:other", target.listingId, target.listingVersionId, target.previewRequestId),
      await publicationSubmitOwnerScope("synthetic:actor", target.listingId, previewId(40), target.previewRequestId)]) {
      expect(alternate).not.toBe(owner); expect(readPublicationSubmitIntents(alternate, store)).toEqual([]);
    }
    store.setItem(store.key(0)!, JSON.stringify({ ...draft.intent, payload: "Must not be retained" }));
    expect(() => readPublicationSubmitIntents(owner, store)).toThrow();
  });
  it("fails closed when storage rejects a write or cannot reliably read the saved marker", async () => {
    const { target, owner } = await source(), draft = await preparePublicationSubmit(target, owner), failing = storage(), unverified = storage();
    failing.setItem = () => { throw new Error("synthetic quota"); };
    expect(() => savePublicationSubmitIntent(draft.intent, failing)).toThrow();
    unverified.setItem = () => {};
    expect(() => savePublicationSubmitIntent(draft.intent, unverified)).toThrow();
    expect(readPublicationSubmitIntents(owner, unverified)).toEqual([]);
  });
  it("binds independent status recovery to its own original key and fixed source without converting it into submission success", async () => {
    const { target, owner, status } = await source(), store = storage(), draft = await preparePublicationStatus(status, target.previewRequestId, owner);
    expect(draft.input.sourceSubmissionId).toBeNull();
    expect(draft.input.requestChecksum).toBe(await publicationSubmitHash(publicationStatusRequestText(status)));
    expect(draft.input.requestChecksum).not.toBe(status.submissionTargetChecksum);
    savePublicationSubmitIntent(draft.intent, store);
    expect(() => recordPublicationSubmitIntent({ ...draft.intent, sourceId: previewId(42) }, previewId(43), store)).toThrow();
    expect(readPublicationSubmitIntents(owner, store)[0]).toEqual(draft.intent);
  });
});
