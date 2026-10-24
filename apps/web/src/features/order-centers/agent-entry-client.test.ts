import { afterEach, describe, expect, it, vi } from "vitest";
import { centerRequest, OrderCenterRequestError } from "./order-center-model";

describe("Batch entry current-authority transport compatibility", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("uses the optional fourth authority argument without changing old callers and masks stamped failures without retrying", async () => {
    const fetchMock = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetchMock); const authority = "synthetic original ERP authority";
    fetchMock.mockResolvedValueOnce(Response.json({ id: "synthetic-line" }, { headers: { "x-yummyai-context-authority": authority } }));
    expect(await centerRequest("lines/synthetic-line", undefined, undefined, authority)).toEqual({ id: "synthetic-line" });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ "x-yummyai-context-authority": authority });
    fetchMock.mockResolvedValueOnce(Response.json({ legacy: true })); expect(await centerRequest("lines/synthetic-line")).toEqual({ legacy: true });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({});
    fetchMock.mockResolvedValueOnce(Response.json({ id: "synthetic-line" }, { headers: { "x-yummyai-context-authority": "old authority" } }));
    await expect(centerRequest("lines/synthetic-line", undefined, undefined, authority)).rejects.toMatchObject({ status: 409, code: "authority_changed" });
    fetchMock.mockResolvedValueOnce(Response.json({ message: "synthetic-private-error" }, { status: 500 }));
    const cause = await centerRequest("lines/synthetic-line", undefined, undefined, authority).catch(error => error);
    if (!(cause instanceof OrderCenterRequestError)) throw new Error("Expected the stamped order transport error");
    expect(cause.status).toBe(500); expect(cause.message).not.toContain("synthetic-private-error");
    expect(fetchMock).toHaveBeenCalledTimes(4); expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
});
