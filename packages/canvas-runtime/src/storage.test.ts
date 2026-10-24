import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";

const transport = vi.hoisted(() => ({ rpc: vi.fn(), notify: vi.fn() }));
vi.mock("./rpc", () => ({ initialized: Promise.resolve({}), ...transport }));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("window", new EventTarget());
  transport.rpc.mockReset();
  transport.notify.mockClear();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("upstream v0.20 thumbnail storage boundary", () => {
  it("keeps derived preview blobs in memory without sending them to ERP state or overwriting originals", async () => {
    const storage = (await import("./storage")).default;
    const previews = storage.createInstance({ storeName: "image_previews" });
    const preview = { version: 1, blob: new Blob(["preview"], { type: "image/webp" }) };
    await previews.setItem("image:legacy", preview);
    expect(await previews.getItem("image:legacy")).toBe(preview);
    expect(await previews.keys()).toEqual(["image:legacy"]);
    await previews.removeItem("image:legacy");
    expect(await previews.getItem("image:legacy")).toBeNull();
    expect(transport.rpc).not.toHaveBeenCalled();
  });

  it("reads historical originals through the authorized ERP namespace and retains their bytes", async () => {
    transport.rpc.mockResolvedValue({ revision: 3, media: { contentBase64: btoa("original bytes"), mediaType: "image/png" } });
    const storage = (await import("./storage")).default;
    const original = await storage.createInstance({ storeName: "image_files" }).getItem<Blob>("image:legacy");
    expect(await original!.text()).toBe("original bytes");
    expect(original!.type).toBe("image/png");
    expect(transport.rpc).toHaveBeenCalledExactlyOnceWith({ operation: "state.get", namespace: "image_files", key: "image:legacy" });
  });
});

describe("acknowledged native document semantic no-ops", () => {
  const key = "infinite-canvas:asset_store", old = '{"version":0,"state":{"assets":[{"id":"a","title":"keep  spaces","tags":["first","second"],"metadata":{"é":1,"é":2}}]}}';
  const reordered = '{"state":{"assets":[{"metadata":{"é":2,"é":1},"tags":["first","second"],"title":"keep  spaces","id":"a"}]},"version":0}';
  const get = (selected = key) => ({ operation: "state.get", namespace: "app_state", key: selected });
  const set = (revision: number, value: string, selected = key) => ({ operation: "state.set", namespace: "app_state", key: selected, revision, value });
  const event = async (type: "studio.reconcile" | "studio.retry") => { window.dispatchEvent(new Event(type)); await vi.advanceTimersByTimeAsync(0); };
  const load = async (value = old, selected = key, revision = 4) => {
    const storage = await import("./storage"); transport.rpc.mockResolvedValueOnce({ revision, value }); expect(await storage.default.getItem(selected)).toBe(value); return storage;
  };

  it.each(["infinite-canvas:asset_store", "infinite-canvas:canvas_store"])("keeps original %s bytes/revision when writable hydration changes only recursive object key order", async selected => {
    const original = selected.endsWith(":canvas_store") ? old.replace('"assets"', '"projects"') : old;
    const equivalent = selected.endsWith(":canvas_store") ? reordered.replace('"assets"', '"projects"') : reordered;
    const storage = await load(original, selected);
    expect(await storage.default.setItem(selected, equivalent)).toBe(equivalent); await storage.flushStudioStorage();
    expect(await storage.default.getItem(selected)).toBe(original); expect(transport.rpc).toHaveBeenCalledExactlyOnceWith(get(selected));
    const changed = equivalent.replace("keep  spaces", "real edit"); transport.rpc.mockResolvedValueOnce({ revision: 5 }); const saved = storage.default.setItem(selected, changed); await vi.advanceTimersByTimeAsync(350); await saved;
    expect(transport.rpc).toHaveBeenLastCalledWith(set(4, changed, selected));
  });

  it.each([
    ["field", (value: string) => value.replace('"a"', '"b"')],
    ["array order", (value: string) => value.replace('["first","second"]', '["second","first"]')],
    ["text whitespace", (value: string) => value.replace("keep  spaces", "keep spaces")],
  ] as const)("persists a real %s change with its original CAS", async (_label, change) => {
    const storage = await load(), changed = change(reordered); transport.rpc.mockResolvedValueOnce({ revision: 5 });
    const saved = storage.default.setItem(key, changed); await vi.advanceTimersByTimeAsync(350); await saved;
    expect(transport.rpc).toHaveBeenLastCalledWith(set(4, changed)); expect(await storage.default.getItem(key)).toBe(changed);
  });

  it("does not normalize other keys/namespaces or invalid native JSON into a successful no-op", async () => {
    const storage = (await import("./storage")).default;
    for (const [namespace, selected, original, changed] of [
      ["app_state", "infinite-canvas:other_store", old, reordered],
      ["video_generation_logs", key, old, reordered],
      ["app_state", key, '{"state":', '{"state":'],
      ["app_state", "infinite-canvas:canvas_store", '{"version":0,"state":{"projects":null}}', '{"state":{"projects":null},"version":0}'],
    ]) {
      const instance = storage.createInstance({ storeName: namespace }); transport.rpc.mockResolvedValueOnce({ revision: 7, value: original }); await instance.getItem(selected!);
      transport.rpc.mockResolvedValueOnce({ revision: 8 }); const saved = instance.setItem(selected!, changed); await vi.advanceTimersByTimeAsync(350); await saved;
      expect(transport.rpc).toHaveBeenLastCalledWith({ operation: "state.set", namespace, key: selected, revision: 7, value: changed });
    }
  });

  it("preserves a genuine revert behind an inflight edit instead of comparing it with the old cached checkpoint", async () => {
    const storage = await load(), changed = reordered.replace("keep  spaces", "real edit"); let acknowledge!: (value: { revision: number }) => void;
    transport.rpc.mockReturnValueOnce(new Promise(resolve => { acknowledge = resolve; })); const first = storage.default.setItem(key, changed); await vi.advanceTimersByTimeAsync(350);
    expect(transport.rpc).toHaveBeenLastCalledWith(set(4, changed)); const second = storage.default.setItem(key, reordered);
    acknowledge({ revision: 5 }); transport.rpc.mockResolvedValueOnce({ revision: 6 }); await vi.advanceTimersByTimeAsync(350); await first; await second;
    expect(transport.rpc).toHaveBeenLastCalledWith(set(5, reordered)); expect(transport.rpc).toHaveBeenCalledTimes(3);
  });

  it("does not write when a debounce edit returns to the acknowledged original before any RPC", async () => {
    const storage = await load(), first = storage.default.setItem(key, reordered.replace("keep  spaces", "temporary edit")), second = storage.default.setItem(key, reordered);
    await vi.advanceTimersByTimeAsync(350); await first; await second; await storage.flushStudioStorage();
    expect(transport.rpc).toHaveBeenCalledExactlyOnceWith(get()); expect(await storage.default.getItem(key)).toBe(old);
  });

  it("updates the checkpoint from exact ACK recovery so a later reverted draft is still written at the proven revision", async () => {
    const storage = await load(), changed = reordered.replace("keep  spaces", "committed edit"); transport.rpc.mockRejectedValueOnce(new Error("Lost native ACK"));
    const failed = expect(storage.default.setItem(key, changed)).rejects.toThrow("Lost native ACK"); await vi.advanceTimersByTimeAsync(350); await failed;
    await expect(storage.default.setItem(key, reordered)).rejects.toThrow("尚未确认");
    transport.rpc.mockResolvedValueOnce({ revision: 5, value: changed }); await event("studio.reconcile");
    expect(transport.notify).toHaveBeenLastCalledWith("studio.reconciled", expect.objectContaining({ result: "unchanged" }));
    transport.rpc.mockResolvedValueOnce({ revision: 6 }); await event("studio.retry"); await vi.advanceTimersByTimeAsync(350);
    expect(transport.rpc).toHaveBeenLastCalledWith(set(5, reordered)); expect(transport.rpc).toHaveBeenCalledTimes(4);
  });

  it("keeps lost-ACK original-string proof strict even when the server string differs only by object key order", async () => {
    const storage = await load(), changed = reordered.replace("keep  spaces", "committed edit"); transport.rpc.mockRejectedValueOnce(new Error("Lost native ACK"));
    const failed = expect(storage.default.setItem(key, changed)).rejects.toThrow("Lost native ACK"); await vi.advanceTimersByTimeAsync(350); await failed;
    transport.rpc.mockResolvedValueOnce({ revision: 5, value: old.replace("keep  spaces", "committed edit") }); await event("studio.reconcile");
    expect(transport.notify).toHaveBeenLastCalledWith("studio.reconciled", expect.objectContaining({ result: "conflict" }));
    await event("studio.retry"); await expect(storage.default.setItem(key, changed)).rejects.toThrow("尚未确认"); expect(transport.rpc).toHaveBeenCalledTimes(3);
  });

  it("allows a readonly semantic hydration echo while keeping original bytes and rejecting a changed native document", async () => {
    const storage = await import("./storage"), id = "019a0000-0000-7000-8000-000000000001";
    const workspace = { version: 1, scope: "unassigned", contextAuthority: erpSessionAuthority({ tenantId: id, userId: id, permissions: [], dataScope: "self", teamIds: [] }), capabilities: { read: true, save: false, mediaWrite: false, review: false, submit: false, configure: false }, generation: { enabled: false, code: "operator_paused" } };
    window.dispatchEvent(new CustomEvent("studio.workspace", { detail: { workspace } }));
    // The real INIT establishes this owner before its document is hydrated.
    await load();
    await storage.default.setItem(key, reordered); await expect(storage.default.setItem(key, reordered.replace("keep  spaces", "changed"))).rejects.toThrow("当前项目仅可查看");
    expect(await storage.default.getItem(key)).toBe(old); expect(transport.rpc).toHaveBeenCalledExactlyOnceWith(get());
  });
});
