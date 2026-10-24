import { afterEach, describe, expect, it, vi } from "vitest";
import { captureStudioContext, recoverStudioRead, StudioApiError, studioProject } from "./studio-api";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("studio read recovery", () => {
  it("resumes a project read after a gateway outage without treating it as an empty project", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("Gateway restarting", { status: 502 }))
      .mockResolvedValueOnce(Response.json([{ id: "019a0000-0000-7000-8000-000000000001", name: "原项目", stepIndex: null }]));
    vi.stubGlobal("fetch", fetch);
    const onRetry = vi.fn(), controller = new AbortController();
    const context = captureStudioContext({ authority: "local-development", ownerScope: null, localDevelopment: true }, controller.signal, () => true);
    const result = recoverStudioRead(signal => studioProject("briefs", signal, context), { signal: controller.signal, onRetry });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toEqual([{ id: "019a0000-0000-7000-8000-000000000001", name: "原项目", stepIndex: null }]);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith("/api/canvas-bridge/briefs", expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }));
  });

  it("uses a bounded backoff during a longer outage and keeps one read pending", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue(new TypeError("Failed to fetch")), controller = new AbortController();
    const result = recoverStudioRead(read, { signal: controller.signal, onRetry: vi.fn() });
    const stopped = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledTimes(6);
    controller.abort();
    await stopped;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledTimes(6);
  });

  it.each([401, 403, 404, 409, 422])("stops on HTTP %s instead of hiding an access or business error", async status => {
    const error = new StudioApiError("需要用户处理", status), read = vi.fn().mockRejectedValue(error), onRetry = vi.fn();
    await expect(recoverStudioRead(read, { signal: new AbortController().signal, onRetry })).rejects.toBe(error);
    expect(read).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("aborts the active read when the editor scope is disposed", async () => {
    const controller = new AbortController();
    const read = vi.fn((signal: AbortSignal) => new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const result = recoverStudioRead(read, { signal: controller.signal, onRetry: vi.fn() });
    const stopped = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await stopped;
    expect(read).toHaveBeenCalledOnce();
  });
});
