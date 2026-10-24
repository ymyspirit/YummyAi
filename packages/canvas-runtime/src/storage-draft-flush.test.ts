import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ rpc: vi.fn(), notify: vi.fn() }));
vi.mock("./rpc", () => ({ initialized: Promise.resolve({}), ...transport }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); vi.stubGlobal("window", new EventTarget()); transport.rpc.mockReset(); transport.notify.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("five-tool save barrier", () => {
  it("flushes the native 400ms queue plus the mounted 500ms viewport owner before reporting success", async () => {
    const storage = await import("./storage"), timers = await import("./studio-draft-flush");
    transport.rpc.mockResolvedValue({ revision: 1, value: null }); await storage.default.getItem("canvas");
    let viewportDirty = true, viewport = 1;
    const saveViewport = () => { if (!viewportDirty) return; viewportDirty = false; timers.queueStudioDraftWrite("native-canvas-store", () => storage.default.setItem("canvas", { viewport }), 400); };
    const nativeViewportTimer = setTimeout(saveViewport, 500);
    const unregister = timers.registerStudioDraftFlush(() => { clearTimeout(nativeViewportTimer); saveViewport(); });
    viewport = 37;
    const barrier = storage.flushStudioStorage(); await vi.advanceTimersByTimeAsync(350); await barrier;
    expect(transport.rpc.mock.calls.filter(([request]) => request.operation === "state.set")).toEqual([[{ operation: "state.set", namespace: "app_state", key: "canvas", revision: 1, value: { viewport: 37 } }]]);
    await vi.advanceTimersByTimeAsync(2000); expect(transport.rpc).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0); unregister();
  });
  it("keeps an unmounted tool's native queue and waits through media preflight and its exact original write", async () => {
    const storage = await import("./storage"), timers = await import("./studio-draft-flush"), preflight = deferred<{ revision: number; value: null }>(), acknowledgement = deferred<{ revision: number }>();
    transport.rpc.mockReturnValueOnce(preflight.promise).mockReturnValueOnce(acknowledgement.promise);
    const images = storage.default.createInstance({ storeName: "image_files" });
    timers.queueStudioDraftWrite("unmounted-image-tool", () => images.setItem("image:pending", new Blob(["original bytes"], { type: "image/png" })), 400);
    let complete = false; const barrier = storage.flushStudioStorage().then(() => { complete = true; });
    await vi.advanceTimersByTimeAsync(0); expect(complete).toBe(false); expect(transport.rpc).toHaveBeenCalledTimes(1);
    preflight.resolve({ revision: 8, value: null }); await vi.advanceTimersByTimeAsync(0); expect(complete).toBe(false);
    expect(transport.rpc.mock.calls[1]?.[0]).toMatchObject({ operation: "state.set", key: "image:pending", revision: 8, media: { mediaType: "image/png", contentBase64: btoa("original bytes") } });
    acknowledgement.resolve({ revision: 9 }); await barrier; expect(complete).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("refuses preview after a lost save acknowledgement without retrying the write or discarding local input", async () => {
    const storage = await import("./storage"); transport.rpc.mockResolvedValueOnce({ revision: 4, value: { prompt: "原输入" } }); await storage.default.getItem("input");
    transport.rpc.mockRejectedValueOnce(new Error("Lost write ACK")); const saving = storage.default.setItem("input", { prompt: "最新未提交输入" });
    const failed = expect(saving).rejects.toThrow("Lost write ACK"); await vi.advanceTimersByTimeAsync(350); await failed;
    expect(storage.studioStorageCertain()).toBe(false); await expect(storage.flushStudioStorage()).rejects.toThrow("尚未确认");
    expect(await storage.default.getItem("input")).toEqual({ prompt: "最新未提交输入" }); expect(transport.rpc).toHaveBeenCalledTimes(2);
  });
  it("persists the final canvas view before a normal tool switch but never flushes on CLEAR or revoked authority", async () => {
    const { attachStudioDraftFlushes, releaseStudioDraftOwner } = await import("./studio-draft-flush"), { createCanvasLifecycles } = await import("./canvas-lifecycle"), writes: string[] = [], registry = createCanvasLifecycles();
    let canSave = true;
    const owner = () => { const base = registry.create("source"), lease = attachStudioDraftFlushes(base); expect(lease).toBe(base); const initial = lease.signal;
      lease.activate(); lease.beginRestore(); lease.markRestored(); expect(initial.aborted).toBe(true); expect(lease.signal).not.toBe(initial); expect(lease.signal.aborted).toBe(false);
      lease.onBeforeRelease(() => writes.push("last original viewport")); return lease; };
    const a = owner(); releaseStudioDraftOwner(() => a.canSave() && canSave, a.beforeRelease, a.release); expect(writes).toEqual(["last original viewport"]); expect(a.signal.aborted).toBe(true);
    const cleared = owner(); cleared.release(); releaseStudioDraftOwner(() => cleared.canSave() && canSave, cleared.beforeRelease, cleared.release);
    const revoked = owner(); canSave = false; releaseStudioDraftOwner(() => revoked.canSave() && canSave, revoked.beforeRelease, revoked.release);
    expect(writes).toEqual(["last original viewport"]); expect(revoked.signal.aborted).toBe(true);
  });
});
