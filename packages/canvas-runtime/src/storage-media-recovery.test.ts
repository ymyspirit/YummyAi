import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import type { StudioWorkspace } from "@yummyai/contracts/pod/studio-personal";

const transport = vi.hoisted(() => ({
  rpc: vi.fn<(request: Record<string, unknown>) => Promise<unknown>>(),
  notify: vi.fn<(type: string, payload: Record<string, unknown>) => void>(),
  initialWorkspace: undefined as unknown,
}));
vi.mock("./rpc", () => ({ initialized: Promise.resolve({ workspace: transport.initialWorkspace }), channel: "synthetic-media-recovery-channel", rpc: transport.rpc, notify: transport.notify }));

type Media = { contentBase64: string; mediaType: string };
type Remote = { revision: number; media: Media | null };
const namespace = "image_files", key = "synthetic-media-recovery";
// These opaque binary fixtures exercise Blob transport, including non-ASCII
// bytes and a changed MIME. They do not claim image codec/scan acceptance.
const bytesA = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0x7f, 0x80, 0xff, 0x41]);
const bytesB = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0xff, 0, 0x80, 0x57, 0x42]);
const wire = (bytes: Uint8Array, mediaType: string): Media => ({ contentBase64: btoa(String.fromCharCode(...bytes)), mediaType });
const mediaA = wire(bytesA, "image/png"), mediaB = wire(bytesB, "image/webp");
const blobA = () => new Blob([bytesA.slice()], { type: mediaA.mediaType });
const blobB = () => new Blob([bytesB.slice()], { type: mediaB.mediaType });
const baseWorkspace: StudioWorkspace = {
  version: 1, scope: "unassigned", documentTransferVersion: 1,
  contextAuthority: erpSessionAuthority({
    userId: "019f0000-0000-7000-8000-000000000021", tenantId: "019f0000-0000-7000-8000-000000000022",
    permissions: ["design:read", "design:write", "asset:read", "asset:write"], dataScope: "self",
  }),
  capabilities: { read: true, save: true, mediaWrite: true, review: false, submit: false, configure: false },
  generation: { enabled: false, code: "operator_paused" },
};
const reads = () => transport.rpc.mock.calls.filter(([request]) => request.operation === "state.get").map(([request]) => request);
const writes = () => transport.rpc.mock.calls.filter(([request]) => request.operation === "state.set" || request.operation === "state.remove").map(([request]) => request);
const latest = (type: string) => transport.notify.mock.calls.filter(([name]) => name === type).at(-1)?.[1] ?? {};

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.stubGlobal("window", new EventTarget());
  transport.initialWorkspace = structuredClone(baseWorkspace); transport.rpc.mockReset(); transport.notify.mockReset();
});
afterEach(async () => {
  // End the real owner before draining any work left by a failed assertion.
  window.dispatchEvent(new Event("pagehide")); await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});
async function event(type: "studio.reconcile" | "studio.retry") {
  window.dispatchEvent(new Event(type)); await vi.advanceTimersByTimeAsync(0);
}
async function blobEquals(value: Blob | null, expected: Media) {
  expect(value).toBeInstanceOf(Blob); expect(value?.type).toBe(expected.mediaType);
  const bytes = new Uint8Array(await value!.arrayBuffer());
  expect(wire(bytes, value!.type)).toEqual(expected);
}
async function fixture(remove: boolean | "committed-remove" = false, namespace: "image_files" | "media_files" = "image_files") {
  let workspace = structuredClone(baseWorkspace), attemptCount = 0;
  let remote: Remote = { revision: 9, media: remove ? structuredClone(mediaA) : null };
  transport.rpc.mockImplementation(async request => {
    if (request.namespace !== namespace || request.key !== key) throw new Error("Unexpected synthetic media address");
    if (request.operation === "state.get") return { revision: remote.revision, ...(remote.media ? { media: structuredClone(remote.media) } : { value: null }) };
    if (request.operation !== "state.set" && request.operation !== "state.remove") throw new Error("Unexpected synthetic media operation");
    if (request.revision !== remote.revision) throw new Error("Synthetic media CAS conflict");
    attemptCount++;
    // For the remove control, the first transport attempt never commits. For
    // Blob A, the first attempt really commits at CAS10 before losing its ACK.
    if (remove === true && attemptCount === 1) throw new Error("Synthetic remove connection lost before commit");
    let next: Media | null = null;
    if (request.operation === "state.set") {
      const input = request.media;
      if (!input || typeof input !== "object" || !("contentBase64" in input) || typeof input.contentBase64 !== "string"
        || !("mediaType" in input) || typeof input.mediaType !== "string" || "value" in request) throw new Error("Synthetic media wire body invalid");
      next = { contentBase64: input.contentBase64, mediaType: input.mediaType };
    }
    remote = { revision: remote.revision + 1, media: next };
    if (attemptCount === 1) throw new Error(remove === "committed-remove" ? "Synthetic remove committed but ACK lost" : "Synthetic media A committed but ACK lost");
    return { revision: remote.revision };
  });
  const module = await import("./storage"), storage = module.default.createInstance({ storeName: namespace });
  const hydrated = await storage.getItem<Blob>(key);
  if (remove) await blobEquals(hydrated, mediaA); else expect(hydrated).toBeNull();
  return {
    module, storage, remote: () => structuredClone(remote),
    capabilities(change: Partial<StudioWorkspace["capabilities"]>) {
      workspace = { ...workspace, capabilities: { ...workspace.capabilities, ...change } };
      window.dispatchEvent(new CustomEvent("studio.workspace", { detail: { workspace } }));
    },
    async reopen() {
      window.dispatchEvent(new Event("pagehide")); vi.resetModules();
      vi.stubGlobal("window", new EventTarget()); transport.initialWorkspace = structuredClone(workspace);
      const fresh = await import("./storage"); return fresh.default.createInstance({ storeName: namespace });
    },
  };
}
async function lostAWithLocalB() {
  const f = await fixture();
  await expect(f.storage.setItem(key, blobA())).rejects.toThrow("Synthetic media A committed but ACK lost");
  const attemptedA = structuredClone(writes()[0]);
  expect(attemptedA).toEqual({ operation: "state.set", namespace, key, revision: 9, media: mediaA });
  expect(f.remote()).toEqual({ revision: 10, media: mediaA });
  await expect(f.storage.setItem(key, blobB())).rejects.toThrow("保存结果尚未确认");
  expect(writes()).toEqual([attemptedA]); await blobEquals(await f.storage.getItem<Blob>(key), mediaB);
  await event("studio.reconcile");
  expect(latest("studio.reconciled")).toMatchObject({ result: "unchanged" });
  expect(writes()).toEqual([attemptedA]); expect(f.module.studioStorageCertain()).toBe(false);
  return { ...f, attemptedA };
}

describe("non-producer media recovery retains the original proof through current capability checks", () => {
  it.each(["before the host retry", "after its synchronous entry but before the initialized microtask"] as const)(
    "keeps Blob B recoverable when only mediaWrite is revoked %s", async timing => {
      const f = await lostAWithLocalB();
      if (timing === "before the host retry") f.capabilities({ mediaWrite: false });
      // Do not await here: the second case changes the real workspace before
      // setItem resumes from `await initialized`, beyond a retry-entry check.
      window.dispatchEvent(new Event("studio.retry"));
      if (timing !== "before the host retry") f.capabilities({ mediaWrite: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(writes()).toEqual([f.attemptedA]); expect(f.remote()).toEqual({ revision: 10, media: mediaA });
      await blobEquals(await f.storage.getItem<Blob>(key), mediaB);
      expect.soft(f.module.studioStorageCertain()).toBe(false);
      await expect.soft(f.module.flushStudioStorage()).rejects.toThrow();

      f.capabilities({ mediaWrite: true }); await vi.advanceTimersByTimeAsync(700);
      expect(writes()).toEqual([f.attemptedA]);
      const count = reads().length; await event("studio.reconcile");
      expect(reads()).toHaveLength(count + 1); expect(reads().at(-1)).toEqual({ operation: "state.get", namespace, key });
      expect(latest("studio.reconciled")).toMatchObject({ result: "unchanged" });
      expect(writes()).toEqual([f.attemptedA]); await blobEquals(await f.storage.getItem<Blob>(key), mediaB);
      await event("studio.retry");
      expect(writes()).toEqual([f.attemptedA, { operation: "state.set", namespace, key, revision: 10, media: mediaB }]);
      expect(f.remote()).toEqual({ revision: 11, media: mediaB });
      await blobEquals(await f.storage.getItem<Blob>(key), mediaB);
      await expect(f.module.flushStudioStorage()).resolves.toBeUndefined();
      expect(latest("studio.storage")).toMatchObject({ pending: 0, dirty: 0, error: null });
      expect(writes()[0]).toEqual(f.attemptedA);
    },
  );

  it("retains a proven remove after save is revoked before its preflight and requires a new read before explicit deletion", async () => {
    const f = await fixture(true);
    await expect(f.storage.removeItem(key)).rejects.toThrow("Synthetic remove connection lost before commit");
    const attempted = structuredClone(writes()[0]); expect(attempted).toEqual({ operation: "state.remove", namespace, key, revision: 9 });
    expect(f.remote()).toEqual({ revision: 9, media: mediaA });
    await event("studio.reconcile"); expect(latest("studio.reconciled")).toMatchObject({ result: "unchanged" });
    f.capabilities({ save: false }); await event("studio.retry");
    expect(writes()).toEqual([attempted]); expect(f.remote()).toEqual({ revision: 9, media: mediaA });
    expect.soft(f.module.studioStorageCertain()).toBe(false);
    await expect.soft(f.module.flushStudioStorage()).rejects.toThrow();
    f.capabilities({ save: true }); await vi.advanceTimersByTimeAsync(700);
    expect(writes()).toEqual([attempted]);
    const count = reads().length; await event("studio.reconcile");
    expect(reads()).toHaveLength(count + 1); expect(reads().at(-1)).toEqual({ operation: "state.get", namespace, key });
    expect(latest("studio.reconciled")).toMatchObject({ result: "unchanged" });
    expect(writes()).toEqual([attempted]); await event("studio.retry");
    expect(writes()).toEqual([attempted, attempted]); expect(f.remote()).toEqual({ revision: 10, media: null });
    expect(await f.storage.getItem(key)).toBeNull(); await expect(f.module.flushStudioStorage()).resolves.toBeUndefined();
    expect(latest("studio.storage")).toMatchObject({ pending: 0, dirty: 0, error: null });
  });

  it("cleans a native asset_store draft changed back to proven A through an explicit no-op retry without rewriting A", async () => {
    const nativeKey = "infinite-canvas:asset_store";
    const initial = JSON.stringify({ version: 0, state: { assets: [] } });
    const native = (content: string) => JSON.stringify({ version: 0, state: { assets: [{
      id: "synthetic-native-text", kind: "text", title: "Synthetic retained prompt", tags: [],
      createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z",
      source: "Synthetic native recovery", coverUrl: "", data: { content },
    }] } });
    const valueA = native("Synthetic native A"), valueB = native("Synthetic later native B");
    let remote = { revision: 4, value: initial }, attempts = 0;
    transport.rpc.mockImplementation(async request => {
      if (request.namespace !== "app_state" || request.key !== nativeKey) throw new Error("Unexpected synthetic native address");
      if (request.operation === "state.get") return structuredClone(remote);
      if (request.operation !== "state.set" || typeof request.value !== "string") throw new Error("Unexpected synthetic native write");
      if (request.revision !== remote.revision) throw new Error("Synthetic native CAS conflict");
      remote = { revision: remote.revision + 1, value: request.value }; attempts++;
      if (attempts === 1) throw new Error("Synthetic native A committed but ACK lost");
      return { revision: remote.revision };
    });
    const module = await import("./storage"), storage = module.default.createInstance({ storeName: "app_state" });
    expect(await storage.getItem(nativeKey)).toBe(initial);
    const savingA = storage.setItem(nativeKey, valueA), lost = expect(savingA).rejects.toThrow("Synthetic native A committed but ACK lost");
    await vi.advanceTimersByTimeAsync(350); await lost;
    const attemptedA = structuredClone(writes()[0]);
    expect(attemptedA).toEqual({ operation: "state.set", namespace: "app_state", key: nativeKey, revision: 4, value: valueA });
    expect(remote).toEqual({ revision: 5, value: valueA });
    await expect(storage.setItem(nativeKey, valueB)).rejects.toThrow("保存结果尚未确认");
    expect(await storage.getItem(nativeKey)).toBe(valueB); expect(writes()).toEqual([attemptedA]);
    const before = reads().length; await event("studio.reconcile");
    expect(reads()).toHaveLength(before + 1); expect(reads().at(-1)).toEqual({ operation: "state.get", namespace: "app_state", key: nativeKey });
    expect(latest("studio.reconciled")).toMatchObject({ result: "unchanged" });

    // Changing back is still a local edit under the immutable unknown A.
    await expect(storage.setItem(nativeKey, valueA)).rejects.toThrow("保存结果尚未确认");
    expect(await storage.getItem(nativeKey)).toBe(valueA); expect(writes()).toEqual([attemptedA]);
    expect(module.studioStorageCertain()).toBe(false); await expect(module.flushStudioStorage()).rejects.toThrow();
    await event("studio.retry"); await vi.advanceTimersByTimeAsync(350);
    expect(writes()).toEqual([attemptedA]); expect(remote).toEqual({ revision: 5, value: valueA });
    expect(await storage.getItem(nativeKey)).toBe(valueA);
    await expect.soft(module.flushStudioStorage()).resolves.toBeUndefined();
    expect.soft(latest("studio.storage")).toMatchObject({ pending: 0, dirty: 0, error: null });
    expect(writes()).toEqual([attemptedA]); expect(attempts).toBe(1);
  });

  it("saves the latest Blob B instead of repeating an unknown remove after its original tombstone is proven", async () => {
    const f = await fixture("committed-remove");
    await expect(f.storage.removeItem(key)).rejects.toThrow("Synthetic remove committed but ACK lost");
    const attemptedRemove = structuredClone(writes()[0]);
    expect(attemptedRemove).toEqual({ operation: "state.remove", namespace, key, revision: 9 });
    expect(f.remote()).toEqual({ revision: 10, media: null });
    await expect(f.storage.setItem(key, blobB())).rejects.toThrow("保存结果尚未确认");
    await blobEquals(await f.storage.getItem<Blob>(key), mediaB);
    await event("studio.retry"); expect(writes()).toEqual([attemptedRemove]);
    const count = reads().length; await event("studio.reconcile");
    expect(reads()).toHaveLength(count + 1); expect(reads().at(-1)).toEqual({ operation: "state.get", namespace, key });
    expect(latest("studio.reconciled")).toMatchObject({ result: "unchanged" });
    expect(writes()).toEqual([attemptedRemove]); await blobEquals(await f.storage.getItem<Blob>(key), mediaB);
    await expect(f.module.flushStudioStorage()).rejects.toThrow();
    await event("studio.retry");
    expect(writes()).toEqual([attemptedRemove, { operation: "state.set", namespace, key, revision: 10, media: mediaB }]);
    expect(f.remote()).toEqual({ revision: 11, media: mediaB });
    await blobEquals(await f.storage.getItem<Blob>(key), mediaB);
    await expect(f.module.flushStudioStorage()).resolves.toBeUndefined();
    expect(latest("studio.storage")).toMatchObject({ pending: 0, dirty: 0, error: null });
    expect(writes()[0]).toEqual(attemptedRemove);
    const beforeReopen = reads().length, fresh = await f.reopen();
    await blobEquals(await fresh.getItem<Blob>(key), mediaB); expect(reads()).toHaveLength(beforeReopen + 1);
    expect(writes()).toHaveLength(2);
  });

  it("removes the latest local intent instead of repeating unknown Blob A after its original save is proven", async () => {
    const f = await fixture();
    await expect(f.storage.setItem(key, blobA())).rejects.toThrow("Synthetic media A committed but ACK lost");
    const attemptedA = structuredClone(writes()[0]);
    expect(attemptedA).toEqual({ operation: "state.set", namespace, key, revision: 9, media: mediaA });
    expect(f.remote()).toEqual({ revision: 10, media: mediaA });
    await expect(f.storage.removeItem(key)).rejects.toThrow("保存结果尚未确认");
    expect.soft(await f.storage.getItem(key)).toBeNull();
    await event("studio.retry"); expect(writes()).toEqual([attemptedA]);
    const count = reads().length; await event("studio.reconcile");
    expect(reads()).toHaveLength(count + 1); expect(reads().at(-1)).toEqual({ operation: "state.get", namespace, key });
    expect.soft(latest("studio.reconciled")).toMatchObject({ result: "unchanged" });
    expect(writes()).toEqual([attemptedA]); expect.soft(await f.storage.getItem(key)).toBeNull();
    await expect.soft(f.module.flushStudioStorage()).rejects.toThrow();
    await event("studio.retry");
    expect(writes()).toEqual([attemptedA, { operation: "state.remove", namespace, key, revision: 10 }]);
    expect(f.remote()).toEqual({ revision: 11, media: null }); expect(await f.storage.getItem(key)).toBeNull();
    await expect(f.module.flushStudioStorage()).resolves.toBeUndefined();
    expect(latest("studio.storage")).toMatchObject({ pending: 0, dirty: 0, error: null }); expect(writes()[0]).toEqual(attemptedA);
    const beforeReopen = reads().length, fresh = await f.reopen();
    expect(await fresh.getItem(key)).toBeNull(); expect(reads()).toHaveLength(beforeReopen + 1); expect(writes()).toHaveLength(2);
  });

  it.each(["image_files", "media_files"] as const)("refuses removal in %s without mediaWrite before accepting an intent or sending a mutation", async storeName => {
    const f = await fixture(true, storeName);
    expect(f.module.studioStorageCertain()).toBe(true); await expect(f.module.flushStudioStorage()).resolves.toBeUndefined();
    f.capabilities({ mediaWrite: false });
    await expect(f.storage.removeItem(key)).rejects.toThrow("仅可查看");
    await vi.advanceTimersByTimeAsync(700);
    expect(writes()).toEqual([]); expect(reads()).toEqual([{ operation: "state.get", namespace: storeName, key }]);
    expect(f.remote()).toEqual({ revision: 9, media: mediaA }); await blobEquals(await f.storage.getItem<Blob>(key), mediaA);
    expect(f.module.studioStorageCertain()).toBe(true); await expect(f.module.flushStudioStorage()).resolves.toBeUndefined();
  });

  it.each(["remove-to-set-null", "set-null-to-remove"] as const)("retains the new operation in %s even when both original and current values are null", async direction => {
    const nullKey = "studio:prompts", initial = { title: "Synthetic original null-intent boundary" };
    const originalOperation = direction === "remove-to-set-null" ? "state.remove" : "state.set";
    const latestOperation = direction === "remove-to-set-null" ? "state.set" : "state.remove";
    let remote: { revision: number; value: unknown; lastOperation: string } = { revision: 4, value: initial, lastOperation: "hydrate" }, attempts = 0;
    transport.rpc.mockImplementation(async request => {
      if (request.namespace !== "app_state" || request.key !== nullKey) throw new Error("Unexpected synthetic null-intent address");
      if (request.operation === "state.get") return structuredClone({ revision: remote.revision, value: remote.value });
      if (request.operation !== "state.set" && request.operation !== "state.remove") throw new Error("Unexpected synthetic null-intent operation");
      if (request.revision !== remote.revision || request.operation === "state.set" && request.value !== null
        || request.operation === "state.remove" && "value" in request) throw new Error("Synthetic null-intent CAS or body mismatch");
      remote = { revision: remote.revision + 1, value: null, lastOperation: request.operation }; attempts++;
      if (attempts === 1) throw new Error("Synthetic original null-intent committed but ACK lost");
      return { revision: remote.revision };
    });
    const module = await import("./storage"), storage = module.default.createInstance({ storeName: "app_state" });
    expect(await storage.getItem(nullKey)).toEqual(initial);
    const saving = originalOperation === "state.set" ? storage.setItem(nullKey, null) : storage.removeItem(nullKey);
    const lost = expect(saving).rejects.toThrow("Synthetic original null-intent committed but ACK lost");
    await vi.advanceTimersByTimeAsync(350); await lost;
    const attempted = structuredClone(writes()[0]);
    expect(attempted).toEqual({ operation: originalOperation, namespace: "app_state", key: nullKey, revision: 4,
      ...(originalOperation === "state.set" ? { value: null } : {}) });
    expect(remote).toEqual({ revision: 5, value: null, lastOperation: originalOperation });

    // Equal cached values do not erase the operator's opposite new action.
    const changed = latestOperation === "state.set" ? storage.setItem(nullKey, null) : storage.removeItem(nullKey);
    await expect(changed).rejects.toThrow("保存结果尚未确认");
    expect(await storage.getItem(nullKey)).toBeNull(); expect(writes()).toEqual([attempted]);
    const count = reads().length; await event("studio.reconcile");
    expect(reads()).toHaveLength(count + 1); expect(reads().at(-1)).toEqual({ operation: "state.get", namespace: "app_state", key: nullKey });
    expect(latest("studio.reconciled")).toMatchObject({ result: "unchanged" });
    expect(latest("studio.storage").dirty).toBeGreaterThan(0);
    expect(writes()).toEqual([attempted]); await expect(module.flushStudioStorage()).rejects.toThrow();
    await event("studio.retry"); await vi.advanceTimersByTimeAsync(350);
    expect(writes()).toEqual([attempted, { operation: latestOperation, namespace: "app_state", key: nullKey, revision: 5,
      ...(latestOperation === "state.set" ? { value: null } : {}) }]);
    expect(remote).toEqual({ revision: 6, value: null, lastOperation: latestOperation });
    expect(await storage.getItem(nullKey)).toBeNull(); expect(writes()[0]).toEqual(attempted); expect(attempts).toBe(2);
    await expect(module.flushStudioStorage()).resolves.toBeUndefined();
    expect(latest("studio.storage")).toMatchObject({ pending: 0, dirty: 0, error: null });
  });
});
