import { describe, expect, it } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { createStudioVideoAdmission } from "./video-admission";

const id = "019a0000-0000-7000-8000-000000000001", authority = erpSessionAuthority({ tenantId: id, userId: id, permissions: ["design:read"], dataScope: "self", teamIds: [] });
const workspace = { version: 1, scope: "unassigned", contextAuthority: authority, videoDirectoryVersion: 1, capabilities: { read: true, save: true, mediaWrite: true, review: false, submit: false, configure: false }, generation: { enabled: false, code: "operator_paused" } };
const admission = { version: 1, snapshotHash: "a".repeat(64), total: 1, canOpen: true, mode: "view_only", execution: "paused", blockedEntryIds: [] };
const message = { type: "studio.video-admission", channel: "original-channel", scope: "unassigned", contextAuthority: authority, admission };
describe("runtime native video route admission", () => {
  it("starts denied, rejects old capability and only accepts an owner-bound view-only paused preflight", () => {
    const guard = createStudioVideoAdmission("unassigned", "original-channel"); guard.receive(message); expect(guard.snapshot().allowed).toBe(false);
    guard.workspace({ ...workspace, videoDirectoryVersion: undefined }); guard.receive(message); expect(guard.snapshot().allowed).toBe(false);
    guard.workspace(workspace); guard.receive(message); expect(guard.snapshot().allowed).toBe(true);
    guard.receive({ ...message, admission: { ...admission, execution: "running" } }); expect(guard.snapshot().allowed).toBe(false);
  });
  it("ignores forged channel, source scope and authority rather than granting or revoking another visit", () => {
    const guard = createStudioVideoAdmission("unassigned", "original-channel"); guard.workspace(workspace);
    for (const changed of [{ channel: "other" }, { scope: id }, { contextAuthority: "other" }]) guard.receive({ ...message, ...changed }); expect(guard.snapshot().allowed).toBe(false);
    guard.receive(message); for (const changed of [{ channel: "other" }, { scope: id }, { contextAuthority: "other" }]) guard.receive({ ...message, admission: null, ...changed }); expect(guard.snapshot().allowed).toBe(true);
  });
  it("keeps equivalent workspace echoes idempotent and revokes for a real authority, scope or capability change", () => {
    const guard = createStudioVideoAdmission("unassigned", "original-channel"); guard.workspace(workspace); guard.receive(message); const accepted = guard.snapshot();
    guard.workspace(structuredClone(workspace)); guard.workspace({ ...workspace }); expect(guard.snapshot()).toBe(accepted);
    guard.workspace({ ...workspace, contextAuthority: erpSessionAuthority({ tenantId: id, userId: id, permissions: [], dataScope: "self", teamIds: [] }) }); guard.receive(message); expect(guard.snapshot().allowed).toBe(false);
    guard.workspace(workspace); guard.receive(message); guard.workspace({ ...workspace, scope: id }); guard.receive(message); expect(guard.snapshot().allowed).toBe(false);
    guard.workspace(workspace); guard.receive(message); guard.workspace({ ...workspace, capabilities: { ...workspace.capabilities, read: false } }); guard.receive(message); expect(guard.snapshot().allowed).toBe(false);
  });
  it("requires a new explicit admission after leaving the route or clearing the workspace", () => {
    const guard = createStudioVideoAdmission("unassigned", "original-channel"); guard.workspace(workspace); guard.receive(message); guard.leave(); guard.workspace(workspace); expect(guard.snapshot().allowed).toBe(false);
    guard.receive(message); guard.workspace(undefined); guard.receive(message); expect(guard.snapshot()).toEqual({ allowed: false, authority: "" });
    guard.workspace(workspace); expect(guard.snapshot().allowed).toBe(false);
  });
  it("never admits blocked or structurally contradictory preflight projections", () => {
    const guard = createStudioVideoAdmission("unassigned", "original-channel"); guard.workspace(workspace);
    for (const value of [{ ...admission, canOpen: false, blockedEntryIds: [id] }, { ...admission, blockedEntryIds: [id] }, { ...admission, total: 0, blockedEntryIds: [id], canOpen: false }]) { guard.receive({ ...message, admission: value }); expect(guard.snapshot().allowed).toBe(false); }
  });
});
