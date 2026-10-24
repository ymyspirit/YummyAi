import { afterEach, describe, expect, it, vi } from "vitest";
import { createListingSyncRequest, ListingSyncError, listingSyncDenied, readListingSyncEvents, readListingSyncReceipt, readListingSyncRequest, readListingSyncWorkspace } from "./listing-sync-client";
import { syncAuthority, syncChecksum, syncContext, syncIds, syncInput, syncReceipt, syncResponse, syncView, syncWorkspace } from "./listing-sync.test-fixture";

afterEach(() => vi.unstubAllGlobals());
describe("personal Listing sync transport", () => {
  it("binds workspace actor, tenant, listing and authority before displaying real published sources", async () => {
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetcher);
    fetcher.mockResolvedValueOnce(syncResponse(syncWorkspace())); expect((await readListingSyncWorkspace(syncContext)).sources[0]!.listingVersionId).toBe(syncIds.other);
    const wrong = syncWorkspace(); wrong.context.actorId = syncIds.other; fetcher.mockResolvedValueOnce(syncResponse(wrong));
    await expect(readListingSyncWorkspace(syncContext)).rejects.toMatchObject({ status: 409, code: "authority_changed" });
    fetcher.mockResolvedValueOnce(Response.json(syncWorkspace(), { headers: { "x-yummyai-context-authority": "f".repeat(64) } }));
    await expect(readListingSyncWorkspace(syncContext)).rejects.toMatchObject({ status: 409 });
  });
  it("uses GET-only receipt recovery and rejects a different fixed target or substituted original request", async () => {
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetcher); fetcher.mockResolvedValueOnce(syncResponse(syncReceipt(false)));
    expect((await readListingSyncReceipt(syncContext, { requestKey: syncIds.key, requestChecksum: syncChecksum() })).found).toBe(false);
    expect(fetcher.mock.calls[0]![1]!.method).toBe("GET"); expect(fetcher.mock.calls[0]![1]!.body).toBeUndefined();
    const wrong = syncReceipt(); wrong.request!.accountId = syncIds.other; fetcher.mockResolvedValueOnce(syncResponse(wrong));
    await expect(readListingSyncReceipt(syncContext, { requestKey: syncIds.key, requestChecksum: syncChecksum() })).rejects.toMatchObject({ status: 502 });
    fetcher.mockResolvedValueOnce(syncResponse({ ...syncView(), id: syncIds.other })); await expect(readListingSyncRequest(syncContext, syncIds.request)).rejects.toMatchObject({ status: 502 });
    expect(fetcher.mock.calls.every(([, init]) => init!.method === "GET")).toBe(true);
  });
  it("does not retry unknown POST, requires a real key, and distinguishes lost authority from ordinary conflict", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("synthetic transport lost")); vi.stubGlobal("fetch", fetcher);
    await expect(createListingSyncRequest(syncContext, { ...syncInput(), requestKey: undefined })).rejects.toMatchObject({ status: 400 }); expect(fetcher).not.toHaveBeenCalled();
    await expect(createListingSyncRequest(syncContext, syncInput())).rejects.toMatchObject({ status: 0, submitted: true }); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).requestKey).toBe(syncIds.key);
    expect(fetcher.mock.calls[0]![1]!.headers).toMatchObject({ "x-yummyai-context-authority": syncAuthority });
    expect(listingSyncDenied(new ListingSyncError(409))).toBe(false); expect(listingSyncDenied(new ListingSyncError(409, "authority_changed"))).toBe(true);
  });
  it("accepts the exact old snapshot and original version, but rejects oversized bodies and detached event chains", async () => {
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetcher); fetcher.mockResolvedValueOnce(syncResponse(syncView()));
    const original = await readListingSyncRequest(syncContext, syncIds.request); expect(original.current.snapshot!.inventory).toEqual({ quantity: 0 });
    fetcher.mockResolvedValueOnce(syncResponse([original.current])); expect(await readListingSyncEvents(syncContext, original)).toEqual([original.current]);
    fetcher.mockResolvedValueOnce(syncResponse([{ ...original.current, id: syncIds.other }])); await expect(readListingSyncEvents(syncContext, original)).rejects.toMatchObject({ status: 502 });
    fetcher.mockResolvedValueOnce(new Response("{}", { headers: { "content-type": "application/json", "content-length": String(9 * 1024 * 1024), "x-yummyai-context-authority": syncAuthority } }));
    await expect(readListingSyncRequest(syncContext, syncIds.request)).rejects.toMatchObject({ status: 0 });
  });
});
