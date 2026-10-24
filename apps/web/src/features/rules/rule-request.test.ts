import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ruleRequest } from "./rule-request";

describe("rule read recovery", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => { vi.useFakeTimers(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("recovers after a server restart, including non-JSON gateway errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Bad gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 504 }))
      .mockResolvedValueOnce(Response.json({ rules: [] }));
    const result = ruleRequest("workspace");
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(result).resolves.toEqual({ rules: [] });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops after bounded retries when the network stays unavailable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const result = expect(ruleRequest("workspace")).rejects.toThrow("请点击“刷新”重新加载");
    await vi.advanceTimersByTimeAsync(7_000);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403, 409, 422, 500])("does not retry a %s requiring intervention", async status => {
    fetchMock.mockResolvedValue(Response.json({ message: "Action required" }, { status }));
    await expect(ruleRequest("workspace")).rejects.toThrow("Action required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry an invalid success response", async () => {
    fetchMock.mockResolvedValue(new Response("Invalid JSON"));
    await expect(ruleRequest("workspace")).rejects.toThrow("规则数据无法读取");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending retry when leaving the page or closing history", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue(new Response(null, { status: 502 }));
    const result = expect(ruleRequest("rule-id/history", undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await result;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a hung request after 15 seconds", async () => {
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const result = expect(ruleRequest("workspace")).rejects.toThrow("读取规则超时");
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["create", "rule-id/revise", "rule-id/publish", "rule-id/disable"])("never automatically replays %s", async path => {
    fetchMock.mockResolvedValue(new Response(null, { status: 502 }));
    await expect(ruleRequest(path, { reason: "test" })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(vi.getTimerCount()).toBe(0);
  });
});
