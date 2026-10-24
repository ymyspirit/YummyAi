import { describe, expect, it, vi } from "vitest";
import type { StudioTransferRequest } from "@yummyai/contracts/pod/studio-document-transfer";
import { clearStudioTransferIntents, createStudioDocumentTransfer, studioTransferTarget, studioTransferVault } from "./studio-document-transfer-intent";

const target = "019f0000-0000-7000-8000-000000000051", request: StudioTransferRequest = { scope: "unassigned", targetScope: target, requestId: "ba9cb2c4-a7c2-4c06-a059-6d268336ad22", manifestHash: "b".repeat(64) };
const counts = { canvases: 1, prompts: 2, assets: 3, imageDrafts: 1, videoDrafts: 1, history: 2, media: 4 };
const receipt = { id: "019f0000-0000-7000-8000-000000000052", sourceScope: request.scope, targetScope: target, requestId: request.requestId, manifestHash: request.manifestHash, copiedAt: "2026-10-24T12:00:00.000Z", counts, entries: [] };
function memory() {
  const values = new Map<string, string>();
  return { values, get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(call = vi.fn<(input: Record<string, unknown>) => Promise<unknown>>()) {
  const storage = memory(), vault = studioTransferVault("a".repeat(64), storage); let active = true;
  const options = { scope: "unassigned", current: () => { if (!active) throw new DOMException("CLEAR", "AbortError"); }, vault, call };
  return { storage, vault, options, helper: createStudioDocumentTransfer(options), clear: () => { active = false; clearStudioTransferIntents(storage); } };
}

describe("complete document copy recovery", () => {
  it("read-proves only the exact request before prepare and leaves all document raw and credentials out of the vault", async () => {
    const env = fixture(); env.options.call.mockImplementation(async input => { expect(env.vault.read()).toEqual([request]); expect(input).toEqual({ operation: "document.prepare", ...request }); return { status: "prepared", request, receipt: null }; });
    await env.helper.prepare(request); expect([...env.storage.values.values()]).toEqual([JSON.stringify(request)]); expect(env.helper.originals()).toEqual([request]);
  });
  it("sends no prepare when local storage cannot preserve the original recovery identity", () => {
    const storage = memory(), call = vi.fn(), vault = studioTransferVault("a".repeat(64), { ...storage, setItem() { throw new Error("Synthetic quota"); } });
    const helper = createStudioDocumentTransfer({ scope: request.scope, current() {}, vault, call });
    expect(() => helper.prepare(request)).toThrow("未发送"); expect(call).not.toHaveBeenCalled();
  });
  it.each(["prepare", "commit"] as const)("keeps the original body after lost %s response and recovers across reload with lookup only", async operation => {
    const env = fixture(); env.vault.save(request); env.options.call.mockRejectedValueOnce(new Error("Lost ACK"));
    await expect(env.helper[operation](request)).rejects.toThrow("Lost ACK"); expect(env.vault.read()).toEqual([request]);
    const afterReload = createStudioDocumentTransfer(env.options); expect(afterReload.originals()).toEqual([request]);
    env.options.call.mockResolvedValueOnce({ status: operation === "commit" ? "committed" : "prepared", request, receipt: operation === "commit" ? receipt : null });
    await afterReload.lookup(request);
    expect(env.options.call.mock.calls.map(([input]) => input.operation)).toEqual([`document.${operation}`, "document.lookup"]);
    expect(env.options.call.mock.calls[1]?.[0]).toEqual({ operation: "document.lookup", ...request });
  });
  it("treats missing as a read result and refuses a fresh request while the original is unresolved", async () => {
    const env = fixture(); env.vault.save(request); env.options.call.mockResolvedValueOnce({ status: "missing", request, receipt: null });
    const found = await env.helper.lookup(request); expect(() => env.helper.beginAnother(request, found)).toThrow("先只读核对");
    expect(() => env.helper.prepare({ ...request, requestId: "8121cc95-a94b-477a-b1c3-8bca6f793389" })).toThrow("不更换编号");
    expect(env.options.call).toHaveBeenCalledTimes(1); expect(env.vault.read()).toEqual([request]);
  });
  it("keeps prepared manifest changes until explicit cancellation is proven by the server", async () => {
    const env = fixture(); env.vault.save(request); env.options.call.mockResolvedValueOnce({ status: "prepared", request, receipt: null });
    const prepared = await env.helper.lookup(request);
    expect(prepared.status).toBe("prepared"); expect(() => env.helper.beginAnother(request, { status: "cancelled", request, receipt: null })).toThrow("先只读核对");
    env.options.call.mockResolvedValueOnce({ status: "cancelled", request, receipt: null }); const cancelled = await env.helper.cancel(request);
    expect(env.options.call.mock.calls.map(([input]) => input.operation)).toEqual(["document.lookup", "document.cancel"]); expect(env.vault.read()).toEqual([request]);
    env.helper.beginAnother(request, cancelled); expect(env.vault.read()).toEqual([]);
    const next = { ...request, requestId: "8121cc95-a94b-477a-b1c3-8bca6f793389", manifestHash: "c".repeat(64) };
    env.options.call.mockResolvedValueOnce({ status: "prepared", request: next, receipt: null }); await env.helper.prepare(next);
    expect(env.vault.read()).toEqual([next]);
  });
  it("retains a lost cancellation identity and never interprets cancel racing commit as undoing copied content", async () => {
    const env = fixture(); env.vault.save(request); env.options.call.mockRejectedValueOnce(new Error("Lost cancel ACK")); await expect(env.helper.cancel(request)).rejects.toThrow("Lost cancel ACK");
    expect(env.vault.read()).toEqual([request]); env.options.call.mockResolvedValueOnce({ status: "committed", request, receipt });
    const found = await env.helper.lookup(request); expect(found.status).toBe("committed");
    const removal = vi.spyOn(env.storage, "removeItem").mockImplementationOnce(() => { throw new Error("Synthetic storage unavailable"); });
    expect(() => env.helper.beginAnother(request, found)).toThrow("未建立第二份复制"); expect(env.vault.read()).toEqual([request]); removal.mockRestore();
    env.helper.beginAnother(request, found); expect(env.vault.read()).toEqual([]);
    expect(env.options.call.mock.calls.map(([input]) => input.operation)).toEqual(["document.cancel", "document.lookup"]);
  });
  it("refuses mismatched receipts and late results after synchronous CLEAR without recreating their marker", async () => {
    const env = fixture(); env.vault.save(request); env.options.call.mockResolvedValueOnce({ status: "committed", request, receipt: { ...receipt, manifestHash: "c".repeat(64) } });
    await expect(env.helper.lookup(request)).rejects.toThrow(); expect(env.vault.read()).toEqual([request]);
    const pending = deferred<unknown>(); env.options.call.mockReturnValueOnce(pending.promise); const lookup = env.helper.lookup(request), rejected = expect(lookup).rejects.toMatchObject({ name: "AbortError" });
    env.clear(); pending.resolve({ status: "committed", request, receipt }); await rejected; expect(env.storage.length).toBe(0); expect(env.options.call).toHaveBeenCalledTimes(2);
  });
  it("accepts an authorized target outside the recent-project projection by UUID or same-site project link only", () => {
    expect(studioTransferTarget(target, "http://localhost:3000")).toBe(target);
    expect(studioTransferTarget(`http://localhost:3000/creative-designs/studio/canvas?brief=${target}`, "http://localhost:3000")).toBe(target);
    expect(studioTransferTarget(`/creative-designs/studio/video?brief=${target}`, "http://localhost:3000")).toBe(target);
    expect(studioTransferTarget(`/creative-designs/canvas?brief=${target}`, "http://localhost:3000")).toBe(target);
    for (const value of [`https://other.example/creative-designs/studio/canvas?brief=${target}`, `/orders?brief=${target}`, "invalid-original-input"]) expect(() => studioTransferTarget(value, "http://localhost:3000")).toThrow("原填写内容保持");
  });
});

describe("server-owned copy history recovery", () => {
  it("recovers without a local marker across pages and relogin using original reads only, rejects forged proofs and stops on unreliable storage or cursors", async () => {
    const pending = { ...request, requestId: "8121cc95-a94b-477a-b1c3-8bca6f793389", manifestHash: "c".repeat(64) }, cursor = "019f0000-0000-7000-8000-000000000040";
    const committed = { status: "committed" as const, request, receipt }, prepared = { status: "prepared" as const, request: pending, receipt: null };
    const env = fixture(); env.options.call.mockResolvedValueOnce({ items: [committed], nextCursor: cursor, unavailableOnPage: 1 }).mockResolvedValueOnce({ items: [prepared], nextCursor: null, unavailableOnPage: 0 }).mockImplementationOnce(async input => {
      expect(env.vault.read()).toEqual([pending]); expect(input).toEqual({ operation: "document.lookup", ...pending }); return prepared;
    });
    const recovered = await env.helper.recover(); expect(recovered.found).toEqual(prepared); expect(recovered.unavailableOnPage).toBe(1); expect(recovered.items).toEqual([committed, prepared]);
    expect(env.options.call.mock.calls.map(([input]) => input.operation)).toEqual(["document.requests", "document.requests", "document.lookup"]);
    expect(env.options.call.mock.calls[1]?.[0]).toEqual({ operation: "document.requests", scope: request.scope, cursor, limit: 25 });
    expect(() => env.helper.restore(pending, { status: "cancelled", request: pending, receipt: null })).toThrow("先读取本人的服务端");
    expect(() => env.helper.restore(request, committed)).toThrow("当前原复制请求仍保留"); expect(env.vault.read()).toEqual([pending]);
    expect(() => env.helper.restore({ ...pending, manifestHash: "d".repeat(64) }, prepared)).toThrow("先读取本人的服务端");
    // Closing the tab or logging in again can remove every local pointer. The
    // server request is still restored with its complete original four fields.
    env.storage.values.clear(); const relogin = createStudioDocumentTransfer(env.options);
    env.options.call.mockResolvedValueOnce({ items: [committed], nextCursor: null, unavailableOnPage: 0 }).mockResolvedValueOnce(committed);
    expect((await relogin.recover()).found).toEqual(committed); expect(env.vault.read()).toEqual([request]);
    expect(env.options.call.mock.calls.map(([input]) => input.operation)).toEqual(["document.requests", "document.requests", "document.lookup", "document.requests", "document.lookup"]);
    env.storage.values.clear(); const unavailable = createStudioDocumentTransfer(env.options), write = vi.spyOn(env.storage, "setItem").mockImplementationOnce(() => { throw new Error("Synthetic unavailable storage"); });
    env.options.call.mockResolvedValueOnce({ items: [committed], nextCursor: null, unavailableOnPage: 0 }); await expect(unavailable.recover()).rejects.toThrow("未发送");
    expect(env.options.call.mock.calls.at(-1)?.[0].operation).toBe("document.requests"); expect(env.storage.length).toBe(0); write.mockRestore();
    const badCursor = fixture(); badCursor.options.call.mockResolvedValueOnce({ items: [committed], nextCursor: cursor, unavailableOnPage: 0 }).mockResolvedValueOnce({ items: [], nextCursor: cursor, unavailableOnPage: 0 });
    await expect(badCursor.helper.recover()).rejects.toThrow("游标未向更早记录推进"); expect(badCursor.vault.read()).toEqual([]); expect(badCursor.options.call).toHaveBeenCalledTimes(2);
  });
  it("never continues an old history page or recreates its local marker when CLEAR happens during index, next-page or lookup recovery", async () => {
    const prepared = { status: "prepared" as const, request, receipt: null }, cursor = "019f0000-0000-7000-8000-000000000040";
    const first = fixture(), page = deferred<unknown>(); first.options.call.mockReturnValueOnce(page.promise);
    const recovery = first.helper.recover(), rejected = expect(recovery).rejects.toMatchObject({ name: "AbortError" }); first.clear(); page.resolve({ items: [prepared], nextCursor: cursor, unavailableOnPage: 0 }); await rejected;
    expect(first.options.call).toHaveBeenCalledTimes(1); expect(first.storage.length).toBe(0);
    const later = fixture(), next = deferred<unknown>(); later.options.call.mockResolvedValueOnce({ items: [{ status: "committed", request, receipt }], nextCursor: cursor, unavailableOnPage: 0 }).mockReturnValueOnce(next.promise);
    const advancing = later.helper.recover(), stopped = expect(advancing).rejects.toMatchObject({ name: "AbortError" }); await vi.waitFor(() => expect(later.options.call).toHaveBeenCalledTimes(2));
    later.clear(); next.resolve({ items: [prepared], nextCursor: null, unavailableOnPage: 0 }); await stopped; expect(later.storage.length).toBe(0); expect(later.options.call.mock.calls.map(([input]) => input.operation)).toEqual(["document.requests", "document.requests"]);
    const last = fixture(), originalLookup = deferred<unknown>(); last.options.call.mockResolvedValueOnce({ items: [prepared], nextCursor: null, unavailableOnPage: 0 }).mockReturnValueOnce(originalLookup.promise);
    const looking = last.helper.recover(), cleared = expect(looking).rejects.toMatchObject({ name: "AbortError" }); await vi.waitFor(() => expect(last.options.call).toHaveBeenCalledTimes(2)); expect(last.vault.read()).toEqual([request]);
    last.clear(); originalLookup.resolve(prepared); await cleared; expect(last.storage.length).toBe(0); expect(last.options.call.mock.calls.map(([input]) => input.operation)).toEqual(["document.requests", "document.lookup"]);
  });
});
