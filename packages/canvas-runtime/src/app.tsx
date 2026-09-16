import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider, Outlet, useLocation } from "react-router-dom";
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
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { initialized, notify, openSettings, rpc } from "./rpc";
import { useStudioModels } from "./model-state";

const CanvasPage = lazy(() => import("@/pages/canvas"));
const CanvasProjectPage = lazy(() => import("@/pages/canvas/project"));
const ImagePage = lazy(() => import("@/pages/image"));
const VideoPage = lazy(() => import("@/pages/video"));
const AssetsPage = lazy(() => import("@/pages/assets"));
const PromptsPage = lazy(() => import("./prompts-page").then(module => ({ default: module.PromptsPage })));

const init = await initialized;
await i18n.changeLanguage("zh-CN");
useThemeStore.getState().setTheme(init.theme);
type StudioModel = { id: string; label: string; model: string; capability: "image" | "video" | "text"; isDefault?: boolean };
useConfigStore.setState({ config: { ...defaultConfig, channelMode: "remote", channels: [], models: [], baseUrl: "", apiKey: "", model: "", imageModel: "", videoModel: "", textModel: "", audioModel: "", count: "1", canvasImageCount: "1", videoSeconds: "4", size: init.tool === "video" ? "16:9" : "1:1", proxyEnabled: false, proxyUrl: "" } });
async function syncAssets() {
  if (!useAssetStore.getState().hydrated) await new Promise<void>(resolve => { const unsub = useAssetStore.subscribe(state => { if (state.hydrated) { unsub(); resolve(); } }); });
  const stored = await rpc<Array<{ key: string; assetId: string; fileName: string; mediaType: string }>>({ operation: "assets" });
  const current = useAssetStore.getState().assets, keys = new Set(current.flatMap(asset => asset.kind === "text" ? [] : [asset.data.storageKey]));
  const ids = new Set<string>(), now = new Date().toISOString();
  const added: Asset[] = stored.flatMap(item => {
    if (keys.has(item.key) || ids.has(item.assetId) || current.some(asset => asset.id === item.assetId)) return [];
    ids.add(item.assetId);
    const base = { id: item.assetId, title: item.fileName, tags: [], source: "ERP 素材", coverUrl: "", createdAt: now, updatedAt: now };
    if (item.mediaType.startsWith("image/")) return [{ ...base, kind: "image", data: { dataUrl: "", storageKey: item.key, width: 0, height: 0, bytes: 0, mimeType: item.mediaType } } as Asset];
    if (item.mediaType.startsWith("video/")) return [{ ...base, kind: "video", data: { url: "", storageKey: item.key, width: 0, height: 0, bytes: 0, mimeType: item.mediaType } } as Asset];
    return [];
  });
  if (!added.length) return;
  // The catalogue contains metadata only. Cards request small previews as they
  // enter view; inserting, downloading or inspecting an asset reads its original.
  const latest = useAssetStore.getState().assets;
  const latestKeys = new Set(latest.flatMap(asset => asset.kind === "text" ? [] : [asset.data.storageKey]));
  const additions = added.filter(asset => !latest.some(item => item.id === asset.id) && (asset.kind === "text" || !latestKeys.has(asset.data.storageKey)));
  if (additions.length) useAssetStore.getState().replaceAssets([...additions, ...latest]);
}
function refreshAssets() { void syncAssets().catch(cause => notify("studio.error", { error: cause instanceof Error ? cause.message : "素材读取失败" })); }
refreshAssets();
let modelRefresh: Promise<void> | undefined;
function refreshModels() {
  if (modelRefresh) return modelRefresh;
  useStudioModels.setState({ status: "loading", error: "" });
  modelRefresh = rpc<StudioModel[]>({ operation: "models" }).then(models => {
    const config = useConfigStore.getState().config;
    const options = models.map(model => `${model.id}::${model.model}`);
    const choose = (value: string, capability: StudioModel["capability"]) => {
      const candidates = models.filter(model => model.capability === capability).map(model => `${model.id}::${model.model}`);
      const preferred = models.find(model => model.capability === capability && model.isDefault);
      return candidates.includes(value) ? value : preferred ? `${preferred.id}::${preferred.model}` : candidates[0] ?? "";
    };
    useConfigStore.setState({ config: { ...config,
      channels: models.map(model => ({ id: model.id, name: model.label, baseUrl: "", apiKey: "", apiFormat: "openai" as const, models: [{ name: model.model, capability: model.capability }] })),
      models: options, model: options.includes(config.model) ? config.model : choose("", init.tool === "video" ? "video" : "image"),
      imageModel: choose(config.imageModel, "image"), videoModel: choose(config.videoModel, "video"), textModel: choose(config.textModel, "text"),
    } });
    useStudioModels.setState({ status: "ready", error: "" });
  }).catch(cause => useStudioModels.setState({ status: "error", error: cause instanceof Error ? cause.message : "模型配置读取失败" })).finally(() => { modelRefresh = undefined; });
  return modelRefresh;
}
window.addEventListener("studio.refresh", () => { void refreshModels(); refreshAssets(); });
window.addEventListener("studio.theme", event => { const theme = (event as CustomEvent).detail.theme; if (theme === "light" || theme === "dark") useThemeStore.getState().setTheme(theme); });
window.addEventListener("studio.backup", () => { void import("@/lib/canvas/canvas-export").then(module => module.exportCanvasProjects(useCanvasStore.getState().projects, "YummyAI-画布备份")).catch(() => notify("studio.error", { error: "备份失败，部分素材尚未读取，请恢复连接后重试" })); });
function Shell() {
  const location = useLocation();
  const models = useStudioModels();
  return <div className={`studio-shell${["image", "video"].includes(location.pathname.split("/")[1]) ? " studio-workbench" : ""}`}>
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
  { path: "/canvas", element: <CanvasPage /> }, { path: "/canvas/:id", element: <CanvasProjectPage /> },
  { path: "/image", element: <ImagePage /> }, { path: "/video", element: <VideoPage /> },
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
  lastLocation = current;
  const tool = StudioToolSchema.safeParse(location.pathname.split("/")[1]);
  if (!tool.success) return;
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
