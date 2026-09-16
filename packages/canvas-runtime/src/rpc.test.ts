import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const origin = "http://127.0.0.1:3000", channel = "isolated-studio-test";
let host: { postMessage: ReturnType<typeof vi.fn> }, runtime: EventTarget;
function message(data: Record<string, unknown>, source = host, eventOrigin = origin) {
  runtime.dispatchEvent(Object.assign(new Event("message"), { source, origin: eventOrigin, data: { channel, ...data } }));
}
beforeEach(() => {
  vi.useFakeTimers(); vi.resetModules();
  host = { postMessage: vi.fn() }; runtime = new EventTarget();
  vi.stubGlobal("parent", host); vi.stubGlobal("window", runtime);
  vi.stubGlobal("location", { search: `?parentOrigin=${encodeURIComponent(origin)}&channel=${channel}` });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("studio message session recovery", () => {
  it("repeats a lost ready message and stops only after a verified initialization", async () => {
    const rpc = await import("./rpc"); rpc.connect();
    expect(host.postMessage).toHaveBeenCalledWith({ type: "studio.ready", channel }, origin);
    message({ type: "studio.init" }, host, "https://elsewhere.test");
    await vi.advanceTimersByTimeAsync(4000);
    expect(host.postMessage).toHaveBeenCalledTimes(3);
    message({ type: "studio.init", scope: "unassigned", tool: "canvas", theme: "light" });
    await expect(rpc.initialized).resolves.toMatchObject({ scope: "unassigned" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.postMessage).toHaveBeenCalledTimes(3);
  });

  it("keeps hydration pending through recovery notifications and accepts the original reply", async () => {
    const rpc = await import("./rpc"); rpc.connect();
    message({ type: "studio.init", scope: "unassigned", tool: "canvas", theme: "light" });
    const result = rpc.rpc({ operation: "state.get", namespace: "app_state", key: "canvas" });
    const sent = host.postMessage.mock.calls.at(-1)![0] as { id: string };
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(100_000);
    message({ type: "studio.request-pending", id: sent.id });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(settled).toBe(false);
    message({ type: "studio.response", id: sent.id, result: { revision: 7, value: "existing canvas" } });
    await expect(result).resolves.toEqual({ revision: 7, value: "existing canvas" });
    expect(host.postMessage.mock.calls.filter(([data]) => data.type === "studio.request")).toHaveLength(1);
  });

  it("does not replay a timed-out write", async () => {
    const rpc = await import("./rpc"); rpc.connect();
    message({ type: "studio.init", scope: "unassigned", tool: "canvas", theme: "light" });
    const result = rpc.rpc({ operation: "state.set", namespace: "app_state", key: "canvas", revision: 3, value: "draft" });
    const rejected = expect(result).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(110_000); await rejected;
    expect(host.postMessage.mock.calls.filter(([data]) => data.type === "studio.request")).toHaveLength(1);
  });
});
