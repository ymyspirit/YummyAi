import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider, Outlet, useLocation, useParams } from "react-router-dom";
import { lazy, Suspense, useEffect } from "react";
import { StudioToolSchema } from "@yummyai/contracts/pod/creative-studio";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "@/styles/globals.css";
import "./erp.css";
import i18n from "@/i18n";
import { AppProviders } from "@/components/layout/app-providers";
import { useConfigStore, defaultConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { applyCatalogueProjection, mergeStudioCatalogue } from "./asset-catalogue";
import { channel, initialized, notify, openSettings, rpc } from "./rpc";
import { flushStudioStorage } from "./storage";
import { applyStudioWorkspace, useStudioModels } from "./model-state";
import { createStudioVideoAdmission } from "./video-admission";
import { studioVideoRoute } from "./video-route";
import { projectStudioModels, studioModelCatalogue } from "./model-selection";
import { bindStudioModelLifecycle } from "./model-selection-lifecycle";

const CanvasPage = lazy(() => import("@/pages/canvas"));
const CanvasProjectPage = lazy(() => import("@/pages/canvas/project"));
function CanvasProjectRoute() { const { id } = useParams(); return <CanvasProjectPage key={id} />; }
const ImagePage = lazy(() => import("@/pages/image"));
const VideoPage = lazy(() => import("@/pages/video"));
const AssetsPage = lazy(() => import("@/pages/assets"));
const PromptsPage = lazy(() => import("./prompts-page").then(module => ({ default: module.PromptsPage })));

const init = await initialized;
const videoAdmission = createStudioVideoAdmission(init.scope, channel);
videoAdmission.workspace(init.workspace);
videoAdmission.receive({ type: "studio.video-admission", channel, scope: init.scope, contextAuthority: init.workspace?.contextAuthority, admission: (init as typeof init & { videoAdmission?: unknown }).videoAdmission });
let flushing = false;
window.addEventListener("message", event => {
  if (event.source === parent && event.origin === new URLSearchParams(location.search).get("parentOrigin")) videoAdmission.receive(event.data);
  if (event.source !== parent || event.origin !== new URLSearchParams(location.search).get("parentOrigin") || event.data?.channel !== channel || event.data?.type !== "studio.flush" || typeof event.data.id !== "string") return;
  const id: string = event.data.id;
  if (flushing) { notify("studio.flushed", { id, error: "正在保存全部创作输入 请稍候" }); return; }
  flushing = true;
  void flushStudioStorage().then(() => notify("studio.flushed", { id, ok: true }), cause => notify("studio.flushed", { id, error: cause instanceof Error ? cause.message : "创作输入尚未保存" })).finally(() => { flushing = false; });
});
applyStudioWorkspace(init.workspace, init.scope);
bindStudioModelLifecycle({ target: window, source: parent, origin: new URLSearchParams(location.search).get("parentOrigin") ?? "", channel, scope: init.scope,
  onWorkspace: workspace => { const changed = applyStudioWorkspace(workspace, init.scope); videoAdmission.workspace(workspace); if (changed) void refreshModels(); },
  onClear: () => { studioModelCatalogue.configure(""); videoAdmission.workspace(undefined); useStudioModels.setState({ executionAllowed: false, executionReason: "本人创作会话已清除 请从 ERP 重新打开", canSave: false, canConfigure: false }); },
});
await i18n.changeLanguage("zh-CN");
useThemeStore.getState().setTheme(init.theme);
useConfigStore.setState({ config: projectStudioModels({ ...defaultConfig, channelMode: "remote", channels: [], models: [], baseUrl: "", apiKey: "", model: "", imageModel: "", videoModel: "", textModel: "", audioModel: "", count: "1", canvasImageCount: "1", videoSeconds: "4", size: init.tool === "video" ? "16:9" : "1:1", proxyEnabled: false, proxyUrl: "" }, []) });
async function syncAssets() {
  if (!useAssetStore.getState().hydrated) await new Promise<void>(resolve => { const unsub = useAssetStore.subscribe(state => { if (state.hydrated) { unsub(); resolve(); } }); });
  const stored = await rpc<Array<{ key: string; namespace: string; assetId: string; fileName: string; mediaType: string }>>({ operation: "assets" });
  // The catalogue contains metadata only. Cards request small previews as they
  // enter view; inserting, downloading or inspecting an asset reads its original.
  const latest = useAssetStore.getState().assets, next = mergeStudioCatalogue(latest, stored, new Date().toISOString());
  if (next !== latest) applyCatalogueProjection(() => useAssetStore.getState().replaceAssets(next));
}
function refreshAssets() { void syncAssets().catch(cause => notify("studio.error", { error: cause instanceof Error ? cause.message : "素材读取失败" })); }
refreshAssets();
function refreshModels() {
  const owner = studioModelCatalogue.snapshot().owner;
  return studioModelCatalogue.load(signal => rpc({ operation: "models" }, { signal })).then(models => {
    const current = studioModelCatalogue.snapshot();
    if (models && current.owner === owner && current.status === "ready" && current.models === models) useConfigStore.setState({ config: projectStudioModels(useConfigStore.getState().config, models) });
  });
}
window.addEventListener("studio.refresh", () => { void refreshModels(); refreshAssets(); });
window.addEventListener("studio.theme", event => { const theme = (event as CustomEvent).detail.theme; if (theme === "light" || theme === "dark") useThemeStore.getState().setTheme(theme); });
window.addEventListener("studio.backup", () => { void import("@/lib/canvas/canvas-export").then(module => module.exportCanvasProjects(useCanvasStore.getState().projects, "YummyAI-画布备份")).catch(() => notify("studio.error", { error: "备份失败，部分素材尚未读取，请恢复连接后重试" })); });
function Shell() {
  const location = useLocation();
  const models = useStudioModels();
  return <div className={`studio-shell${["image", "video"].includes(location.pathname.split("/")[1]) ? " studio-workbench" : ""}`}>
    {!models.executionAllowed && <div className="studio-model-status studio-execution-paused" role="status">{models.executionReason}</div>}
    {!models.canSave && <div className="studio-model-status studio-execution-paused" role="status">当前项目仅可查看 保存修改需要相应项目权限</div>}
    {models.status !== "ready" && <div className="studio-model-status" role="status">{models.status === "loading" ? "模型配置正在后台读取，画布可继续编辑和保存。" : `${models.error}；画布可继续编辑和保存。`}{models.status === "error" && <button type="button" onClick={() => void refreshModels()}>重试模型配置</button>}</div>}
    <Suspense fallback={<p className="studio-tool-loading" role="status">正在打开工具…</p>}><Outlet /></Suspense>
  </div>;
}
function Settings() { useEffect(() => { openSettings(); }, []); return <p>请在 ERP 的 AI 模型配置中设置模型。</p>; }
function EditorError() {
  useEffect(() => { notify("studio.error", { error: "编辑器未能打开，请重新连接。已保存的画布仍保留在 ERP 中。" }); }, []);
  return <div className="studio-editor-error"><p>编辑器未能打开。</p><button type="button" onClick={() => location.reload()}>重新连接</button></div>;
}
const router = createMemoryRouter([{ element: <Shell />, errorElement: <EditorError />, children: [
  { path: "/canvas", element: <CanvasPage /> }, { path: "/canvas/:id", element: <CanvasProjectRoute /> },
  { path: "/image", element: <ImagePage /> }, studioVideoRoute(videoAdmission, authority => notify("studio.video-required", { scope: init.scope, contextAuthority: authority }), <VideoPage />),
  { path: "/assets", element: <AssetsPage /> }, { path: "/prompts", element: <PromptsPage /> },
  { path: "/config", element: <Settings /> }, { path: "*", element: <CanvasPage /> },
] }], { initialEntries: [`/${init.tool}`] });
// Tool navigation stays inside this runtime. Keep each tool's last location,
// including the open canvas, while the ERP owns the URL and project boundary.
let requestedTool = init.tool, lastLocation = `/${init.tool}`;
const toolLocations = new Map([[init.tool, lastLocation]]);
router.subscribe(({ location }) => {
  const current = `${location.pathname}${location.search}${location.hash}`;
  if (current === lastLocation) return;
  if (lastLocation.split("/")[1] === "video" && location.pathname.split("/")[1] !== "video") videoAdmission.leave();
  lastLocation = current;
  const tool = StudioToolSchema.safeParse(location.pathname.split("/")[1]);
  if (!tool.success) return;
  if (tool.data !== "video") videoAdmission.leave();
  toolLocations.set(tool.data, current);
  if (tool.data === "assets") refreshAssets();
  if (tool.data !== requestedTool) notify("studio.route", { tool: tool.data, fromTool: requestedTool });
});
window.addEventListener("studio.tool", event => {
  const tool = StudioToolSchema.safeParse((event as CustomEvent).detail.tool);
  if (!tool.success) return;
  requestedTool = tool.data;
  if (router.state.location.pathname.split("/")[1] === tool.data) return;
  void router.navigate(toolLocations.get(tool.data) ?? `/${tool.data}`).catch(() => notify("studio.error", { error: "工具未能打开，请重试" }));
});
createRoot(document.getElementById("root")!).render(<AppProviders><RouterProvider router={router} /></AppProviders>);
notify("studio.loaded");
void refreshModels();
