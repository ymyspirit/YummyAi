import { afterEach, describe, expect, it, vi } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { pollStudioVideo } from "./generation";
import { applyStudioWorkspace, useStudioModels } from "./model-state";
import { rpc } from "./rpc";
import { decodeBlob } from "./storage";

vi.mock("./rpc", () => ({ rpc: vi.fn(), notify: vi.fn() }));
vi.mock("./storage", () => ({ decodeBlob: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); useStudioModels.setState({ executionAllowed: false }); });
describe("paused native video provider boundary", () => {
  it("denies native video polling before any generation.get or media decoding", async () => {
    useStudioModels.setState({ executionAllowed: false, executionReason: "原任务恢复与轮询已暂停" });
    await expect(pollStudioVideo({ id: "original-task", model: "original-model", provider: "openai" })).rejects.toThrow("已暂停");
    expect(rpc).not.toHaveBeenCalled(); expect(decodeBlob).not.toHaveBeenCalled();
  });
  it("discards a held completed result after execution is revoked instead of decoding or returning it", async () => {
    let resolve!: (value: unknown) => void;
    useStudioModels.setState({ executionAllowed: true }); vi.mocked(rpc).mockReturnValueOnce(new Promise(accept => { resolve = accept; }));
    const pending = pollStudioVideo({ id: "original-task", model: "original-model", provider: "openai" }); useStudioModels.setState({ executionAllowed: false });
    resolve({ id: "original-task", status: "completed", contentBase64: "AAAA", mediaType: "video/mp4" });
    await expect(pending).rejects.toThrow(); expect(rpc).toHaveBeenCalledExactlyOnceWith({ operation: "generation.get", id: "original-task" }); expect(decodeBlob).not.toHaveBeenCalled();
  });
  it("keeps a personal workspace paused even after the model catalogue becomes ready", () => {
    const id = "019a0000-0000-7000-8000-000000000001";
    applyStudioWorkspace({ version: 1, scope: "unassigned", contextAuthority: erpSessionAuthority({ tenantId: id, userId: id, permissions: [], dataScope: "self", teamIds: [] }), videoDirectoryVersion: 1, capabilities: { read: true, save: true, mediaWrite: true, review: false, submit: false, configure: false }, generation: { enabled: false, code: "operator_paused" } });
    useStudioModels.setState({ status: "ready" }); expect(useStudioModels.getState()).toMatchObject({ executionAllowed: false, canSave: true, status: "ready" });
  });
});
