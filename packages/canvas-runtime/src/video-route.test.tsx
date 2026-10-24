import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { createStudioVideoAdmission } from "./video-admission";
import { studioVideoRoute } from "./video-route";

const id = "019a0000-0000-7000-8000-000000000001", authority = erpSessionAuthority({ tenantId: id, userId: id, permissions: [], dataScope: "self", teamIds: [] });
const workspace = { version: 1, scope: "unassigned", contextAuthority: authority, videoDirectoryVersion: 1, capabilities: { read: true, save: true, mediaWrite: true, review: false, submit: false, configure: false }, generation: { enabled: false, code: "operator_paused" } };
const message = { type: "studio.video-admission", scope: "unassigned", channel: "current", contextAuthority: authority, admission: { version: 1, snapshotHash: "a".repeat(64), total: 0, canOpen: true, mode: "view_only", execution: "paused", blockedEntryIds: [] } };
describe("actual runtime memory-router native video element", () => {
  it("does not render the native component on initial /video until the original preflight is admitted", () => {
    const admission = createStudioVideoAdmission("unassigned", "current"), native = vi.fn(() => createElement("main", null, "native video")); admission.workspace(workspace);
    const router = createMemoryRouter([studioVideoRoute(admission, vi.fn(), createElement(native))], { initialEntries: ["/video"] });
    expect(renderToStaticMarkup(createElement(RouterProvider, { router }))).toContain('data-studio-video-admitted="false"'); expect(native).not.toHaveBeenCalled();
    admission.receive(message); expect(renderToStaticMarkup(createElement(RouterProvider, { router }))).toContain('data-studio-video-admitted="true"'); expect(native).toHaveBeenCalledOnce(); router.dispose();
  });
  it("uses the same default-deny element for internal memory-router navigation after leaving an admitted visit", async () => {
    const admission = createStudioVideoAdmission("unassigned", "current"), native = vi.fn(() => createElement("main", null, "native video")); admission.workspace(workspace); admission.receive(message); admission.leave();
    const router = createMemoryRouter([{ path: "/image", element: createElement("main", null, "native image") }, studioVideoRoute(admission, vi.fn(), createElement(native))], { initialEntries: ["/image"] });
    await router.navigate("/video"); const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
    expect(html).toContain('data-studio-video-admitted="false"'); expect(html).toContain("返回视频历史检查"); expect(native).not.toHaveBeenCalled(); router.dispose();
  });
});
