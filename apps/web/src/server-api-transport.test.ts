import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { ApiConnectionError, fetchApiTransport } from "./server-api-transport";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => undefined) }));
const dropped = () => new TypeError("fetch failed", { cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }) });
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => { vi.useFakeTimers(); fetchMock.mockReset(); vi.mocked(delay).mockClear(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("server API connection recovery", () => {
  it.each(["GET", "HEAD"])("recovers a %s without dropping query or authorization", async method => {
    fetchMock.mockRejectedValueOnce(dropped()).mockRejectedValueOnce(dropped()).mockResolvedValue(new Response(null, { status: 200 }));
    const url = "http://api.test/v1/research-items?q=synthetic&visibility=archived";
    const response = await fetchApiTransport(url, { method, headers: { authorization: "Bearer synthetic" }, cache: "no-store" });
    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [actualUrl, options] of fetchMock.mock.calls) {
      expect(actualUrl).toBe(url);
      expect(new Headers(options?.headers).get("authorization")).toBe("Bearer synthetic");
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("limits a persistent outage and gives a safe actionable error", async () => {
    fetchMock.mockRejectedValue(dropped());
    await expect(fetchApiTransport("http://api.test/private?token=secret", {})).rejects.toThrow("数据服务暂时无法连接");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(vi.mocked(delay).mock.calls.map(call => call[0])).toEqual([250, 750, 1500, 2500]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["POST", "PATCH", "PUT", "DELETE"])("never replays an ambiguous %s business operation", async method => {
    fetchMock.mockRejectedValue(dropped());
    await expect(fetchApiTransport("http://api.test/v1/orders", { method, body: "synthetic" })).rejects.toBeInstanceOf(ApiConnectionError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it.each([401, 403, 409, 422, 500])("preserves HTTP %s for the caller without transport retries", async status => {
    fetchMock.mockResolvedValue(new Response(null, { status }));
    expect((await fetchApiTransport("http://api.test/v1/research-items", {})).status).toBe(status);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not mask configuration or programming errors", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to parse URL"));
    await expect(fetchApiTransport("bad-url", {})).rejects.toThrow("Failed to parse URL");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("can recover the replayable client-credentials token grant", async () => {
    fetchMock.mockRejectedValueOnce(dropped()).mockResolvedValue(Response.json({ access_token: "synthetic" }));
    const response = await fetchApiTransport("http://identity.test/token", { method: "POST", body: new URLSearchParams({ grant_type: "client_credentials" }) }, "identity");
    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts a hanging read at one shared deadline", async () => {
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })));
    const result = expect(fetchApiTransport("http://api.test/v1/research-items", {})).rejects.toBeInstanceOf(ApiConnectionError);
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors cancellation before attempting any request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(fetchApiTransport("http://api.test/v1/research-items", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not leave a timer that aborts a successful streaming body", async () => {
    fetchMock.mockResolvedValue(new Response("original media"));
    const response = await fetchApiTransport("http://api.test/v1/assets/file", {});
    const signal = fetchMock.mock.calls[0]![1]!.signal!;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signal.aborted).toBe(false);
    expect(await response.text()).toBe("original media");
    expect(vi.getTimerCount()).toBe(0);
  });
});
