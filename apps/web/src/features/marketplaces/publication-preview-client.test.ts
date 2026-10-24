import { describe, it, expect, vi, afterEach } from "vitest";
import { createPublicationPreview, readPublicationWorkspace, readPublicationPreview, readPublicationReceipt, readPublicationPreviewEvents,
  cancelPublicationPreview, checkPublicationWorkspaceRead, PUBLICATION_PREVIEW_RECHECK_EVENT,
  verifyPublicationPreview, verifyPublicationWorkspace, verifyPublicationEvents, previewDenied } from "./publication-preview-client";
import { publicationPreviewFixture, previewId } from "./publication-preview.test-fixture";
afterEach(() => vi.unstubAllGlobals());
describe("publication preview original binding", () => {
  it("rejects substituted versions, node generations and target digests while accepting the original offline waiting receipt", async () => {
    const { context, input, value, workspace } = await publicationPreviewFixture();
    await expect(verifyPublicationPreview(value, { listingId: context.listingId, requestKey: input.requestKey, requestChecksum: input.requestChecksum })).resolves.toBeUndefined();
    await expect(verifyPublicationWorkspace(workspace, context, input.variantSkuId)).resolves.toBeUndefined();
    await expect(verifyPublicationPreview({ ...value, request: { ...value.request, listingVersionId: previewId(90) } })).rejects.toThrow();
    await expect(verifyPublicationPreview({ ...value, execution: { ...value.execution!, certificateGeneration: 9 } })).rejects.toThrow();
    await expect(verifyPublicationPreview({ ...value, intent: { ...value.intent!, requestChecksum: "0".repeat(64) } })).rejects.toThrow();
    expect(() => verifyPublicationEvents([{ ...value.request.current, id: previewId(91) }], value)).toThrow();
  });
  it("never retries a lost create response and refuses a successful body stamped for another authority", async () => {
    const { context, input, value } = await publicationPreviewFixture(), fetch = vi.fn().mockRejectedValueOnce(Error("transport")); vi.stubGlobal("fetch", fetch);
    await expect(createPublicationPreview(context, input)).rejects.toMatchObject({ submitted: true, status: 0 }); expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(Response.json(value, { status: 201, headers: { "x-yummyai-context-authority": "f".repeat(64) } }));
    await expect(createPublicationPreview(context, input)).rejects.toMatchObject({ status: 409, code: "authority_changed" }); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("checks every observed workspace account only after accepting the original JSON and rejects lost object access under the same authority", async () => {
    const { context, workspace } = await publicationPreviewFixture();
    workspace.sources.push({ accountId: previewId(2), accountName: "Another original source", marketplaceId: "US", target: null, canPrepare: false, reason: "not_bound" });
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(workspace, { headers: { "x-yummyai-context-authority": context.authority } })).mockResolvedValueOnce(new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    await expect(readPublicationWorkspace(context)).rejects.toMatchObject({ status: 403 });
    expect(fetch.mock.calls.map(call => call[1].method)).toEqual(["GET", "HEAD"]);
    const check = new URL(fetch.mock.calls[1]![0], "http://erp.invalid");
    expect(check.searchParams.get("accountIds")).toBe([previewId(2), workspace.recent[0]!.request.accountId].sort().join(","));
    expect(check.searchParams.has("variantSkuId")).toBe(false); expect(check.searchParams.get("listingVersionId")).toBe(context.listingVersionId);
  });
  it("checks exact original request access after a created201 without resubmitting or rewriting its original target", async () => {
    const { context, input, value } = await publicationPreviewFixture();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(value, { status: 201, headers: { "x-yummyai-context-authority": context.authority } })).mockResolvedValueOnce(new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    await expect(createPublicationPreview(context, input)).rejects.toMatchObject({ status: 403, submitted: true });
    expect(fetch.mock.calls.map(call => call[1].method)).toEqual(["POST", "HEAD"]);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(input); expect(fetch.mock.calls[1]![0]).toBe(`/api/erp-publication-preview/requests/${value.request.id}`);
  });
  it("uses bodyless exact-request checks for reads, receipts, events and cancel while not inventing an object for not_found", async () => {
    const { context, input, value } = await publicationPreviewFixture(), headers = { "x-yummyai-context-authority": context.authority };
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const lookup = { requestKey: input.requestKey, requestChecksum: input.requestChecksum };
    const receipt = { protocol: value.protocol, requestKey: input.requestKey, requestChecksum: input.requestChecksum, found: true, request: value, observedAt: "2026-10-22T00:00:00.000Z" };
    for (const [body, run] of [[value, () => readPublicationPreview(context, value.request.id)], [receipt, () => readPublicationReceipt(context, lookup)],
      [[value.request.current], () => readPublicationPreviewEvents(context, value)], [value, () => cancelPublicationPreview(context, value, "Original operator reason")]] as const) {
      fetch.mockReset().mockResolvedValueOnce(Response.json(body, { headers })).mockResolvedValueOnce(new Response(null, { headers }));
      await run(); expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls[1]![1].method).toBe("HEAD"); expect(fetch.mock.calls[1]![0]).toBe(`/api/erp-publication-preview/requests/${value.request.id}`);
    }
    fetch.mockReset().mockResolvedValueOnce(Response.json({ ...receipt, found: false, request: null }, { headers }));
    expect((await readPublicationReceipt(context, lookup)).found).toBe(false); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("distinguishes literal authority denial from ordinary HEAD conflicts and never reads a HEAD error body", async () => {
    const { context, value } = await publicationPreviewFixture(), headers = { "x-yummyai-context-authority": context.authority };
    for (const code of [undefined, "authority_changed"]) {
      const head = new Response(null, { status: 409, headers: code ? { "x-yummyai-error-code": code } : {} }), json = vi.spyOn(head, "json");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(value, { headers })).mockResolvedValueOnce(head));
      const error = await readPublicationPreview(context, value.request.id).catch(error => error);
      expect(error.status).toBe(409); expect(previewDenied(error)).toBe(code !== undefined); expect(json).not.toHaveBeenCalled();
    }
  });
  it("requests only a matching Listing recheck on known denial and suppresses recursive parent-probe notifications", async () => {
    const { context, value } = await publicationPreviewFixture(), target = new EventTarget(), notices: unknown[] = [];
    target.addEventListener(PUBLICATION_PREVIEW_RECHECK_EVENT, event => notices.push((event as CustomEvent).detail)); vi.stubGlobal("window", target);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(value, { headers: { "x-yummyai-context-authority": context.authority } })).mockResolvedValueOnce(new Response(null, { status: 403 })));
    await expect(readPublicationPreview(context, value.request.id)).rejects.toMatchObject({ status: 403 }); expect(notices).toEqual([{ listingId: context.listingId }]);
    notices.length = 0; vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 403 })));
    await expect(checkPublicationWorkspaceRead({ listingId: context.listingId, listingVersionId: context.listingVersionId, accountIds: "" }, context.authority, undefined, false)).rejects.toMatchObject({ status: 403 });
    expect(notices).toEqual([]);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(Error("temporary transport")));
    await expect(readPublicationPreview(context, value.request.id)).rejects.toMatchObject({ status: 0 }); expect(notices).toEqual([]);
  });
});
