import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { STUDIO_IMAGE_DRAFT_KEY, STUDIO_VIDEO_DRAFT_KEY } from "@yummyai/contracts/pod/studio-document-transfer";
import type { StudioWorkspace } from "@yummyai/contracts/pod/studio-personal";
import { readDraftDocument, type WorkbenchDraftDocument } from "./workbench-draft";

const transport = vi.hoisted(() => ({
  rpc: vi.fn<(request: Record<string, unknown>) => Promise<unknown>>(),
  notify: vi.fn<(type: string, payload: Record<string, unknown>) => void>(),
  initialWorkspace: undefined as unknown,
  channel: "synthetic-draft-recovery-channel",
}));
vi.mock("./rpc", () => ({ initialized: Promise.resolve({ workspace: transport.initialWorkspace }), channel: transport.channel, rpc: transport.rpc, notify: transport.notify }));

const original: WorkbenchDraftDocument = {
  version: 1, activeId: "synthetic-input",
  drafts: [{ id: "synthetic-input", prompt: "合成原稿", references: [], config: { size: "1:1" } }],
};
const firstPrompt = "合成已提交输入 A", laterPrompt = "合成失败后继续编辑 B", newestPrompt = "合成明确保存期间继续编辑 C";
const lostAck = "合成原 A 已提交但保存回执丢失", notSubmitted = "合成原 A 尚未提交 保存连接中断";
const parentOrigin = "http://localhost:3000", syntheticParent = {};
const baseWorkspace: StudioWorkspace = {
  version: 1, scope: "unassigned", documentTransferVersion: 1,
  contextAuthority: erpSessionAuthority({
    userId: "019f0000-0000-7000-8000-000000000021", tenantId: "019f0000-0000-7000-8000-000000000022",
    permissions: ["design:read", "design:write", "asset:read", "asset:write"], dataScope: "self",
  }),
  capabilities: { read: true, save: true, mediaWrite: true, review: false, submit: false, configure: false },
  generation: { enabled: false, code: "operator_paused" },
};
type RemoteDocument = { revision: number; value: WorkbenchDraftDocument };
type DraftKey = typeof STUDIO_IMAGE_DRAFT_KEY | typeof STUDIO_VIDEO_DRAFT_KEY;
const releases: Array<() => void> = [], releaseResponses: Array<() => void> = [];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function documentWith(prompt: string) { const value = structuredClone(original); value.drafts[0]!.prompt = prompt; return value; }
const ownerOf = (workspace: StudioWorkspace) => JSON.stringify([workspace.scope, workspace.contextAuthority]);

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("location", { search: "?parentOrigin=" + encodeURIComponent(parentOrigin) });
  vi.stubGlobal("parent", syntheticParent);
  transport.initialWorkspace = structuredClone(baseWorkspace);
  transport.rpc.mockReset(); transport.notify.mockReset();
});
afterEach(async () => {
  // Invalidate every real producer before releasing any synthetic late response.
  for (const release of releases.splice(0).reverse()) release();
  for (const release of releaseResponses.splice(0)) release();
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

async function fixture(options: { key?: DraftKey; firstWrite?: "committed" | "unsubmitted" | "acknowledged" } = {}) {
  const key = options.key ?? STUDIO_IMAGE_DRAFT_KEY;
  let workspace = structuredClone(baseWorkspace), writeCount = 0;
  const remotes = new Map<string, RemoteDocument>();
  const address = () => workspace.scope + "/" + key;
  const remoteAt = () => {
    const at = address(); let value = remotes.get(at);
    if (!value) { value = { revision: 4, value: structuredClone(original) }; remotes.set(at, value); }
    return value;
  };
  type ReadGate = { response: ReturnType<typeof deferred<RemoteDocument>>; snapshot?: RemoteDocument };
  type WriteGate = { response: ReturnType<typeof deferred<void>>; started: boolean };
  let nextRead: ReadGate | undefined, nextWriteAck: WriteGate | undefined, nextReadFailure: string | undefined;
  transport.rpc.mockImplementation(async request => {
    if (request.namespace !== "app_state" || request.key !== key) throw new Error("Unexpected synthetic storage address");
    if (request.operation === "state.get") {
      if (nextReadFailure) { const message = nextReadFailure; nextReadFailure = undefined; throw new Error(message); }
      const snapshot = structuredClone(remoteAt()), held = nextRead;
      if (!held) return snapshot;
      nextRead = undefined; held.snapshot = snapshot;
      // The old body may arrive even after its original owner has gone.
      return held.response.promise;
    }
    if (request.operation !== "state.set") throw new Error("Unexpected synthetic storage operation");
    const remote = remoteAt();
    if (request.revision !== remote.revision) throw new Error("Synthetic CAS conflict");
    writeCount++;
    if (writeCount === 1 && options.firstWrite === "unsubmitted") throw new Error(notSubmitted);
    const committed = { revision: remote.revision + 1, value: readDraftDocument(request.value) };
    remotes.set(address(), committed);
    // Losing the ACK does not roll back the actual attempted document.
    if (writeCount === 1 && options.firstWrite !== "acknowledged") throw new Error(lostAck);
    const held = nextWriteAck;
    if (held) { nextWriteAck = undefined; held.started = true; await held.response.promise; }
    return { revision: committed.revision };
  });
  const open = async () => {
    const storage = await import("./storage");
    const { createStoredWorkbenchDraft } = await import("./workbench-draft-persistence");
    await Promise.resolve();
    let current = true;
    const controller = createStoredWorkbenchDraft({
      key, owner: ownerOf(workspace), current: () => current,
      available: () => workspace.documentTransferVersion === 1,
      canSave: () => workspace.capabilities.save,
      id: () => "synthetic-new-input", config: () => ({ size: "1:1" }),
    });
    const stop = () => { current = false; controller.stop(); };
    releases.push(stop); await controller.load();
    return { controller, storage, stop };
  };
  const opened = await open();
  expect(opened.controller.active()?.prompt).toBe(original.drafts[0]!.prompt);
  return {
    ...opened, remote: () => structuredClone(remoteAt()),
    replaceRemote: (revision: number, value: WorkbenchDraftDocument) => remotes.set(address(), { revision, value: structuredClone(value) }),
    workspace: () => structuredClone(workspace),
    failNextRead() { nextReadFailure = "Synthetic original read-only GET failed"; },
    changeWorkspace(next: StudioWorkspace) {
      workspace = structuredClone(next);
      window.dispatchEvent(new CustomEvent("studio.workspace", { detail: { workspace } }));
    },
    holdNextRead() {
      const held: ReadGate = { response: deferred<RemoteDocument>() }; nextRead = held;
      releaseResponses.push(() => { if (held.snapshot) held.response.resolve(structuredClone(held.snapshot)); });
      return { started: () => !!held.snapshot, release() {
        if (!held.snapshot) throw new Error("Synthetic held GET has not started");
        held.response.resolve(structuredClone(held.snapshot));
      } };
    },
    holdNextWriteAcknowledgement() {
      const held: WriteGate = { response: deferred<void>(), started: false }; nextWriteAck = held;
      releaseResponses.push(() => held.response.resolve(undefined));
      return { started: () => held.started, release: () => held.response.resolve(undefined) };
    },
    async reload() {
      opened.stop(); vi.resetModules();
      // The new runtime has no old cache/listeners: load must use the CAS remote.
      vi.stubGlobal("window", new EventTarget());
      transport.initialWorkspace = structuredClone(workspace);
      return open();
    },
  };
}
const writes = () => transport.rpc.mock.calls.filter(([request]) => request.operation === "state.set").map(([request]) => request);
const reads = () => transport.rpc.mock.calls.filter(([request]) => request.operation === "state.get");
const latestMessage = (type: string) => transport.notify.mock.calls.filter(([name]) => name === type).at(-1)?.[1] ?? {};
async function event(type: "studio.reconcile" | "studio.retry") { window.dispatchEvent(new Event(type)); await vi.advanceTimersByTimeAsync(0); }
function clear() {
  const message = Object.assign(new Event("message"), { source: syntheticParent, origin: parentOrigin, data: { type: "studio.clear", channel: transport.channel } });
  window.dispatchEvent(message);
}
async function loseAcknowledgement(f: Awaited<ReturnType<typeof fixture>>, submitted = true) {
  f.controller.update({ prompt: firstPrompt });
  await vi.advanceTimersByTimeAsync(350);
  await expect(f.controller.flush()).rejects.toThrow(submitted ? lostAck : notSubmitted);
  expect(writes()).toHaveLength(1);
  expect(writes()[0]).toMatchObject({ revision: 4, value: { drafts: [{ prompt: firstPrompt }] } });
  expect(f.remote()).toEqual({ revision: submitted ? 5 : 4, value: submitted ? documentWith(firstPrompt) : original });
}
async function denyInitialDispatch(f: Awaited<ReturnType<typeof fixture>>) {
  const writable = f.workspace(), readonly = { ...writable, capabilities: { ...writable.capabilities, save: false } };
  f.controller.update({ prompt: firstPrompt });
  await vi.advanceTimersByTimeAsync(0); f.changeWorkspace(readonly);
  await vi.advanceTimersByTimeAsync(350);
  await expect(f.controller.flush()).rejects.toThrow("仅可查看");
  expect(writes()).toEqual([]); expect(f.remote()).toEqual({ revision: 4, value: original });
  expectCurrentDirty(firstPrompt, f);
  f.changeWorkspace(writable); await vi.advanceTimersByTimeAsync(700);
  expect(writes()).toEqual([]); expectCurrentDirty(firstPrompt, f);
}
function expectCurrentDirty(prompt: string, f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.controller.active()?.prompt).toBe(prompt);
  expect(latestMessage("studio.storage").dirty).toBeGreaterThan(0);
}

describe("workbench controller and actual storage recovery", () => {
  it("does not confirm current input B when only original A is proven committed after its ACK was lost", async () => {
    const f = await fixture(); await loseAcknowledgement(f);
    const attemptedA = structuredClone(writes()[0]);
    f.controller.update({ prompt: laterPrompt });
    await vi.advanceTimersByTimeAsync(700);
    expect(writes()).toEqual([attemptedA]); expect(f.controller.active()?.prompt).toBe(laterPrompt);

    await event("studio.reconcile");
    expect(reads()).toHaveLength(2); expect(writes()).toEqual([attemptedA]);
    expect(f.remote()).toEqual({ revision: 5, value: documentWith(firstPrompt) });
    expect(f.controller.active()?.prompt).toBe(laterPrompt);
    await expect(f.storage.flushStudioStorage()).rejects.toThrow();
    expect.soft(latestMessage("studio.reconciled")).toMatchObject({ result: "unchanged" });
    expect.soft(latestMessage("studio.storage")).toMatchObject({ pending: 0 });
    expect.soft(latestMessage("studio.storage").dirty).toBeGreaterThan(0);
  });

  it("releases the controller and global flush after read-only confirmation of A when no later edit exists", async () => {
    const f = await fixture(); await loseAcknowledgement(f);
    const attemptedA = structuredClone(writes()[0]);
    await event("studio.reconcile");
    expect(reads()).toHaveLength(2); expect(writes()).toEqual([attemptedA]);
    expect(latestMessage("studio.reconciled")).toMatchObject({ result: "confirmed" });
    expect(f.remote()).toEqual({ revision: 5, value: documentWith(firstPrompt) });
    await expect.soft(f.storage.flushStudioStorage()).resolves.toBeUndefined();
    expect.soft(f.controller.snapshot().error).toBe("");
    expect.soft(latestMessage("studio.storage")).toMatchObject({ pending: 0, dirty: 0, error: null });
    expect(writes()).toEqual([attemptedA]); expect(f.controller.active()?.prompt).toBe(firstPrompt);
  });

  it("saves B once at original CAS4 only after proving A was never submitted and an explicit controller retry", async () => {
    const f = await fixture({ firstWrite: "unsubmitted" }); await loseAcknowledgement(f, false);
    const attemptedA = structuredClone(writes()[0]); f.controller.update({ prompt: laterPrompt });
    await event("studio.retry");
    expect(writes()).toEqual([attemptedA]); expect(() => f.controller.retrySave()).toThrow("只读核对");
    await event("studio.reconcile");
    expect(latestMessage("studio.reconciled")).toMatchObject({ result: "unchanged" });
    expectCurrentDirty(laterPrompt, f); expect(writes()).toEqual([attemptedA]);
    const saved = f.controller.retrySave(); await vi.advanceTimersByTimeAsync(350); await saved;
    expect(writes()).toEqual([attemptedA, { operation: "state.set", namespace: "app_state", key: STUDIO_IMAGE_DRAFT_KEY, revision: 4, value: documentWith(laterPrompt) }]);
    expect(f.remote()).toEqual({ revision: 5, value: documentWith(laterPrompt) });
    await expect(f.storage.flushStudioStorage()).resolves.toBeUndefined();
    const count = reads().length, reopened = await f.reload();
    expect(reads()).toHaveLength(count + 1); expect(reopened.controller.snapshot().document).toEqual(documentWith(laterPrompt));
    expect(writes()).toHaveLength(2);
  });

  it.each([
    { name: "another document at revision5", revision: 5, prompt: "合成其他编辑者的原稿" },
    { name: "identical A at nonadjacent revision6", revision: 6, prompt: firstPrompt },
  ])("keeps B and blocks both retry entry points for $name", async ({ revision, prompt }) => {
    const f = await fixture(); await loseAcknowledgement(f);
    const attemptedA = structuredClone(writes()[0]); f.controller.update({ prompt: laterPrompt });
    f.replaceRemote(revision, documentWith(prompt)); await event("studio.reconcile");
    expect(latestMessage("studio.reconciled")).toMatchObject({ result: "conflict" });
    expectCurrentDirty(laterPrompt, f); expect(() => f.controller.retrySave()).toThrow("只读核对");
    await event("studio.retry"); await vi.advanceTimersByTimeAsync(700);
    await expect(f.storage.flushStudioStorage()).rejects.toThrow();
    expect(writes()).toEqual([attemptedA]); expect(f.remote()).toEqual({ revision, value: documentWith(prompt) });
    const count = reads().length; await f.controller.load();
    expect(reads()).toHaveLength(count); expect(f.controller.active()?.prompt).toBe(laterPrompt);
  });

  it("compares the latest local edit made while the original read-only reconciliation is in flight", async () => {
    const f = await fixture(); await loseAcknowledgement(f);
    const attemptedA = structuredClone(writes()[0]), held = f.holdNextRead();
    await event("studio.reconcile"); expect(held.started()).toBe(true);
    f.controller.update({ prompt: laterPrompt }); f.controller.update({ prompt: newestPrompt });
    held.release(); await vi.advanceTimersByTimeAsync(0);
    expect(latestMessage("studio.reconciled")).toMatchObject({ result: "unchanged" });
    expectCurrentDirty(newestPrompt, f); expect(writes()).toEqual([attemptedA]);
    await expect(f.storage.flushStudioStorage()).rejects.toThrow();
    const saved = f.controller.retrySave(); await vi.advanceTimersByTimeAsync(350); await saved;
    expect(writes()[0]).toEqual(attemptedA); expect(writes()[1]).toMatchObject({ revision: 5, value: documentWith(newestPrompt) });
    expect(f.remote()).toEqual({ revision: 6, value: documentWith(newestPrompt) });
    await expect(f.storage.flushStudioStorage()).resolves.toBeUndefined();
  });

  it.each(["scope", "authority", "CLEAR"] as const)("does not adopt a late original proof after %s invalidates its actual storage owner", async change => {
    const f = await fixture(); await loseAcknowledgement(f); f.controller.update({ prompt: laterPrompt });
    const attemptedA = structuredClone(writes()[0]), held = f.holdNextRead();
    await event("studio.reconcile"); expect(held.started()).toBe(true);
    if (change === "CLEAR") clear();
    else {
      const workspace = f.workspace();
      if (change === "scope") workspace.scope = "019f0000-0000-7000-8000-000000000023";
      else workspace.contextAuthority = erpSessionAuthority({ userId: "019f0000-0000-7000-8000-000000000024", tenantId: "019f0000-0000-7000-8000-000000000022", permissions: ["design:read"], dataScope: "self" });
      f.changeWorkspace(workspace);
    }
    const messagesAtInvalidation = transport.notify.mock.calls.length;
    held.release(); await vi.advanceTimersByTimeAsync(700);
    expect(transport.notify.mock.calls).toHaveLength(messagesAtInvalidation); expect(writes()).toEqual([attemptedA]);
    expect(() => f.controller.update({ prompt: newestPrompt })).toThrow("归属已变化");
    expect(() => f.controller.retrySave()).toThrow("归属已变化");
    await expect(f.controller.flush()).rejects.toThrow("归属已变化");
    await event("studio.retry"); expect(writes()).toEqual([attemptedA]);
  });

  it("rejects a revoked retry at its entry and rechecks save authority before a proven queued B write dispatches", async () => {
    const f = await fixture(); await loseAcknowledgement(f);
    const attemptedA = structuredClone(writes()[0]); f.controller.update({ prompt: laterPrompt });
    await event("studio.reconcile");
    const writable = f.workspace(), readonly = { ...writable, capabilities: { ...writable.capabilities, save: false } };
    f.changeWorkspace(readonly);
    expect(() => f.controller.retrySave()).toThrow("只读核对");
    await event("studio.retry"); await vi.advanceTimersByTimeAsync(700);
    expect(writes()).toEqual([attemptedA]); expectCurrentDirty(laterPrompt, f);
    f.changeWorkspace(writable);
    await vi.advanceTimersByTimeAsync(700); expect(writes()).toEqual([attemptedA]);
    const saving = Promise.resolve(f.controller.retrySave()), denied = expect(saving).rejects.toThrow("仅可查看");
    await vi.advanceTimersByTimeAsync(0); f.changeWorkspace(readonly);
    await vi.advanceTimersByTimeAsync(350); await denied;
    expect(writes()).toEqual([attemptedA]); expectCurrentDirty(laterPrompt, f);
    await expect(f.storage.flushStudioStorage()).rejects.toThrow();
  });

  it("explicitly saves a never-dispatched draft after same-owner save permission returns without automatic POSTs", async () => {
    const f = await fixture({ firstWrite: "acknowledged" });
    await denyInitialDispatch(f); const before = reads().length;
    await event("studio.reconcile");
    expect(reads()).toHaveLength(before + 1);
    expect(reads().at(-1)?.[0]).toEqual({ operation: "state.get", namespace: "app_state", key: STUDIO_IMAGE_DRAFT_KEY });
    expect(writes()).toEqual([]); expect(f.remote()).toEqual({ revision: 4, value: original });
    expect.soft(latestMessage("studio.reconciled")).toMatchObject({ result: "unchanged" });
    expectCurrentDirty(firstPrompt, f);
    const saved = f.controller.retrySave(); await vi.advanceTimersByTimeAsync(350); await saved;
    expect(writes()).toEqual([{ operation: "state.set", namespace: "app_state", key: STUDIO_IMAGE_DRAFT_KEY, revision: 4, value: documentWith(firstPrompt) }]);
    expect(f.remote()).toEqual({ revision: 5, value: documentWith(firstPrompt) });
    await expect(f.storage.flushStudioStorage()).resolves.toBeUndefined();
    expect(latestMessage("studio.storage")).toMatchObject({ pending: 0, dirty: 0, error: null });
    const count = reads().length, reopened = await f.reload();
    expect(reads()).toHaveLength(count + 1); expect(reopened.controller.snapshot().document).toEqual(documentWith(firstPrompt));
    expect(writes()).toHaveLength(1);
  });

  it("rejects a never-dispatched retry when another author saved identical A at CAS5", async () => {
    const f = await fixture({ firstWrite: "acknowledged" }); await denyInitialDispatch(f);
    f.replaceRemote(5, documentWith(firstPrompt)); const before = reads().length;
    await event("studio.reconcile");
    expect(reads()).toHaveLength(before + 1);
    expect(reads().at(-1)?.[0]).toEqual({ operation: "state.get", namespace: "app_state", key: STUDIO_IMAGE_DRAFT_KEY });
    expect(latestMessage("studio.reconciled")).toMatchObject({ result: "conflict" });
    expectCurrentDirty(firstPrompt, f); expect(() => f.controller.retrySave()).toThrow("只读核对");
    await event("studio.retry"); await vi.advanceTimersByTimeAsync(700);
    await expect(f.storage.flushStudioStorage()).rejects.toThrow();
    expect(writes()).toEqual([]); expect(f.remote()).toEqual({ revision: 5, value: documentWith(firstPrompt) });
  });

  it("keeps both never-dispatched retry entry points closed when the original read-only GET fails", async () => {
    const f = await fixture({ firstWrite: "acknowledged" }); await denyInitialDispatch(f);
    f.failNextRead(); const before = reads().length;
    await event("studio.reconcile");
    expect(reads()).toHaveLength(before + 1);
    expect(reads().at(-1)?.[0]).toEqual({ operation: "state.get", namespace: "app_state", key: STUDIO_IMAGE_DRAFT_KEY });
    expect(latestMessage("studio.reconciled")).toMatchObject({ result: "conflict" });
    expectCurrentDirty(firstPrompt, f); expect(() => f.controller.retrySave()).toThrow("只读核对");
    await event("studio.retry"); await vi.advanceTimersByTimeAsync(700);
    await expect(f.storage.flushStudioStorage()).rejects.toThrow();
    expect(writes()).toEqual([]); expect(f.remote()).toEqual({ revision: 4, value: original });
  });

  it("requires a fresh original A proof after a proven B retry never dispatches because save permission was revoked", async () => {
    const f = await fixture(); await loseAcknowledgement(f);
    const attemptedA = structuredClone(writes()[0]); f.controller.update({ prompt: laterPrompt });
    await event("studio.reconcile");
    const writable = f.workspace(), readonly = { ...writable, capabilities: { ...writable.capabilities, save: false } };
    const saving = Promise.resolve(f.controller.retrySave()), denied = expect(saving).rejects.toThrow("仅可查看");
    await vi.advanceTimersByTimeAsync(0); f.changeWorkspace(readonly);
    await vi.advanceTimersByTimeAsync(350); await denied;
    expect(writes()).toEqual([attemptedA]); expectCurrentDirty(laterPrompt, f);
    f.changeWorkspace(writable); await vi.advanceTimersByTimeAsync(700);
    expect(() => f.controller.retrySave()).toThrow("只读核对");
    await event("studio.retry"); expect(writes()).toEqual([attemptedA]);
    const before = reads().length; await event("studio.reconcile");
    expect(reads()).toHaveLength(before + 1); expect(latestMessage("studio.reconciled")).toMatchObject({ result: "unchanged" });
    expect(writes()).toEqual([attemptedA]); expectCurrentDirty(laterPrompt, f);
    const saved = f.controller.retrySave(); await vi.advanceTimersByTimeAsync(350); await saved;
    expect(writes()).toEqual([attemptedA, { operation: "state.set", namespace: "app_state", key: STUDIO_IMAGE_DRAFT_KEY, revision: 5, value: documentWith(laterPrompt) }]);
    expect(f.remote()).toEqual({ revision: 6, value: documentWith(laterPrompt) });
    await expect(f.storage.flushStudioStorage()).resolves.toBeUndefined();
    expect(latestMessage("studio.storage")).toMatchObject({ pending: 0, dirty: 0, error: null });
  });

  it("keeps C dirty when an older explicit B save is acknowledged and drains C through the real global flush", async () => {
    const f = await fixture(); await loseAcknowledgement(f);
    const attemptedA = structuredClone(writes()[0]); f.controller.update({ prompt: laterPrompt }); await event("studio.reconcile");
    const held = f.holdNextWriteAcknowledgement(), savingB = f.controller.retrySave();
    await vi.advanceTimersByTimeAsync(350); expect(held.started()).toBe(true);
    const attemptedB = structuredClone(writes()[1]);
    expect(attemptedB).toMatchObject({ revision: 5, value: documentWith(laterPrompt) });
    f.controller.update({ prompt: newestPrompt }); expect(f.remote()).toEqual({ revision: 6, value: documentWith(laterPrompt) });
    held.release(); await vi.advanceTimersByTimeAsync(0); await savingB;
    expectCurrentDirty(newestPrompt, f); expect(writes()).toEqual([attemptedA, attemptedB]);
    const complete = f.storage.flushStudioStorage(); await vi.advanceTimersByTimeAsync(350); await complete;
    expect(writes()).toEqual([attemptedA, attemptedB, { operation: "state.set", namespace: "app_state", key: STUDIO_IMAGE_DRAFT_KEY, revision: 6, value: documentWith(newestPrompt) }]);
    expect(f.remote()).toEqual({ revision: 7, value: documentWith(newestPrompt) });
    expect(latestMessage("studio.storage")).toMatchObject({ pending: 0, dirty: 0, error: null });
    expect(f.controller.snapshot().document).toEqual(documentWith(newestPrompt));
    const count = reads().length, reopened = await f.reload();
    expect(reads()).toHaveLength(count + 1); expect(reopened.controller.snapshot().document).toEqual(documentWith(newestPrompt));
    expect(writes()).toHaveLength(3);
  });

  it("retains an unmounted video producer and lets the host retry save its latest B before a fresh remote read", async () => {
    const f = await fixture({ key: STUDIO_VIDEO_DRAFT_KEY }), listener = vi.fn(), unsubscribe = f.controller.subscribe(listener);
    await loseAcknowledgement(f); const attemptedA = structuredClone(writes()[0]);
    f.controller.update({ prompt: laterPrompt }); unsubscribe(); const rendered = listener.mock.calls.length;
    // A normal unmount removes the view subscription, not its five-tool owner.
    await event("studio.reconcile");
    expectCurrentDirty(laterPrompt, f); expect(writes()).toEqual([attemptedA]);
    await expect(f.storage.flushStudioStorage()).rejects.toThrow();
    await event("studio.retry"); await vi.advanceTimersByTimeAsync(350);
    await expect(f.storage.flushStudioStorage()).resolves.toBeUndefined();
    expect(writes()).toEqual([attemptedA, { operation: "state.set", namespace: "app_state", key: STUDIO_VIDEO_DRAFT_KEY, revision: 5, value: documentWith(laterPrompt) }]);
    expect(f.remote()).toEqual({ revision: 6, value: documentWith(laterPrompt) });
    expect(listener).toHaveBeenCalledTimes(rendered); expect(f.controller.snapshot().error).toBe("");
    const count = reads().length, reopened = await f.reload();
    expect(reads()).toHaveLength(count + 1); expect(reopened.controller.snapshot().document).toEqual(documentWith(laterPrompt));
    expect(writes()).toHaveLength(2);
  });
});
