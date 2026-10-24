import { describe, expect, it, vi } from "vitest";
import { studioResultIntentKey, type StudioPinnedResultRequest } from "@yummyai/contracts/pod/studio-original";
import { createStudioResultIntents } from "./studio-result-intent";

const scope = "019f0000-0000-7000-8000-000000000001";
const source = { namespace: "image_files" as const, entryId: "019f0000-0000-7000-8000-000000000002", revision: 4, assetId: "019f0000-0000-7000-8000-000000000003", assetVersion: 2, checksumSha256: "a".repeat(64), mediaType: "image/png", byteSize: 100, sourceKind: "owned" as const };
const request: StudioPinnedResultRequest = { operation: "result.submit.pinned", scope, key: "image:owned", title: "本人原图方案", sourceReference: "本人合成原图", rightsAttested: true, submissionId: "019f0000-0000-4000-8000-000000000004", source };
const receipt = { batchId: scope, candidateId: "019f0000-0000-7000-8000-000000000005", versionId: "019f0000-0000-7000-8000-000000000006", assetId: source.assetId, replayed: false };
function setup() {
  const store = new Map<string, { revision: number; value: unknown }>(); let submitted = false, loseSubmit = false, loseSave = false, current = true;
  const call = vi.fn(async (input: Record<string, unknown>): Promise<unknown> => {
    if (input.operation === "state.keys") return [...store.keys()];
    if (input.operation === "state.get") return structuredClone(store.get(String(input.key)) ?? { revision: 0, value: null });
    if (input.operation === "state.set") { const original = store.get(String(input.key)); if ((original?.revision ?? 0) !== input.revision) throw new Error("CAS conflict"); store.set(String(input.key), { revision: Number(input.revision) + 1, value: structuredClone(input.value) }); if (loseSave) throw new Error("Synthetic save ACK lost"); return { revision: Number(input.revision) + 1, assetId: null }; }
    if (input.operation === "result.submit.pinned") { submitted = true; if (loseSubmit) throw new Error("Synthetic submit ACK lost"); return receipt; }
    if (input.operation === "result.lookup") return submitted ? { status: "found", receipt } : { status: "missing" };
    throw new Error("Unexpected operation");
  });
  const helper = createStudioResultIntents(scope, call as <T>(input: Record<string, unknown>) => Promise<T>, () => { if (!current) throw new Error("owner changed"); });
  return { helper, call, store, loseSubmit: () => { loseSubmit = true; }, loseSave: () => { loseSave = true; }, revoke: () => { current = false; } };
}
describe("original Studio result intent", () => {
  it("proves the durable frozen input before a first explicit submit", async () => {
    const test = setup(), prepared = await test.helper.prepare(request);
    expect(prepared.created).toBe(true); expect(prepared.item.key).toBe(studioResultIntentKey(source));
    expect(test.call.mock.calls.map(([input]) => input.operation)).toEqual(["state.get", "state.get", "state.set", "state.get"]);
    expect(test.store.get(prepared.item.key)?.value).toEqual({ version: 1, status: "prepared", request });
    expect(await test.helper.submit(prepared.item)).toEqual(receipt);
    expect(test.call.mock.calls.at(-1)?.[0]).toEqual(request);
  });
  it("keeps a committed lost-ACK submit and only looks up its original receipt after reload", async () => {
    const test = setup(), prepared = await test.helper.prepare(request); test.loseSubmit();
    await expect(test.helper.submit(prepared.item)).rejects.toThrow("ACK lost");
    await test.helper.record(prepared.item, "unknown");
    test.call.mockClear(); const restored = await test.helper.list();
    expect(restored.items).toHaveLength(1);
    expect(await test.helper.lookup(restored.items[0]!)).toEqual({ status: "found", receipt });
    expect(test.call.mock.calls.every(([input]) => ["state.keys", "state.get", "result.lookup"].includes(String(input.operation)))).toBe(true);
    expect(test.call.mock.calls.at(-1)?.[0]).toEqual({ ...request, operation: "result.lookup" });
  });
  it("does not replace a pending request with changed inputs or a newly generated ID", async () => {
    const test = setup(), first = await test.helper.prepare(request); test.call.mockClear();
    const second = await test.helper.prepare({ ...request, title: "另一次编辑", submissionId: "019f0000-0000-4000-8000-000000000009" });
    expect(second).toEqual({ created: false, item: first.item });
    expect(test.call.mock.calls.map(([input]) => input.operation)).toEqual(["state.get"]);
  });
  it("a lost intent save cannot submit and its original prepared body is recoverable", async () => {
    const test = setup(); test.loseSave();
    await expect(test.helper.prepare(request)).rejects.toThrow("save ACK lost");
    const restored = await test.helper.list(); expect(restored.items[0]?.value.request).toEqual(request);
    expect(test.call.mock.calls.some(([input]) => input.operation === "result.submit.pinned")).toBe(false);
  });
  it("a missing lookup never sends or creates a replacement submit", async () => {
    const test = setup(), prepared = await test.helper.prepare(request); test.call.mockClear();
    expect(await test.helper.lookup(prepared.item)).toEqual({ status: "missing" });
    expect(test.call.mock.calls.map(([input]) => input.operation)).toEqual(["result.lookup"]);
  });
  it("preserves CAS history and requires explicit new intent after a confirmed receipt", async () => {
    const test = setup(), prepared = await test.helper.prepare(request);
    const confirmed = await test.helper.record(prepared.item, "confirmed", receipt);
    expect((await test.helper.prepare({ ...request, title: "第二方案" })).item).toEqual(confirmed);
    const second = await test.helper.prepare({ ...request, title: "第二方案", submissionId: "019f0000-0000-4000-8000-000000000009" }, true);
    expect(second.created).toBe(true); expect(second.item.revision).toBe(confirmed.revision + 1);
    expect(test.call.mock.calls.filter(([input]) => input.operation === "result.submit.pinned")).toHaveLength(0);
  });
  it("blocks changed durable input and stale personal authority before submit", async () => {
    const test = setup(), prepared = await test.helper.prepare(request);
    test.store.set(prepared.item.key, { revision: prepared.item.revision + 1, value: { ...prepared.item.value, request: { ...request, title: "changed" } } });
    await expect(test.helper.submit(prepared.item)).rejects.toThrow("其他版本");
    test.revoke(); await expect(test.helper.lookup(prepared.item)).rejects.toThrow("owner changed");
    expect(test.call.mock.calls.some(([input]) => input.operation === "result.submit.pinned")).toBe(false);
  });
  it("cannot downgrade another page's already confirmed original receipt to unknown", async () => {
    const test = setup(), prepared = await test.helper.prepare(request);
    const confirmed = await test.helper.record(prepared.item, "confirmed", receipt); test.call.mockClear();
    expect(await test.helper.record(prepared.item, "unknown")).toEqual(confirmed);
    expect(test.call.mock.calls.map(([input]) => input.operation)).toEqual(["state.get"]);
  });
  it("requires an explicit receipt save after read-only recovery before a new same-original intent may be prepared", async () => {
    const test = setup(), original = await test.helper.prepare(request); test.loseSubmit();
    await expect(test.helper.submit(original.item)).rejects.toThrow("ACK lost");
    await test.helper.record(original.item, "unknown"); test.call.mockClear();
    const restored = (await test.helper.list()).items[0]!;
    const found = await test.helper.lookup(restored);
    expect(found.status).toBe("found");
    expect(test.call.mock.calls.every(([input]) => ["state.keys", "state.get", "result.lookup"].includes(String(input.operation)))).toBe(true);
    const nextRequest = { ...request, title: "本人明确的新方案", submissionId: "019f0000-0000-4000-8000-000000000009" };
    expect((await test.helper.prepare(nextRequest, true)).created).toBe(false);
    test.call.mockClear();
    const confirmed = await test.helper.record(restored, "confirmed", found.status === "found" ? found.receipt : undefined);
    expect(test.call.mock.calls.map(([input]) => input.operation)).toEqual(["state.get", "state.set", "state.get"]);
    expect(confirmed.value.status).toBe("confirmed"); expect(confirmed.revision).toBe(restored.revision + 1);
    const next = await test.helper.prepare(nextRequest, true);
    expect(next.created).toBe(true); expect(next.item.value.request).toEqual(nextRequest); expect(next.item.revision).toBe(confirmed.revision + 1);
    expect(test.call.mock.calls.some(([input]) => input.operation === "result.submit.pinned")).toBe(false);
  });
});
