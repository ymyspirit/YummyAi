import { afterEach, describe, expect, it, vi } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import type { StudioWorkspace } from "@yummyai/contracts/pod/studio-personal";
import { bindStudioModelLifecycle } from "./model-selection-lifecycle";
import { applyStudioWorkspace, useStudioModels } from "./model-state";
import { studioModelCatalogue } from "./model-selection";
import { modelSelectionFixtures as models } from "./model-selection-fixtures";

const id = "019a0000-0000-7000-8000-000000000001", source = {} as WindowProxy, origin = "http://localhost:3000", channel = "original-channel";
const workspace = (permissions = ["design:read"]): StudioWorkspace => ({ version: 1, scope: "unassigned",
  contextAuthority: erpSessionAuthority({ tenantId: id, userId: id, permissions, dataScope: "self", teamIds: [] }),
  capabilities: { read: true, save: true, mediaWrite: true, review: false, submit: false, configure: false }, generation: { enabled: false, code: "operator_paused" },
});
function send(target: EventTarget, data: Record<string, unknown>, changed: Record<string, unknown> = {}) {
  const event = new Event("message"); Object.assign(event, { source, origin, data: { channel, ...data }, ...changed }); target.dispatchEvent(event);
}
function mount() {
  const target = new EventTarget(), changed = vi.fn((value: StudioWorkspace) => applyStudioWorkspace(value, "unassigned"));
  const cleared = vi.fn(() => { studioModelCatalogue.configure(""); useStudioModels.setState({ executionAllowed: false, canSave: false, canConfigure: false }); });
  applyStudioWorkspace(workspace(), "unassigned");
  const stop = bindStudioModelLifecycle({ target, source, origin, channel, scope: "unassigned", onWorkspace: changed, onClear: cleared });
  return { target, changed, cleared, stop };
}
afterEach(() => { studioModelCatalogue.configure(""); useStudioModels.setState({ executionAllowed: false, canSave: false, canConfigure: false }); });

describe("production parent-event model ownership binding", () => {
  it("ignores forged CLEAR and actually aborts a held models read on the authenticated parent CLEAR without late revival", async () => {
    const owner = mount(); let release!: (value: unknown) => void, signal!: AbortSignal;
    const pending = studioModelCatalogue.load(captured => { signal = captured; return new Promise(resolve => { release = resolve; }); });
    for (const changed of [{ source: {} }, { origin: "http://localhost:8080" }, { data: { type: "studio.clear", channel: "other" } }]) send(owner.target, { type: "studio.clear" }, changed);
    expect(signal.aborted).toBe(false); expect(owner.cleared).not.toHaveBeenCalled();
    send(owner.target, { type: "studio.clear" }); expect(signal.aborted).toBe(true); expect(owner.cleared).toHaveBeenCalledOnce();
    release(models); await pending; send(owner.target, { type: "studio.workspace", workspace: workspace() });
    expect(studioModelCatalogue.snapshot()).toMatchObject({ owner: "", status: "unavailable", models: [] }); expect(owner.changed).not.toHaveBeenCalled();
    expect(useStudioModels.getState()).toMatchObject({ executionAllowed: false, canSave: false, canConfigure: false }); owner.stop();
  });
  it("keeps real equivalent workspace messages idempotent and fences a pending read for a changed authority or scope", async () => {
    const owner = mount(); let release!: (value: unknown) => void, signal!: AbortSignal;
    const pending = studioModelCatalogue.load(captured => { signal = captured; return new Promise(resolve => { release = resolve; }); });
    send(owner.target, { type: "studio.workspace", workspace: workspace() }); send(owner.target, { type: "studio.workspace", workspace: structuredClone(workspace()) });
    expect(signal.aborted).toBe(false); const original = studioModelCatalogue.snapshot().owner;
    send(owner.target, { type: "studio.workspace", workspace: workspace(["design:read", "design:write"]) });
    expect(signal.aborted).toBe(true); expect(studioModelCatalogue.snapshot().owner).not.toBe(original);
    release(models); await pending; expect(studioModelCatalogue.snapshot().models).toEqual([]);
    send(owner.target, { type: "studio.workspace", workspace: { ...workspace(), scope: id } }); expect(owner.cleared).toHaveBeenCalledOnce();
    expect(studioModelCatalogue.snapshot().owner).toBe(""); owner.stop();
  });
  it("invalidates models and permissions on actual pagehide and rejects later refresh reads", async () => {
    const owner = mount(); await studioModelCatalogue.load(async () => models); owner.target.dispatchEvent(new Event("pagehide"));
    const read = vi.fn(async () => models); await studioModelCatalogue.load(read);
    expect(read).not.toHaveBeenCalled(); expect(owner.cleared).toHaveBeenCalledOnce(); expect(studioModelCatalogue.snapshot().models).toEqual([]);
    owner.stop(); expect(owner.cleared).toHaveBeenCalledOnce();
  });
});
