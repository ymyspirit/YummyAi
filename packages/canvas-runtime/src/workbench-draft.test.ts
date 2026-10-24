import { describe, expect, it, vi } from "vitest";
import { createWorkbenchDraft, draftConfig, type WorkbenchDraftDocument } from "./workbench-draft";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const original: WorkbenchDraftDocument = { version: 1, activeId: "target", drafts: [
  { id: "target", prompt: "目标已有输入", references: [], config: { size: "1:1" } },
  { id: "copied", prompt: "来源完整草稿", references: [{ id: "ref", name: "原图", type: "image/png", dataUrl: "", storageKey: "image:original" }], config: { size: "16:9" }, _yummyaiOrigin: { version: 1, executionFrozen: true, sourceScope: "unassigned", requestId: "original-request" } },
] };
function fixture(load: () => Promise<unknown> = async () => structuredClone(original), save = vi.fn<(value: WorkbenchDraftDocument) => Promise<void>>().mockResolvedValue(undefined)) {
  let current = true, canSave = true, canRetry = true, id = 0;
  const controller = createWorkbenchDraft({ load, save, current: () => current, canSave: () => canSave, canRetry: () => canRetry, id: () => `new-${++id}`, config: () => ({ size: "1:1" }) });
  return { controller, save, scopeChanged: () => { current = false; }, revoke: () => { canSave = false; }, retryProof: (proof: boolean) => { canRetry = proof; } };
}

describe("unsent workbench inputs", () => {
  it("hydrates a nonempty target without writing and selects a copied input without replacing the target", async () => {
    const { controller, save } = fixture(); await controller.load();
    expect(save).not.toHaveBeenCalled(); expect(controller.active()?.prompt).toBe("目标已有输入");
    controller.choose("copied"); await controller.flush();
    expect(controller.active()?.references[0]?.storageKey).toBe("image:original");
    expect(save.mock.calls.at(-1)?.[0]).toEqual({ ...original, activeId: "copied" });
    controller.update({ prompt: "编辑副本" }); await controller.flush();
    expect(controller.snapshot().document.drafts[0]).toEqual(original.drafts[0]);
    expect(controller.active()?._yummyaiOrigin).toEqual(original.drafts[1]?._yummyaiOrigin);
  });
  it("drains edits made during an in-flight save even after the native tool unmounts", async () => {
    const first = deferred<void>(), last = deferred<void>(), saved: WorkbenchDraftDocument[] = [];
    const save = vi.fn((value: WorkbenchDraftDocument) => { saved.push(structuredClone(value)); return saved.length === 1 ? first.promise : last.promise; });
    const { controller } = fixture(undefined, save); await controller.load(); const unsubscribe = controller.subscribe(vi.fn());
    controller.update({ prompt: "首段" }); controller.update({ prompt: "完整未提交输入" });
    controller.update({ references: [{ id: "ref-2", name: "引用", type: "image/png", storageKey: "image:new", dataUrl: "blob:display-only" }] });
    unsubscribe(); let complete = false; const barrier = controller.flush().then(() => { complete = true; }); first.resolve();
    await vi.waitFor(() => expect(saved).toHaveLength(2)); expect(complete).toBe(false); last.resolve(); await barrier;
    expect(saved.at(-1)?.drafts[0]).toMatchObject({ prompt: "完整未提交输入", references: [{ storageKey: "image:new", dataUrl: "" }] });
    const reopened = fixture(async () => saved.at(-1)); await reopened.controller.load();
    expect(reopened.controller.active()?.prompt).toBe("完整未提交输入"); expect(reopened.save).not.toHaveBeenCalled();
  });
  it("preserves later text after a lost save acknowledgement and never turns retry-read into overwrite", async () => {
    const fail = deferred<void>(), save = vi.fn<(value: WorkbenchDraftDocument) => Promise<void>>().mockReturnValueOnce(fail.promise).mockResolvedValue(undefined);
    const read = vi.fn(async () => structuredClone(original)), { controller, retryProof } = fixture(read, save); await controller.load();
    controller.update({ prompt: "已发送的输入" }); fail.reject(new Error("Lost original ACK")); await expect(controller.flush()).rejects.toThrow("Lost original ACK");
    controller.update({ prompt: "失败后继续输入" }); await controller.load();
    expect(read).toHaveBeenCalledTimes(1); expect(save).toHaveBeenCalledTimes(1); expect(controller.active()?.prompt).toBe("失败后继续输入");
    await expect(controller.flush()).rejects.toThrow("未确认保存"); retryProof(false);
    expect(() => controller.retrySave()).toThrow("只读核对"); expect(save).toHaveBeenCalledTimes(1);
    retryProof(true); await controller.retrySave(); expect(save.mock.calls[1]?.[0].drafts[0]?.prompt).toBe("失败后继续输入");
  });
  it("cannot adopt an old load or send edits after scope/CLEAR changes", async () => {
    const read = deferred<unknown>(), { controller, save, scopeChanged } = fixture(() => read.promise), loading = controller.load();
    scopeChanged(); controller.stop(); read.resolve(original); await loading;
    expect(controller.snapshot().ready).toBe(false); expect(() => controller.update({ prompt: "旧输入" })).toThrow("归属已变化");
    await expect(controller.flush()).rejects.toThrow("归属已变化"); expect(save).not.toHaveBeenCalled();
  });
  it("does not replace an unreadable source with an empty draft and respects newly revoked save authority", async () => {
    const broken = fixture(async () => JSON.stringify(original)); await broken.controller.load();
    expect(broken.controller.snapshot().error).toContain("未覆盖原记录"); expect(() => broken.controller.create()).toThrow("尚未读取"); expect(broken.save).not.toHaveBeenCalled();
    const current = fixture(); await current.controller.load(); current.revoke(); expect(() => current.controller.choose("copied")).toThrow("仅可查看"); expect(current.save).not.toHaveBeenCalled();
  });
  it("persists only native editable generation fields and excludes channel credentials", () => {
    const input = { model: "native-model", size: "16:9", quality: "high", videoSeconds: "8", apiKey: "synthetic-never-save", baseUrl: "https://invalid.example", channels: [{ apiKey: "synthetic" }] };
    expect(draftConfig("image", input)).toEqual({ model: "native-model", size: "16:9", quality: "high" });
    expect(draftConfig("video", input)).toEqual({ model: "native-model", size: "16:9", videoSeconds: "8" });
  });
});
