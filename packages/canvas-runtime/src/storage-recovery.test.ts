import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";

const transport = vi.hoisted(() => ({ rpc: vi.fn(), notify: vi.fn() }));
vi.mock("./rpc", () => ({ initialized: Promise.resolve({}), ...transport }));

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.stubGlobal("window", new EventTarget());
  transport.rpc.mockReset(); transport.notify.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const original = { canvas: { title: "Original", nodes: [{ id: "shape-1", x: 1 }] } };
const draft = { canvas: { title: "Draft", nodes: [{ id: "shape-1", x: 3 }] } };
const changedDraft = { canvas: { title: "Later local edit", nodes: [{ id: "shape-1", x: 9 }] } };
const key = "canvas:recovery";
const request = (operation: string, extra: Record<string, unknown> = {}) => ({ operation, namespace: "app_state", key, ...extra });
async function event(type: "studio.reconcile" | "studio.retry") {
  window.dispatchEvent(new Event(type)); await vi.advanceTimersByTimeAsync(0);
}
const reconciled = (result: "confirmed" | "unchanged" | "conflict") =>
  expect(transport.notify).toHaveBeenLastCalledWith("studio.reconciled", expect.objectContaining({ result }));
async function loadDocument() {
  const storage = (await import("./storage")).default;
  transport.rpc.mockResolvedValueOnce({ revision: 4, value: structuredClone(original) });
  expect(await storage.getItem(key)).toEqual(original);
  return storage;
}
async function loseSave(storage: Awaited<ReturnType<typeof loadDocument>>, value: unknown = structuredClone(draft)) {
  transport.rpc.mockRejectedValueOnce(new Error("Synthetic ACK lost after request"));
  const saved = storage.setItem(key, value);
  const failed = expect(saved).rejects.toThrow("Synthetic ACK lost");
  await vi.advanceTimersByTimeAsync(350); await failed;
}

describe("Studio original save result recovery", () => {
  it("confirms a committed expected+1 matching document through one read without sending another write", async () => {
    const storage = await loadDocument(); await loseSave(storage);
    expect(transport.rpc).toHaveBeenNthCalledWith(2, request("state.set", { revision: 4, value: draft }));
    // JSON object property order is not a new business version.
    transport.rpc.mockResolvedValueOnce({ revision: 5, value: { canvas: { nodes: [{ x: 3, id: "shape-1" }], title: "Draft" } } });
    await event("studio.reconcile"); reconciled("confirmed");
    expect(transport.rpc).toHaveBeenNthCalledWith(3, request("state.get"));
    expect(transport.rpc).toHaveBeenCalledTimes(3); expect(await storage.getItem(key)).toEqual(draft);
    expect(transport.notify).toHaveBeenCalledWith("studio.storage", { pending: 0, dirty: 0, error: null });
    await event("studio.retry"); expect(transport.rpc).toHaveBeenCalledTimes(3);
  });

  it("requires a read-only unchanged proof before an explicit retry may use the original CAS revision", async () => {
    const storage = await loadDocument(); await loseSave(storage);
    await event("studio.retry"); expect(transport.rpc).toHaveBeenCalledTimes(2);
    transport.rpc.mockResolvedValueOnce({ revision: 4, value: original });
    await event("studio.reconcile"); reconciled("unchanged");
    expect(transport.rpc).toHaveBeenCalledTimes(3);
    expect(transport.rpc.mock.calls.slice(2).map(([input]) => input.operation)).toEqual(["state.get"]);
    transport.rpc.mockResolvedValueOnce({ revision: 5 });
    await event("studio.retry"); await vi.advanceTimersByTimeAsync(350);
    expect(transport.rpc).toHaveBeenNthCalledWith(4, request("state.set", { revision: 4, value: draft }));
    expect(transport.notify).toHaveBeenLastCalledWith("studio.storage", { pending: 0, dirty: 0, error: null });
  });

  it("keeps the local draft and forbids retry when another author has created a different new version", async () => {
    const storage = await loadDocument(); await loseSave(storage);
    transport.rpc.mockResolvedValueOnce({ revision: 5, value: { canvas: { title: "Other author", nodes: [] } } });
    await event("studio.reconcile"); reconciled("conflict");
    expect(await storage.getItem(key)).toEqual(draft);
    await event("studio.retry"); await vi.advanceTimersByTimeAsync(700);
    expect(transport.rpc).toHaveBeenCalledTimes(3);
    expect(transport.notify).toHaveBeenCalledWith("studio.storage", expect.objectContaining({ pending: 0, error: expect.any(String) }));
  });

  it("does not treat identical content at a later nonadjacent revision as proof of the original save", async () => {
    const storage = await loadDocument(); await loseSave(storage);
    transport.rpc.mockResolvedValueOnce({ revision: 6, value: draft });
    await event("studio.reconcile"); reconciled("conflict");
    await event("studio.retry"); await vi.advanceTimersByTimeAsync(700);
    expect(transport.rpc).toHaveBeenCalledTimes(3); expect(await storage.getItem(key)).toEqual(draft);
  });

  it("fixes the uncertain attempt body while later local edits stay unsent until explicit save at the proven revision", async () => {
    const storage = await loadDocument(); const firstBody = structuredClone(draft);
    await loseSave(storage, firstBody);
    firstBody.canvas.title = "Mutated caller reference";
    await expect(storage.setItem(key, structuredClone(changedDraft))).rejects.toThrow("保存结果尚未确认");
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.rpc).toHaveBeenCalledTimes(2);
    expect(transport.rpc.mock.calls[1]![0].value).toEqual(draft);
    expect(await storage.getItem(key)).toEqual(changedDraft);
    transport.rpc.mockResolvedValueOnce({ revision: 5, value: draft });
    await event("studio.reconcile"); reconciled("unchanged");
    expect(transport.rpc).toHaveBeenCalledTimes(3); expect(await storage.getItem(key)).toEqual(changedDraft);
    transport.rpc.mockResolvedValueOnce({ revision: 6 });
    await event("studio.retry"); await vi.advanceTimersByTimeAsync(350);
    expect(transport.rpc).toHaveBeenNthCalledWith(4, request("state.set", { revision: 5, value: changedDraft }));
    expect(transport.notify).toHaveBeenLastCalledWith("studio.storage", { pending: 0, dirty: 0, error: null });
  });

  it("preserves an unsent later draft when the original revision is unchanged and retries only after operator intent", async () => {
    const storage = await loadDocument(); await loseSave(storage);
    await expect(storage.setItem(key, structuredClone(changedDraft))).rejects.toThrow("保存结果尚未确认");
    transport.rpc.mockResolvedValueOnce({ revision: 4, value: original });
    await event("studio.reconcile"); reconciled("unchanged");
    expect(transport.rpc).toHaveBeenCalledTimes(3);
    transport.rpc.mockResolvedValueOnce({ revision: 5 });
    await event("studio.retry"); await vi.advanceTimersByTimeAsync(350);
    expect(transport.rpc).toHaveBeenNthCalledWith(4, request("state.set", { revision: 4, value: changedDraft }));
  });

  it("confirms a lost remove acknowledgement only through its exact next tombstone revision", async () => {
    const storage = await loadDocument();
    transport.rpc.mockRejectedValueOnce(new Error("Synthetic remove ACK lost"));
    await expect(storage.removeItem(key)).rejects.toThrow("Synthetic remove ACK lost");
    expect(transport.rpc).toHaveBeenNthCalledWith(2, request("state.remove", { revision: 4 }));
    transport.rpc.mockResolvedValueOnce({ revision: 5, value: null });
    await event("studio.reconcile"); reconciled("confirmed");
    expect(await storage.getItem(key)).toBeNull();
    await event("studio.retry"); expect(transport.rpc).toHaveBeenCalledTimes(3);
    transport.rpc.mockResolvedValueOnce({ revision: 6 });
    const saved = storage.setItem(key, structuredClone(changedDraft));
    await vi.advanceTimersByTimeAsync(350); await saved;
    expect(transport.rpc).toHaveBeenNthCalledWith(4, request("state.set", { revision: 5, value: changedDraft }));
  });

  it("does not overwrite another author's new document to recover an uncertain remove", async () => {
    const storage = await loadDocument();
    transport.rpc.mockRejectedValueOnce(new Error("Synthetic remove ACK lost"));
    await expect(storage.removeItem(key)).rejects.toThrow("Synthetic remove ACK lost");
    transport.rpc.mockResolvedValueOnce({ revision: 5, value: { canvas: { title: "Other author" } } });
    await event("studio.reconcile"); reconciled("conflict");
    await event("studio.retry"); expect(transport.rpc).toHaveBeenCalledTimes(3);
  });

  it("compares original media bytes and MIME before confirming a lost media save without resending it", async () => {
    const storage = (await import("./storage")).default.createInstance({ storeName: "image_files" });
    transport.rpc.mockResolvedValueOnce({ revision: 9, value: null }); await storage.getItem("image:original");
    transport.rpc.mockRejectedValueOnce(new Error("Synthetic media ACK lost"));
    await expect(storage.setItem("image:original", new Blob(["original PNG bytes"], { type: "image/png" }))).rejects.toThrow("Synthetic media ACK lost");
    const media = { contentBase64: btoa("original PNG bytes"), mediaType: "image/png" };
    expect(transport.rpc).toHaveBeenNthCalledWith(2, { operation: "state.set", namespace: "image_files", key: "image:original", revision: 9, media });
    transport.rpc.mockResolvedValueOnce({ revision: 10, media });
    await event("studio.reconcile"); reconciled("confirmed");
    expect(transport.rpc).toHaveBeenNthCalledWith(3, { operation: "state.get", namespace: "image_files", key: "image:original" });
    await event("studio.retry"); expect(transport.rpc).toHaveBeenCalledTimes(3);
    expect(await (await storage.getItem<Blob>("image:original"))!.text()).toBe("original PNG bytes");
  });

  it("does not grant retry permission when read-only reconciliation itself fails", async () => {
    const storage = await loadDocument(); await loseSave(storage);
    transport.rpc.mockRejectedValueOnce(new Error("Synthetic current read unavailable"));
    await event("studio.reconcile"); reconciled("conflict");
    await event("studio.retry"); await vi.advanceTimersByTimeAsync(700);
    expect(transport.rpc).toHaveBeenCalledTimes(3); expect(await storage.getItem(key)).toEqual(draft);
  });

  it("keeps readonly hydration echoes as no-ops and blocks changed documents, deletion and media without the current workspace capability", async () => {
    await import("./storage");
    const workspace = { version: 1, scope: "unassigned", contextAuthority: erpSessionAuthority({
      userId: "019f0000-0000-7000-8000-000000000021", tenantId: "019f0000-0000-7000-8000-000000000022",
      permissions: ["design:read", "asset:read"], permissionScopes: { "design:read": "tenant", "asset:read": "tenant" }, dataScope: "tenant",
    }), capabilities: { read: true, save: false, mediaWrite: false, review: false, submit: false, configure: false },
    generation: { enabled: false, code: "operator_paused" } };
    window.dispatchEvent(new CustomEvent("studio.workspace", { detail: { workspace } }));
    // A document from a previous owner cannot supply this owner's CAS baseline.
    const storage = await loadDocument();
    expect(await storage.setItem(key, structuredClone(original))).toEqual(original);
    await expect(storage.setItem(key, structuredClone(changedDraft))).rejects.toThrow("当前项目仅可查看");
    await expect(storage.removeItem(key)).rejects.toThrow("当前项目仅可查看");
    expect(await storage.getItem(key)).toEqual(original); expect(transport.rpc).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new CustomEvent("studio.workspace", { detail: { workspace: {
      ...workspace, capabilities: { ...workspace.capabilities, save: true },
    } } }));
    const images = storage.createInstance({ storeName: "image_files" });
    transport.rpc.mockResolvedValueOnce({ revision: 3, value: null }); await images.getItem("image:readonly");
    await expect(images.setItem("image:readonly", new Blob(["synthetic original"], { type: "image/png" }))).rejects.toThrow("当前项目仅可查看");
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.rpc.mock.calls.map(([input]) => input.operation)).toEqual(["state.get", "state.get"]);
  });
});
