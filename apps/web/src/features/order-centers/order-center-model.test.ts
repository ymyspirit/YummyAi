import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { centerRead, centerRequest } from "./order-center-model";

describe("order workspace read recovery", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const read = (signal = new AbortController().signal) =>
    centerRead("workspace?stage=pending_review", signal);

  it.each([502, 503, 504])(
    "recovers after one transient %s, including non-JSON gateways",
    async (status) => {
      fetchMock
        .mockResolvedValueOnce(new Response("Bad gateway", { status }))
        .mockResolvedValueOnce(Response.json({ items: [] }));
      const result = read();
      await vi.advanceTimersByTimeAsync(300);
      await expect(result).resolves.toEqual({ items: [] });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retries a network interruption only once and reports the outage", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const result = expect(read()).rejects.toThrow("订单服务暂时无法连接");
    await vi.advanceTimersByTimeAsync(300);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403, 422])("does not retry a %s requiring user action", async (status) => {
    fetchMock.mockResolvedValue(Response.json({ message: "Action required" }, { status }));
    await expect(read()).rejects.toThrow("Action required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ends a hung read at the shared deadline", async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const result = expect(read()).rejects.toThrow("订单读取超时");
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the pending retry when navigating away", async () => {
    const abort = new AbortController();
    fetchMock.mockResolvedValue(new Response(null, { status: 502 }));
    const result = expect(read(abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1);
    abort.abort();
    await result;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never automatically replays an order write", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 502 }));
    await expect(centerRequest("lines/synthetic/actions", { action: "push" })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
  });
});
