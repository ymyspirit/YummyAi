"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Check, Download, FolderOpen, History, RefreshCw, Settings2, X } from "lucide-react";
import { StudioRpcSchema, StudioScopeSchema, StudioToolSchema, type StudioTool } from "@yummyai/contracts/pod/creative-studio";
import { CanvasBriefSchema, CanvasProjectSummarySchema, type CanvasProjectSummary } from "@yummyai/contracts/pod/canvas-bridge";
import { Permission } from "@yummyai/authz/permissions";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { STUDIO_PERSONAL_CLEAR_EVENT, StudioStorageStatusSchema, type StudioWorkspace as Workspace } from "@yummyai/contracts/pod/studio-personal";
import { assertStudioCurrent, recoverStudioRead, studioProject, studioReadDenied, studioScopeUnavailable, studioReadOperations, studioRpc, studioWorkspace, useStudioAccessFence, transientStudioError, StudioApiError, type StudioJob, type StudioRequestContext } from "./studio-api";
import { CreativeExecutionHistoryPanel } from "../execution/creative-execution-history";
import { useErpAccess } from "../identity/erp-access";
import { StudioOriginalRecords } from "./studio-original-records";
import { createStudioAccessChecks } from "./studio-access-check";
import { StudioDocumentTransfer } from "./studio-document-transfer";
import type { StudioVideoPreflight } from "@yummyai/contracts/pod/studio-video-directory";
import { StudioVideoDirectory } from "./studio-video-directory";
import { createStudioVideoRequiredNavigation } from "./studio-video-directory-state";
import { bindStudioModelClear } from "./studio-model-clear";
import { StudioImageGenerationPanel, StudioImagePreparationCleanup } from "./studio-image-generation-panel";
import "./studio.css";

const titles: Record<StudioTool, string> = { canvas: "我的画布", image: "生图工作台", video: "视频创作台", prompts: "提示词库", assets: "我的资产" };
const scopeKey = "yummyai.studio.scope";
export function StudioWorkspace({ tool, runtimeUrl, initialScope, active }: { tool: StudioTool; runtimeUrl: string | null; initialScope?: string; active: boolean }) {
  const access = useErpAccess();
  if (!access.authority || !access.preferenceScope && !access.localDevelopment) return <section className="studio-workspace"><h1>{titles[tool]}</h1><p role="status">正在核对本人创作身份</p></section>;
  return <StudioWorkspaceContent key={JSON.stringify([access.authority, access.preferenceScope])} tool={tool} runtimeUrl={runtimeUrl} initialScope={initialScope} active={active} />;
}
function StudioWorkspaceContent({ tool, runtimeUrl, initialScope, active }: { tool: StudioTool; runtimeUrl: string | null; initialScope?: string; active: boolean }) {
  const access = useStudioAccessFence("workspace"), { capture: captureIdentity, invalidate } = access;
  const router = useRouter(), [rows, setRows] = useState<CanvasProjectSummary[]>([]), [scope, setScope] = useState<string>(), [error, setError] = useState("");
  const [panel, setPanel] = useState<"assets" | "jobs" | null>(null), [blocked, setBlocked] = useState(false), [panelClosing, setPanelClosing] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false), runtimeFlush = useRef<(() => Promise<void>) | undefined>(undefined);
  const [imageBusy, setImageBusy] = useState(false);
  const bindFlush = useCallback((flush?: () => Promise<void>) => { runtimeFlush.current = flush; }, []);
  const flushRuntime = useCallback(async () => { if (!runtimeFlush.current) throw new Error("创作工具尚未完成读取 请保留此页后重试"); await runtimeFlush.current(); }, []);
  const panelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopPanelClose = useCallback(() => { if (panelTimer.current) clearTimeout(panelTimer.current); panelTimer.current = null; setPanelClosing(false); }, []);
  const closePanel = () => {
    stopPanelClose();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setPanel(null); return; }
    setPanelClosing(true); panelTimer.current = setTimeout(() => { panelTimer.current = null; setPanel(null); setPanelClosing(false); }, 160);
  };
  const [recovering, setRecovering] = useState(false), [readAttempt, setReadAttempt] = useState(0);
  const [workspace, setWorkspace] = useState<Workspace>(), [requestedScope, setRequestedScope] = useState(initialScope);
  const [restricted, setRestricted] = useState(false), accessEpoch = useRef(0);
  const search = useSearchParams(), handoff = StudioScopeSchema.safeParse(search.get("reviewOriginal"));
  const handoffOriginal = handoff.success && handoff.data !== "unassigned" ? handoff.data : null;
  const handoffVisit = useRef<string | null>(null);
  const visible = access.available && (!initialScope || !scope || initialScope === scope);
  useEffect(() => {
    if (!active) { handoffVisit.current = null; return; }
    if (tool !== "assets" || !visible || !scope || scope !== initialScope || !handoffOriginal || workspace?.scope !== scope || !workspace.capabilities.read) return;
    const visit = `${scope}:${handoffOriginal}`;
    if (handoffVisit.current === visit) return;
    handoffVisit.current = visit; stopPanelClose(); setPanel("assets");
  }, [active, tool, visible, scope, initialScope, handoffOriginal, workspace?.scope, workspace?.capabilities.read, stopPanelClose]);
  const videoVisit = useRef({ tool, epoch: 0 });
  if (videoVisit.current.tool !== tool) { videoVisit.current = { tool, epoch: videoVisit.current.epoch + (tool === "video" ? 1 : 0) }; }
  const frameOwner = JSON.stringify([scope, access.authority, accessEpoch.current]);
  const videoOwner = JSON.stringify([frameOwner, workspace?.contextAuthority, workspace?.videoDirectoryVersion, videoVisit.current.epoch]);
  const [admittedVideo, setAdmittedVideo] = useState<{ owner: string; value: StudioVideoPreflight }>();
  const [openedFrameOwner, setOpenedFrameOwner] = useState<string>();
  const lastSafeTool = useRef<StudioTool>(tool === "video" ? "image" : tool);
  if (tool !== "video") lastSafeTool.current = tool;
  const receiveVideoAdmission = useCallback((value: StudioVideoPreflight | null) => {
    setAdmittedVideo(prior => value ? { owner: videoOwner, value } : prior?.owner === videoOwner ? undefined : prior);
  }, [videoOwner]);
  const videoAdmission = tool === "video" && workspace?.videoDirectoryVersion === 1 && admittedVideo?.owner === videoOwner ? admittedVideo.value : null;
  const canCreateFrame = !!scope && (tool !== "video" || !!videoAdmission);
  useEffect(() => { if (visible && canCreateFrame && runtimeUrl) setOpenedFrameOwner(frameOwner); }, [visible, canCreateFrame, frameOwner, runtimeUrl]);
  const keepFrame = openedFrameOwner === frameOwner;
  const frameTool = tool === "video" && !videoAdmission ? lastSafeTool.current : tool;
  const rememberedKey = access.localDevelopment ? scopeKey : `${scopeKey}:${access.preferenceScope}`;
  const capture = useCallback((signal?: AbortSignal) => {
    const epoch = accessEpoch.current, context = captureIdentity(signal);
    return { ...context, isCurrent: () => epoch === accessEpoch.current && context.isCurrent() };
  }, [captureIdentity]);
  const forgetScope = useCallback(() => { try { sessionStorage.removeItem(rememberedKey); sessionStorage.removeItem(scopeKey); } catch { /* Project memory is optional and contains only an ID. */ } }, [rememberedKey]);
  const clearRestricted = useCallback(() => {
    accessEpoch.current++; invalidate(); stopPanelClose();
    setScope(undefined); setRows([]); setPanel(null); setBlocked(false); setRecovering(false);
    setWorkspace(undefined);
    setRestricted(true); setError("当前创作资料已不可访问，已清除当前页面内容。");
    forgetScope();
  }, [invalidate, forgetScope, stopPanelClose]);
  useLayoutEffect(() => {
    const clear = () => { accessEpoch.current++; stopPanelClose(); setScope(undefined); setRows([]); setWorkspace(undefined); setPanel(null); setBlocked(false); setRecovering(false); forgetScope(); };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); window.addEventListener(STUDIO_PERSONAL_CLEAR_EVENT, clear);
    return () => { if (panelTimer.current) clearTimeout(panelTimer.current); window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); window.removeEventListener(STUDIO_PERSONAL_CLEAR_EVENT, clear); };
  }, [forgetScope, stopPanelClose]);
  const previousScope = useRef(initialScope), selectedScope = useRef(scope), pendingScope = useRef(requestedScope);
  selectedScope.current = scope; pendingScope.current = requestedScope;
  useLayoutEffect(() => {
    if (previousScope.current === initialScope) return;
    previousScope.current = initialScope;
    // Native tool links omit brief. This keeps the already verified owner's
    // scope rather than treating an ordinary tool switch as a project change.
    if (initialScope === undefined || pendingScope.current === initialScope) return;
    if (selectedScope.current !== initialScope) {
      accessEpoch.current++; invalidate(); stopPanelClose();
      setScope(undefined); setRows([]); setWorkspace(undefined); setPanel(null);
    }
    setRequestedScope(initialScope);
  }, [initialScope, invalidate, stopPanelClose]);
  useEffect(() => {
    if (!access.available) return;
    const controller = new AbortController(), epoch = accessEpoch.current;
    setError(""); setRecovering(false);
    void recoverStudioRead(async signal => {
      const context = capture(signal);
      let remembered: string | null = null; try { remembered = sessionStorage.getItem(rememberedKey); } catch { /* Optional ID memory. */ }
      const preferred = requestedScope ?? remembered ?? "unassigned";
      const selected = StudioScopeSchema.safeParse(preferred).success ? preferred : "unassigned";
      const currentWorkspace = context.localDevelopment ? undefined : await studioWorkspace(selected, context, signal);
      if (currentWorkspace && !currentWorkspace.capabilities.read) throw new StudioApiError("当前本人没有此创作范围的读取权限", 403);
      const list = CanvasProjectSummarySchema.array().parse(await studioProject("projects", signal, context));
      if (selected !== "unassigned" && !list.some(row => row.id === selected)) {
        // The latest-project projection is bounded; absence is not an access decision.
        const brief = CanvasBriefSchema.parse(await studioProject(`briefs/${selected}`, signal, context));
        if (brief.id.toLowerCase() !== selected.toLowerCase()) throw new StudioApiError("读取的创作项目与当前选择不一致 请重新核对", 502);
        list.unshift({ id: brief.id, name: brief.name, stepIndex: brief.workflow?.stepIndex ?? null });
      }
      assertStudioCurrent(context); return { list, selected, currentWorkspace };
    }, {
      signal: controller.signal, onRetry: cause => { if (epoch === accessEpoch.current) { setError(errorText(cause)); setRecovering(true); } },
    }).then(({ list, selected, currentWorkspace }) => {
      if (controller.signal.aborted || epoch !== accessEpoch.current) return;
      setError(""); setRecovering(false); setRestricted(false); setRows(list);
      try { sessionStorage.setItem(rememberedKey, selected); } catch { /* Creation and saving do not depend on optional project memory. */ }
      setWorkspace(currentWorkspace); setScope(selected);
    }).catch(cause => { if (!controller.signal.aborted && epoch === accessEpoch.current) { if (studioScopeUnavailable(cause)) clearRestricted(); else { setRecovering(false); setError(errorText(cause)); } } });
    return () => controller.abort();
  }, [requestedScope, readAttempt, clearRestricted, capture, rememberedKey, access.available]);
  const changeScope = (value: string) => {
    if (blocked || transferBusy || imageBusy || value === scope) return;
    if (!StudioScopeSchema.safeParse(value).success || !access.available) return;
    accessEpoch.current++; invalidate(); stopPanelClose();
    setRequestedScope(value); setScope(undefined); setWorkspace(undefined); setPanel(null); setRows([]);
    router.replace(`/creative-designs/studio/${tool}?brief=${value}`);
  };
  if (!access.available) return <section className="studio-workspace"><h1>{titles[tool]}</h1><p role="status" className="studio-alert">当前本人会话尚未核对或已清除 创作内容已隐藏</p></section>;
  return <div className="studio-workspace"><header className="studio-page-header"><div><h1>{titles[tool]}</h1><p>画布、图片、视频和提示词使用同一项目的创作记录。</p></div><div className="studio-actions">
    <Link href={scope && scope !== "unassigned" ? `/creative-designs/canvas?brief=${scope}` : "/creative-designs/canvas"}><ArrowLeft size={15} />{scope && scope !== "unassigned" ? "返回项目审核" : "创意项目"}</Link>
    {access.can(Permission.ModelConfigure) && <Link href="/settings/ai"><Settings2 size={15} />AI 模型配置</Link>}</div></header>
    <div className="studio-context"><label><FolderOpen size={15} />创作归属<select aria-label="创作归属" value={scope ?? ""} disabled={!scope || blocked || transferBusy || imageBusy} onChange={event => changeScope(event.target.value)}><option value="" disabled>{restricted ? "当前创作资料不可访问" : "正在读取项目…"}</option><option value="unassigned">个人工作区（未关联项目）</option>{rows.map(row => <option key={row.id} value={row.id}>{row.name}{row.stepIndex !== null ? ` · 第 ${row.stepIndex + 1} 步` : ""}</option>)}</select></label>
      <div className="studio-actions"><button type="button" disabled={!scope} onClick={() => { if (panel === "assets") closePanel(); else { stopPanelClose(); setPanel("assets"); } }} aria-expanded={panel === "assets"}><Check size={14} />素材与审核</button><button type="button" disabled={!scope} onClick={() => { if (panel === "jobs") closePanel(); else { stopPanelClose(); setPanel("jobs"); } }} aria-expanded={panel === "jobs"}><History size={14} />生成任务</button>{tool === "image" && <Link href="/creative-designs">批量生图</Link>}</div></div>
    {visible && scope && <StudioDocumentTransfer key={scope} scope={scope} workspace={workspace} projects={rows} capture={capture} flush={flushRuntime} onBusy={setTransferBusy} />}
    {visible && scope && <StudioVideoDirectory key={videoOwner} scope={scope} workspace={workspace} active={active && tool === "video"} capture={capture} onReadDenied={clearRestricted} onAdmission={receiveVideoAdmission} />}
    {error && <p className={`studio-alert${restricted ? " studio-access-denied" : ""}`} role={recovering ? "status" : "alert"}>{recovering ? "项目暂时无法读取，正在自动恢复…" : error}<button type="button" onClick={() => setReadAttempt(value => value + 1)}>{restricted ? "重新核对访问权限" : "立即重试"}</button></p>}
    {restricted && !access.localDevelopment && <StudioImagePreparationCleanup capture={capture} onReadDenied={clearRestricted} onBusy={setImageBusy} />}
    {!access.localDevelopment && <p className="studio-generation-paused" role="status">{workspace?.paidImageAdmission?.enabled
      ? "原生多图与视频仍暂停 单张生图请使用费用面板"
      : "真实付费生成暂未启用 可继续读取与保存画布 提示词和已有素材 新图片与视频生成保持关闭"}</p>}
    {visible && scope && <StudioImageGenerationPanel key={scope} scope={scope} workspace={workspace} active={active && tool === "image"} capture={capture} flush={flushRuntime} onReadDenied={clearRestricted} onBusy={setImageBusy} />}
    {visible && scope && panel && (panel === "assets" ? <StudioOriginalRecords key={`${scope}:assets`} scope={scope} closing={panelClosing} onClose={closePanel} onReadDenied={clearRestricted} accessEpoch={accessEpoch} capture={capture} workspace={workspace} /> : <StudioRecords key={`${scope}:jobs`} scope={scope} panel={panel} active={active} closing={panelClosing} onClose={closePanel} onReadDenied={clearRestricted} accessEpoch={accessEpoch} capture={capture} workspace={workspace} />)}
    {visible && scope && runtimeUrl && (canCreateFrame || keepFrame) ? <StudioFrame key={scope} tool={frameTool} videoAdmission={videoAdmission} scope={scope} runtimeUrl={runtimeUrl} active={active} onBlocked={setBlocked} onReadDenied={clearRestricted} accessEpoch={accessEpoch} capture={capture} workspace={workspace} onWorkspace={setWorkspace} onFlush={bindFlush} /> : !error && <p role="status" className="studio-empty">{runtimeUrl ? scope && tool === "video" ? "请先核对视频历史并明确打开工作台" : "正在核对本人创作范围…" : "创作界面尚未部署 请联系管理员核对已固定的创作服务 现有 ERP 资料不受影响"}</p>}
  </div>;
}

function StudioFrame({ tool, videoAdmission, scope, runtimeUrl, active, onBlocked, onReadDenied, accessEpoch, capture, workspace, onWorkspace, onFlush }: { tool: StudioTool; videoAdmission: StudioVideoPreflight | null; scope: string; runtimeUrl: string; active: boolean; onBlocked: (value: boolean) => void; onReadDenied: () => void; accessEpoch: { current: number }; capture: (signal?: AbortSignal) => StudioRequestContext; workspace?: Workspace; onWorkspace: (value: Workspace) => void; onFlush: (flush?: () => Promise<void>) => void }) {
  const frame = useRef<HTMLIFrameElement>(null), router = useRouter();
  const [source, setSource] = useState(""), [loaded, setLoaded] = useState(false), [pending, setPending] = useState(0), [dirty, setDirty] = useState(0), [error, setError] = useState(""), [readError, setReadError] = useState("");
  const [recoveringReads, setRecoveringReads] = useState(0), [startupError, setStartupError] = useState("");
  const [accessError, setAccessError] = useState("");
  const [reconciling, setReconciling] = useState(false), [saveRecovery, setSaveRecovery] = useState<"confirmed" | "unchanged" | "conflict" | null>(null);
  const recovery = useRef({ busy: false, canRetry: false }), recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const state = useRef({ channel: "", pending: 0, dirty: 0, failed: false }), queuedNavigation = useRef<string | null>(null);
  const frameEpoch = useRef(accessEpoch.current), accessCheck = useRef(() => {});
  const workspaceRef = useRef(workspace); workspaceRef.current = workspace;
  const videoAdmissionRef = useRef(videoAdmission); videoAdmissionRef.current = videoAdmission;
  const requestedTool = useRef(tool), activePage = useRef(active), refreshOnReturn = useRef(false);
  requestedTool.current = tool; activePage.current = active;
  const send = useCallback((type: string, payload: Record<string, unknown> = {}) => { if (frameEpoch.current === accessEpoch.current) frame.current?.contentWindow?.postMessage({ ...payload, type, channel: state.current.channel }, runtimeUrl); }, [runtimeUrl, accessEpoch]);
  useLayoutEffect(() => bindStudioModelClear(window, () => frame.current?.contentWindow ?? null, runtimeUrl, () => state.current.channel), [runtimeUrl]);
  const flushWaiters = useRef(new Map<string, { resolve: () => void; reject: (cause: Error) => void; timer: ReturnType<typeof setTimeout> }>());
  useEffect(() => {
    if (!loaded) return;
    onFlush(() => new Promise<void>((resolve, reject) => {
      const id = crypto.randomUUID(), timer = setTimeout(() => { flushWaiters.current.delete(id); reject(new Error("全部输入保存尚未确认 请保留草稿并重试")); }, 110_000);
      flushWaiters.current.set(id, { resolve, reject, timer }); send("studio.flush", { id });
    }));
    const waiting = flushWaiters.current;
    return () => { onFlush(undefined); for (const value of waiting.values()) { clearTimeout(value.timer); value.reject(new Error("原创作工具已关闭 保存屏障未采用")); } waiting.clear(); };
  }, [loaded, send, onFlush]);
  useEffect(() => {
    if (loaded && workspace) send("studio.video-admission", { scope, contextAuthority: workspace.contextAuthority, admission: videoAdmission });
  }, [loaded, videoAdmission, workspace, scope, send]);
  useEffect(() => {
    if (!active) { queuedNavigation.current = null; refreshOnReturn.current = true; }
    if (loaded && active) {
      accessCheck.current();
      send("studio.tool", { tool });
      if (refreshOnReturn.current) { refreshOnReturn.current = false; send("studio.refresh"); }
    }
  }, [tool, active, loaded, send]);
  useEffect(() => { if (loaded && workspace) send("studio.workspace", { workspace }); }, [workspace, loaded, send]);
  useEffect(() => {
    let live = true, frameReady = false, initializing = false, initialized = false, startupBlocked = false;
    const controller = new AbortController(), recovering = new Set<string>(), requests = new Map<string, AbortController>();
    let context: StudioRequestContext;
    try { context = capture(controller.signal); } catch { controller.abort(); return; }
    const epoch = accessEpoch.current;
    const isLive = () => live && !context.signal.aborted && context.isCurrent() && epoch === accessEpoch.current;
    const channel = crypto.randomUUID(); state.current.channel = channel;
    const url = new URL(runtimeUrl); url.searchParams.set("parentOrigin", location.origin); url.searchParams.set("channel", channel); setSource(url.href);
    const navigate = (href: string) => { if (state.current.pending || state.current.dirty || state.current.failed) { queuedNavigation.current = href; setError("当前输入尚未保存 请保留此页 核对后可明确保存或导出备份"); } else router.push(href); };
    const videoRequired = createStudioVideoRequiredNavigation({
      current: () => ({ active: activePage.current, tool: requestedTool.current, scope, authority: workspaceRef.current?.contextAuthority }),
      navigate: selected => navigate(`/creative-designs/studio/video?brief=${selected}`),
    });
    const reply = (payload: Record<string, unknown>) => { if (isLive()) frame.current?.contentWindow?.postMessage({ ...payload, channel }, runtimeUrl); };
    const revoke = () => {
      if (!isLive()) return;
      live = false; accessChecks.stop(); controller.abort(); queuedNavigation.current = null;
      state.current = { channel: "", pending: 0, dirty: 0, failed: false }; setDirty(0);
      setSource(""); setLoaded(false); onBlocked(false); onReadDenied();
    };
    const accessChecks = createStudioAccessChecks<Workspace | undefined>({ signal: context.signal, isCurrent: isLive,
      read: signal => context.localDevelopment ? studioRpc(scope, { operation: "state.keys", namespace: "app_state" }, signal, context).then(() => undefined) : studioWorkspace(scope, context, signal),
      onValue: value => {
        if (value) { if (!value.capabilities.read) { revoke(); return; } workspaceRef.current = value; onWorkspace(value); reply({ type: "studio.workspace", workspace: value }); }
        setAccessError("");
      },
      onError: cause => {
        if (studioScopeUnavailable(cause)) revoke();
        else setAccessError("暂时无法核对创作访问权限，已打开的内容保留。恢复连接后会继续核对。");
      },
    });
    const checkAccess = () => { if (initialized) accessChecks.request(); };
    accessCheck.current = checkAccess;
    const visible = () => { if (document.visibilityState === "visible") checkAccess(); };
    const read = async <T,>(id: string, operation: (signal: AbortSignal) => Promise<T>, requestSignal = controller.signal) => {
      try {
        return await recoverStudioRead(operation, { signal: requestSignal, onRetry: () => {
          if (!isLive()) return;
          recovering.add(id); setRecoveringReads(recovering.size);
          // The runtime retains this request and its hydration state during recovery.
          reply({ type: "studio.request-pending", id });
        } });
      } finally { recovering.delete(id); if (live) setRecoveringReads(recovering.size); }
    };
    const handler = async (event: MessageEvent) => {
      if (!isLive() || event.source !== frame.current?.contentWindow || event.origin !== runtimeUrl || event.data?.channel !== channel) return;
      const data = event.data;
      if (data.type === "studio.flushed" && typeof data.id === "string") {
        const waiting = flushWaiters.current.get(data.id); if (!waiting) return;
        flushWaiters.current.delete(data.id); clearTimeout(waiting.timer);
        if (data.ok !== true || state.current.pending || state.current.dirty || state.current.failed) waiting.reject(new Error(typeof data.error === "string" ? data.error : "原输入仍有未确认保存 请先只读核对")); else waiting.resolve();
      }
      if (data.type === "studio.cancel" && typeof data.id === "string") requests.get(data.id)?.abort();
      if (data.type === "studio.ready") {
        if (initializing || startupBlocked) return;
        initializing = true;
        try {
          if (!initialized && scope !== "unassigned") {
            const brief = CanvasBriefSchema.parse(await read("project", signal => studioProject(`briefs/${scope}`, signal, context)));
            if (context.localDevelopment || workspaceRef.current?.capabilities.save && workspaceRef.current.capabilities.mediaWrite) for (const asset of brief.referenceAssets) {
              if (!isLive()) return;
              await studioRpc(scope, { operation: "reference.attach", assetId: asset.id }, controller.signal, context);
            }
          }
          if (isLive()) { initialized = true; setStartupError(""); reply({ type: "studio.init", theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light", scope, tool: requestedTool.current, videoAdmission: videoAdmissionRef.current, ...(workspaceRef.current ? { workspace: workspaceRef.current } : {}) }); }
        } catch (cause) { if (isLive()) { if (studioScopeUnavailable(cause)) revoke(); else { startupBlocked = !transientStudioError(cause); setStartupError(startupBlocked ? errorText(cause) : "项目素材暂时无法读取，正在自动恢复…"); } } }
        finally { initializing = false; }
      }
      if (data.type === "studio.loaded") { frameReady = true; setStartupError(""); setLoaded(true); }
      if (data.type === "studio.request" && typeof data.id === "string" && data.id.length <= 80) {
        if (requests.has(data.id)) return;
        const parsed = StudioRpcSchema.safeParse({ ...data.request, scope });
        if (!parsed.success) { reply({ type: "studio.response", id: data.id, error: "创作请求不受支持" }); return; }
        const requestController = new AbortController(); requests.set(data.id, requestController);
        const requestSignal = AbortSignal.any([controller.signal, requestController.signal]);
        let invoked = false;
        try {
          if (!initialized) throw new StudioApiError("正在核对原创作范围 请稍后读取", 409);
          const capabilities = workspaceRef.current?.capabilities;
          if (["asset.inspect", "result.lookup", "result.submit.pinned"].includes(parsed.data.operation) && workspaceRef.current?.originalHandoffVersion !== 1) throw new StudioApiError("当前创作服务尚未提供原件核对与固定送审 请联系管理员升级", 409);
          if (parsed.data.operation.startsWith("document.") && workspaceRef.current?.documentTransferVersion !== 1) throw new StudioApiError("当前创作服务尚未提供完整资料复制", 409);
          if (parsed.data.operation.startsWith("video.") && workspaceRef.current?.videoDirectoryVersion !== 1) throw new StudioApiError("当前创作服务尚未提供视频历史检查", 409, "studio_video_directory_unavailable");
          if (!context.localDevelopment && (!capabilities?.read || !workspaceRef.current)) throw new StudioApiError("当前创作范围尚未核对", 403);
          if (!context.localDevelopment && parsed.data.operation === "generate") throw new StudioApiError("真实付费生成暂未启用", 409, "operator_paused");
          if (!context.localDevelopment && parsed.data.operation === "generation.get" && !workspaceRef.current?.generation.enabled) throw new StudioApiError("原任务恢复与轮询已暂停 原记录保持", 409, "operator_paused");
          if (!context.localDevelopment && ((["state.set", "state.remove"].includes(parsed.data.operation) && !capabilities?.save) || (parsed.data.operation === "state.set" || parsed.data.operation === "state.remove") && ["image_files", "media_files"].includes(parsed.data.namespace) && !capabilities?.mediaWrite || parsed.data.operation === "reference.attach" && (!capabilities?.save || !capabilities.mediaWrite) || parsed.data.operation === "asset.review" && !capabilities?.review || ["result.submit", "result.submit.pinned"].includes(parsed.data.operation) && !capabilities?.submit)) throw new StudioApiError("当前创作范围为只读 或不允许此项操作", 403);
          invoked = true;
          const result = studioReadOperations.has(parsed.data.operation)
            ? await read(data.id, signal => studioRpc(scope, parsed.data, signal, context), requestSignal)
            : await studioRpc(scope, parsed.data, requestSignal, context);
          if (isLive() && !requestSignal.aborted) reply({ type: "studio.response", id: data.id, result });
        }
        catch (cause) { if (isLive() && !requestSignal.aborted) { if (invoked && studioReadDenied(cause)) revoke(); else reply({ type: "studio.response", id: data.id, error: errorText(cause) }); } }
        finally { requests.delete(data.id); }
      }
      if (data.type === "studio.storage") {
        const parsed = StudioStorageStatusSchema.safeParse({ pending: data.pending, dirty: data.dirty, error: data.error });
        if (!parsed.success) return;
        const { pending: saving, dirty: localDirty, error: storageError } = parsed.data;
        state.current.pending = saving; state.current.dirty = localDirty; state.current.failed = !!storageError;
        setPending(saving); setDirty(localDirty); onBlocked(!!saving || !!localDirty || !!storageError);
        if (saving) { recovery.current.canRetry = false; setSaveRecovery(null); }
        if (storageError) setError("当前更改尚未核对保存结果 请保留此页并读取原记录后确认");
        else if (!saving && !localDirty) { setError(""); const next = queuedNavigation.current; queuedNavigation.current = null; if (next && activePage.current) router.push(next); }
      }
      if (data.type === "studio.reconciled" && ["confirmed", "unchanged", "conflict"].includes(data.result)) {
        if (recoveryTimer.current) clearTimeout(recoveryTimer.current); recoveryTimer.current = null;
        recovery.current.busy = false; recovery.current.canRetry = data.result === "unchanged";
        setReconciling(false); setSaveRecovery(data.result);
        setError(data.result === "confirmed" ? "已只读核对原保存结果 未重复写入" : data.result === "unchanged" ? "原保存已核对 当前草稿仍需本人决定是否再次保存 未自动写入" : "原记录与当前稿存在冲突 请保留或导出当前稿 未重写原记录");
      }
      if (data.type === "studio.error") setError("创作处理尚未完成 请保留草稿并核对原记录");
      if (data.type === "studio.read-error") setReadError("创作记录暂时无法读取 原草稿保持 未自动覆盖");
      if (data.type === "studio.video-required") videoRequired(data);
      if (activePage.current && data.type === "studio.navigate" && data.tool === "settings" && (context.localDevelopment || workspaceRef.current?.capabilities.configure)) navigate("/settings/ai");
      if (activePage.current && data.type === "studio.route" && data.fromTool === requestedTool.current && StudioToolSchema.safeParse(data.tool).success && data.tool !== requestedTool.current) navigate(`/creative-designs/studio/${data.tool}?brief=${scope}`);
    };
    const beforeUnload = (event: BeforeUnloadEvent) => { if (state.current.pending || state.current.dirty || state.current.failed) { event.preventDefault(); event.returnValue = ""; } };
    const click = (event: MouseEvent) => {
      if (!activePage.current || !state.current.pending && !state.current.dirty && !state.current.failed || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
      const anchor = (event.target as Element)?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download") || anchor.origin !== location.origin) return;
      event.preventDefault(); event.stopImmediatePropagation(); navigate(anchor.href);
    };
    const theme = new MutationObserver(() => { reply({ type: "studio.theme", theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light" }); });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    // A failed iframe load has no running script to announce readiness. Retry
    // only before initialization, when there cannot be an editor draft to lose.
    const timeout = setInterval(() => {
        if (!isLive() || frameReady || initializing || initialized || startupBlocked) return;
      setStartupError("创作工具尚未启动，正在自动重试…");
      url.searchParams.set("retry", crypto.randomUUID()); setSource(url.href);
    }, 15_000);
    const accessTimer = setInterval(checkAccess, 30_000);
    window.addEventListener("focus", checkAccess); document.addEventListener("visibilitychange", visible);
    window.addEventListener("message", handler); window.addEventListener("beforeunload", beforeUnload); document.addEventListener("click", click, true);
    return () => { live = false; accessChecks.stop(); controller.abort(); accessCheck.current = () => {}; if (recoveryTimer.current) clearTimeout(recoveryTimer.current); clearInterval(accessTimer); clearInterval(timeout); theme.disconnect(); window.removeEventListener("focus", checkAccess); document.removeEventListener("visibilitychange", visible); window.removeEventListener("message", handler); window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", click, true); onBlocked(false); };
  }, [runtimeUrl, scope, router, onBlocked, onReadDenied, accessEpoch, capture, onWorkspace]);
  const reconcile = () => {
    if (!state.current.failed || state.current.pending || recovery.current.busy || !loaded) return;
    recovery.current.busy = true; recovery.current.canRetry = false; setReconciling(true); setSaveRecovery(null);
    send("studio.reconcile");
    recoveryTimer.current = setTimeout(() => { recoveryTimer.current = null; recovery.current.busy = false; if (frameEpoch.current === accessEpoch.current) { setReconciling(false); setError("原保存结果暂时无法核对 草稿保持 未自动重写 可稍后再次只读核对"); } }, 30_000);
  };
  const retrySave = () => {
    if (!recovery.current.canRetry || recovery.current.busy || state.current.pending || !state.current.failed && !state.current.dirty || workspace && !workspace.capabilities.save) return;
    recovery.current.canRetry = false; setSaveRecovery(null); send("studio.retry");
  };
  return <section className="studio-editor" aria-label={`${titles[tool]}编辑区域`} data-studio-local-dirty={dirty}><div className="studio-save-bar"><span role="status">{readError ? "读取失败" : reconciling ? "正在只读核对原保存结果…" : pending ? `正在保存 ${pending} 项更改…` : state.current.failed ? "保存结果尚未核对 · 请保留草稿" : dirty ? "当前输入尚未保存 · 请保留草稿" : recoveringReads ? "正在恢复数据读取…" : !loaded ? "正在打开创作工具…" : workspace && !workspace.capabilities.save ? "当前范围只读" : "自动保存已开启"}</span><div className="studio-actions"><button type="button" onClick={() => send("studio.backup")} disabled={!loaded || !!readError}><Download size={13} />导出画布备份</button>{state.current.failed && <button type="button" onClick={reconcile} disabled={reconciling || !!pending}><RefreshCw size={13} />只读核对保存结果</button>}{(state.current.failed || dirty > 0) && saveRecovery === "unchanged" && <button type="button" onClick={retrySave} disabled={reconciling || !!pending || !!workspace && !workspace.capabilities.save}>再次保存当前内容</button>}</div></div>
    {!!recoveringReads && <p role="status" className="studio-alert">数据服务暂时不可用，恢复后会继续读取。请保留此页，已打开的画布会留在原处。</p>}
    {startupError && <p role="status" className="studio-alert">{startupError}</p>}
    {accessError && <p role="status" className="studio-alert">{accessError}</p>}
    {(error || readError) && <p role={saveRecovery === "confirmed" && !readError ? "status" : "alert"} className="studio-alert">{readError || error}</p>}
    {source && <iframe ref={frame} src={source} title={titles[tool]} sandbox="allow-scripts allow-same-origin allow-downloads allow-forms" allow="clipboard-read; clipboard-write" referrerPolicy="no-referrer" />}</section>;
}

function StudioRecords({ scope, active, closing, onClose, onReadDenied, accessEpoch, capture }: { scope: string; panel: "jobs"; active: boolean; closing: boolean; onClose: () => void; onReadDenied: () => void; accessEpoch: { current: number }; capture: (signal?: AbortSignal) => StudioRequestContext; workspace?: Workspace }) {
  const [jobs, setJobs] = useState<StudioJob[]>([]), [error, setError] = useState(""), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [resultText, setResultText] = useState("");
  const [preview, setPreview] = useState<{ url: string; type: string; name: string }>();
  const live = useRef(false), epoch = useRef(accessEpoch.current), controller = useRef(new AbortController()), mutating = useRef(false), sequence = useRef(0), previewUrl = useRef<string | null>(null), closingRef = useRef(closing);
  closingRef.current = closing;
  useLayoutEffect(() => { live.current = true; if (controller.current.signal.aborted) controller.current = new AbortController(); return () => { live.current = false; controller.current.abort(); if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); }; }, []);
  useLayoutEffect(() => { if (closing) controller.current.abort(); }, [closing]);
  const isCurrent = useCallback(() => live.current && !closingRef.current && !controller.current.signal.aborted && epoch.current === accessEpoch.current, [accessEpoch]);
  const read = useCallback(async <T,>(input: Record<string, unknown>): Promise<T> => {
    try { if (!isCurrent()) throw new DOMException("创作读取已结束", "AbortError"); const context = capture(controller.current.signal); const result = await studioRpc<T>(scope, input, controller.current.signal, context); if (!isCurrent()) throw new DOMException("创作读取已结束", "AbortError"); return result; }
    catch (cause) { if (isCurrent() && studioReadDenied(cause)) onReadDenied(); throw cause; }
  }, [scope, isCurrent, onReadDenied, capture]);
  const reload = useCallback(async () => { const current = ++sequence.current, result = await read<StudioJob[]>({ operation: "generations" }); if (isCurrent() && current === sequence.current) setJobs(result); }, [read, isCurrent]);
  useEffect(() => { void reload().catch(cause => { if (isCurrent()) setError(errorText(cause)); }).finally(() => { if (isCurrent()) setLoading(false); }); }, [reload, isCurrent]);
  useEffect(() => { if (!active || !jobs.some(job => ["queued", "running"].includes(job.status))) return; const timer = setInterval(() => { void reload().catch(cause => { if (isCurrent()) setError(errorText(cause)); }); }, 4000); return () => clearInterval(timer); }, [jobs, active, reload, isCurrent]);
  async function perform(action: () => Promise<void>) { if (mutating.current || !isCurrent()) return; mutating.current = true; setBusy(true); setError(""); try { await action(); } catch (cause) { if (isCurrent()) setError(errorText(cause)); } finally { mutating.current = false; if (isCurrent()) setBusy(false); } }
  const status: Record<string, string> = { queued: "排队中", running: "生成中", completed: "已完成", failed: "失败" };
  return <section className="studio-records" data-closing={closing || undefined} aria-label="生成任务"><header><h2>生成任务</h2><div className="studio-actions"><button type="button" disabled={busy || closing} onClick={() => void perform(reload)}><RefreshCw size={14} />刷新</button><button type="button" aria-label="关闭记录面板" onClick={onClose}><X size={16} /></button></div></header>
    <p className="studio-record-limit">显示最近最多40条原生成任务 不代表完整历史</p>{error && <p className="studio-alert" role="alert">{error}</p>}{loading ? <p role="status">正在读取</p> : <div className="studio-record-list">{jobs.map(job => <div className="studio-record" key={job.id}><div><strong>{job.input.prompt.slice(0, 120)}</strong><small>{status[job.status]} · {job.model.model} · {new Date(job.createdAt).toLocaleString("zh-CN")}</small>{job.status === "failed" && <p>生成未完成 请核对渠道状态与配置 系统不会自动重复提交</p>}<CreativeExecutionHistoryPanel scope="studio_generation" ownerId={job.id} active={active} /></div>{job.status === "completed" && <button type="button" disabled={busy} onClick={() => void perform(async () => {
      const result = await read<{ contentBase64?: string; mediaType?: string; text?: string; reviewError?: string }>({ operation: "generation.get", id: job.id });
      if (result.contentBase64 && result.mediaType && isCurrent()) { const binary = atob(result.contentBase64); const url = URL.createObjectURL(new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: result.mediaType })); if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = url; setPreview({ url, type: result.mediaType, name: `生成结果.${result.mediaType.split("/")[1]}` }); }
      if (result.text && isCurrent()) setResultText(result.text); if (result.reviewError && isCurrent()) setError("原结果已读取 提交审核尚未完成 请在原项目核对 未自动重复提交");
    })}>查看结果</button>}</div>)}{!jobs.length && <p className="studio-empty">当前范围暂无可读生成任务 新付费生成暂未启用</p>}</div>}
    {resultText && <div className="studio-result-text">{resultText}</div>}{preview && <div className="studio-preview"><div className="studio-actions"><a href={preview.url} download={preview.name}><Download size={14} />下载文件</a><button type="button" onClick={() => { if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = null; setPreview(undefined); }}>关闭预览</button></div>{preview.type.startsWith("image/") ? <img src={preview.url} alt={preview.name} /> : preview.type.startsWith("video/") ? <video src={preview.url} controls /> : <audio src={preview.url} controls />}</div>}
  </section>;
}
function errorText(cause: unknown) { return cause instanceof StudioApiError ? cause.message : "创作请求暂未完成 请保留当前草稿并重新读取原记录"; }
