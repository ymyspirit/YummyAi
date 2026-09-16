"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Download, FolderOpen, History, RefreshCw, Settings2, X } from "lucide-react";
import { StudioRpcSchema, StudioScopeSchema, StudioToolSchema, type StudioTool } from "@yummyai/contracts/pod/creative-studio";
import { CanvasBriefSchema, CanvasProjectSummarySchema, type CanvasProjectSummary } from "@yummyai/contracts/pod/canvas-bridge";
import { recoverStudioRead, studioProject, studioReadOperations, studioRpc, transientStudioError, type StudioAsset, type StudioJob } from "./studio-api";
import "./studio.css";

const titles: Record<StudioTool, string> = { canvas: "我的画布", image: "生图工作台", video: "视频创作台", prompts: "提示词库", assets: "我的资产" };
const scopeKey = "yummyai.studio.scope";
export function StudioWorkspace({ tool, runtimeUrl, initialScope, active }: { tool: StudioTool; runtimeUrl: string | null; initialScope?: string; active: boolean }) {
  const router = useRouter(), [rows, setRows] = useState<CanvasProjectSummary[]>([]), [scope, setScope] = useState<string>(), [error, setError] = useState("");
  const [panel, setPanel] = useState<"assets" | "jobs" | null>(null), [blocked, setBlocked] = useState(false);
  const [recovering, setRecovering] = useState(false), [readAttempt, setReadAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(""); setRecovering(false);
    void recoverStudioRead(async signal => CanvasProjectSummarySchema.array().parse(await studioProject("projects", signal)), {
      signal: controller.signal, onRetry: cause => { setError(errorText(cause)); setRecovering(true); },
    }).then(list => {
      if (controller.signal.aborted) return;
      setError(""); setRecovering(false); setRows(list);
      const preferred = initialScope ?? sessionStorage.getItem(scopeKey) ?? "unassigned";
      const selected = StudioScopeSchema.safeParse(preferred).success && (preferred === "unassigned" || list.some(row => row.id === preferred)) ? preferred : "unassigned";
      sessionStorage.setItem(scopeKey, selected); setScope(selected);
    }).catch(cause => { if (!controller.signal.aborted) { setRecovering(false); setError(errorText(cause)); } });
    return () => controller.abort();
  }, [initialScope, readAttempt]);
  const changeScope = (value: string) => {
    if (blocked) return;
    sessionStorage.setItem(scopeKey, value); setScope(value); setPanel(null);
    router.replace(`/creative-designs/studio/${tool}?brief=${value}`);
  };
  return <div className="studio-workspace"><header className="studio-page-header"><div><h1>{titles[tool]}</h1><p>画布、图片、视频和提示词使用同一项目的创作记录。</p></div><div className="studio-actions">
    <Link href={scope && scope !== "unassigned" ? `/creative-designs/canvas?brief=${scope}` : "/creative-designs/canvas"}><ArrowLeft size={15} />{scope && scope !== "unassigned" ? "返回项目审核" : "创意项目"}</Link>
    <Link href="/settings/ai"><Settings2 size={15} />AI 模型配置</Link></div></header>
    <div className="studio-context"><label><FolderOpen size={15} />创作归属<select aria-label="创作归属" value={scope ?? ""} disabled={!scope || blocked} onChange={event => changeScope(event.target.value)}><option value="" disabled>正在读取项目…</option><option value="unassigned">个人工作区（未关联项目）</option>{rows.map(row => <option key={row.id} value={row.id}>{row.name}{row.stepIndex !== null ? ` · 第 ${row.stepIndex + 1} 步` : ""}</option>)}</select></label>
      <div className="studio-actions"><button type="button" onClick={() => setPanel(panel === "assets" ? null : "assets")} aria-expanded={panel === "assets"}><Check size={14} />素材与审核</button><button type="button" onClick={() => setPanel(panel === "jobs" ? null : "jobs")} aria-expanded={panel === "jobs"}><History size={14} />生成任务</button>{tool === "image" && <Link href="/creative-designs">批量生图</Link>}</div></div>
    {error && <p className="studio-alert" role={recovering ? "status" : "alert"}>{recovering ? "项目暂时无法读取，正在自动恢复…" : error}<button type="button" onClick={() => setReadAttempt(value => value + 1)}>立即重试</button></p>}
    {scope && panel && <StudioRecords key={`${scope}:${panel}`} scope={scope} panel={panel} active={active} onClose={() => setPanel(null)} />}
    {scope && runtimeUrl ? <StudioFrame key={scope} tool={tool} scope={scope} runtimeUrl={runtimeUrl} active={active} onBlocked={setBlocked} /> : !error && <p role="status" className="studio-empty">{runtimeUrl ? "正在读取创作项目…" : "创作服务尚未配置；本地环境请运行 pnpm start:local。"}</p>}
  </div>;
}

function StudioFrame({ tool, scope, runtimeUrl, active, onBlocked }: { tool: StudioTool; scope: string; runtimeUrl: string; active: boolean; onBlocked: (value: boolean) => void }) {
  const frame = useRef<HTMLIFrameElement>(null), router = useRouter();
  const [source, setSource] = useState(""), [loaded, setLoaded] = useState(false), [pending, setPending] = useState(0), [error, setError] = useState(""), [readError, setReadError] = useState("");
  const [recoveringReads, setRecoveringReads] = useState(0), [startupError, setStartupError] = useState("");
  const state = useRef({ channel: "", pending: 0, failed: false }), queuedNavigation = useRef<string | null>(null);
  const requestedTool = useRef(tool), activePage = useRef(active), refreshOnReturn = useRef(false);
  const send = useCallback((type: string, payload: Record<string, unknown> = {}) => frame.current?.contentWindow?.postMessage({ ...payload, type, channel: state.current.channel }, runtimeUrl), [runtimeUrl]);
  useEffect(() => {
    requestedTool.current = tool;
    activePage.current = active;
    if (!active) { queuedNavigation.current = null; refreshOnReturn.current = true; }
    if (loaded && active) {
      send("studio.tool", { tool });
      if (refreshOnReturn.current) { refreshOnReturn.current = false; send("studio.refresh"); }
    }
  }, [tool, active, loaded, send]);
  useEffect(() => {
    let live = true, frameReady = false, initializing = false, initialized = false, startupBlocked = false;
    const controller = new AbortController(), recovering = new Set<string>(), requests = new Set<string>();
    const channel = crypto.randomUUID(); state.current.channel = channel;
    const url = new URL(runtimeUrl); url.searchParams.set("parentOrigin", location.origin); url.searchParams.set("channel", channel); setSource(url.href);
    const navigate = (href: string) => { if (state.current.pending || state.current.failed) { queuedNavigation.current = href; setError("请等待保存完成。保存失败时可重试或导出画布备份。"); } else router.push(href); };
    const reply = (payload: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ ...payload, channel }, runtimeUrl);
    const read = async <T,>(id: string, operation: (signal: AbortSignal) => Promise<T>) => {
      try {
        return await recoverStudioRead(operation, { signal: controller.signal, onRetry: () => {
          if (!live) return;
          recovering.add(id); setRecoveringReads(recovering.size);
          // The runtime retains this request and its hydration state during recovery.
          reply({ type: "studio.request-pending", id });
        } });
      } finally { recovering.delete(id); if (live) setRecoveringReads(recovering.size); }
    };
    const handler = async (event: MessageEvent) => {
      if (!live || event.source !== frame.current?.contentWindow || event.origin !== runtimeUrl || event.data?.channel !== channel) return;
      const data = event.data;
      if (data.type === "studio.ready") {
        if (initializing || startupBlocked) return;
        initializing = true;
        try {
          if (!initialized && scope !== "unassigned") {
            const brief = CanvasBriefSchema.parse(await read("project", signal => studioProject(`briefs/${scope}`, signal)));
            for (const asset of brief.referenceAssets) await studioRpc(scope, { operation: "reference.attach", assetId: asset.id }, controller.signal);
          }
          if (live) { initialized = true; setStartupError(""); reply({ type: "studio.init", theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light", scope, tool: requestedTool.current }); }
        } catch (cause) { if (live) { startupBlocked = !transientStudioError(cause); setStartupError(startupBlocked ? errorText(cause) : "项目素材暂时无法读取，正在自动恢复…"); } }
        finally { initializing = false; }
      }
      if (data.type === "studio.loaded") { frameReady = true; setStartupError(""); setLoaded(true); }
      if (data.type === "studio.request" && typeof data.id === "string" && data.id.length <= 80) {
        if (requests.has(data.id)) return;
        const parsed = StudioRpcSchema.safeParse({ ...data.request, scope });
        if (!parsed.success) { reply({ type: "studio.response", id: data.id, error: "创作请求不受支持" }); return; }
        requests.add(data.id);
        try {
          const result = studioReadOperations.has(parsed.data.operation)
            ? await read(data.id, signal => studioRpc(scope, parsed.data, signal))
            : await studioRpc(scope, parsed.data, controller.signal);
          if (live) reply({ type: "studio.response", id: data.id, result });
        }
        catch (cause) { if (live) reply({ type: "studio.response", id: data.id, error: errorText(cause) }); }
        finally { requests.delete(data.id); }
      }
      if (data.type === "studio.storage") {
        const saving = Number.isSafeInteger(data.pending) && data.pending >= 0 ? data.pending : 0;
        state.current.pending = saving; state.current.failed = !!data.error; setPending(saving); onBlocked(!!saving || !!data.error);
        if (data.error) setError(String(data.error));
        else if (!saving) { setError(""); const next = queuedNavigation.current; queuedNavigation.current = null; if (next && activePage.current) router.push(next); }
      }
      if (data.type === "studio.error") setError(typeof data.error === "string" ? data.error.slice(0, 400) : "创作处理失败");
      if (data.type === "studio.read-error") setReadError(typeof data.error === "string" ? data.error.slice(0, 400) : "创作记录读取失败");
      if (activePage.current && data.type === "studio.navigate" && data.tool === "settings") navigate("/settings/ai");
      if (activePage.current && data.type === "studio.route" && data.fromTool === requestedTool.current && StudioToolSchema.safeParse(data.tool).success && data.tool !== requestedTool.current) navigate(`/creative-designs/studio/${data.tool}?brief=${scope}`);
    };
    const beforeUnload = (event: BeforeUnloadEvent) => { if (state.current.pending || state.current.failed) { event.preventDefault(); event.returnValue = ""; } };
    const click = (event: MouseEvent) => {
      if (!activePage.current || !state.current.pending && !state.current.failed || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
      const anchor = (event.target as Element)?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download") || anchor.origin !== location.origin) return;
      event.preventDefault(); event.stopImmediatePropagation(); navigate(anchor.href);
    };
    const theme = new MutationObserver(() => { reply({ type: "studio.theme", theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light" }); });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    // A failed iframe load has no running script to announce readiness. Retry
    // only before initialization, when there cannot be an editor draft to lose.
    const timeout = setInterval(() => {
      if (!live || frameReady || initializing || initialized || startupBlocked) return;
      setStartupError("创作工具尚未启动，正在自动重试…");
      url.searchParams.set("retry", crypto.randomUUID()); setSource(url.href);
    }, 15_000);
    window.addEventListener("message", handler); window.addEventListener("beforeunload", beforeUnload); document.addEventListener("click", click, true);
    return () => { live = false; controller.abort(); clearInterval(timeout); theme.disconnect(); window.removeEventListener("message", handler); window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", click, true); onBlocked(false); };
  }, [runtimeUrl, scope, router, onBlocked]);
  return <section className="studio-editor" aria-label={`${titles[tool]}编辑区域`}><div className="studio-save-bar"><span role="status">{readError ? "读取失败" : state.current.failed ? "保存失败 · 当前更改尚未保存" : pending ? `正在保存 ${pending} 项更改…` : recoveringReads ? "正在恢复数据读取…" : !loaded ? "正在打开创作工具…" : "自动保存已开启"}</span><div className="studio-actions"><button type="button" onClick={() => send("studio.backup")} disabled={!loaded || !!readError}><Download size={13} />导出画布备份</button>{state.current.failed && <button type="button" onClick={() => send("studio.retry")}><RefreshCw size={13} />重试保存</button>}</div></div>
    {!!recoveringReads && <p role="status" className="studio-alert">数据服务暂时不可用，恢复后会继续读取。请保留此页，已打开的画布会留在原处。</p>}
    {startupError && <p role="status" className="studio-alert">{startupError}</p>}
    {(error || readError) && <p role="alert" className="studio-alert">{readError || error}</p>}
    {source && <iframe ref={frame} src={source} title={titles[tool]} sandbox="allow-scripts allow-same-origin allow-downloads allow-forms" allow="clipboard-read; clipboard-write" referrerPolicy="no-referrer" />}</section>;
}

function StudioRecords({ scope, panel, active, onClose }: { scope: string; panel: "assets" | "jobs"; active: boolean; onClose: () => void }) {
  const [assets, setAssets] = useState<StudioAsset[]>([]), [jobs, setJobs] = useState<StudioJob[]>([]), [error, setError] = useState(""), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<StudioAsset>(), [reference, setReference] = useState(""), [attested, setAttested] = useState(false), [preview, setPreview] = useState<{ url: string; type: string; name: string }>();
  const reload = useCallback(async () => { if (panel === "assets") setAssets(await studioRpc<StudioAsset[]>(scope, { operation: "assets" })); else setJobs(await studioRpc<StudioJob[]>(scope, { operation: "generations" })); }, [panel, scope]);
  useEffect(() => { let live = true; void reload().catch(cause => { if (live) setError(errorText(cause)); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, [reload]);
  useEffect(() => { if (!active || panel !== "jobs" || !jobs.some(job => ["queued", "running"].includes(job.status))) return; const timer = setInterval(() => { void reload().catch(cause => setError(errorText(cause))); }, 4000); return () => clearInterval(timer); }, [jobs, panel, active, reload]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  async function perform(action: () => Promise<void>) { if (busy) return; setBusy(true); setError(""); try { await action(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }
  const show = (media: { contentBase64: string; mediaType: string }, name: string) => { const binary = atob(media.contentBase64); setPreview({ url: URL.createObjectURL(new Blob([Uint8Array.from(binary, c => c.charCodeAt(0))], { type: media.mediaType })), type: media.mediaType, name }); };
  async function review(decision: "approve" | "reject" | "submit") {
    if (!chosen || !reference.trim() || !attested) return;
    await perform(async () => {
      await studioRpc(scope, decision === "submit" ? { operation: "result.submit", key: chosen.key, title: chosen.fileName.slice(0, 160), submissionId: crypto.randomUUID(), rightsAttested: true, sourceReference: reference } : { operation: "asset.review", key: chosen.key, decision, sourceReference: reference });
      setChosen(undefined); setReference(""); setAttested(false); await reload();
    });
  }
  const status: Record<string, string> = { queued: "排队中", running: "生成中", completed: "已完成", failed: "失败", unverified: "待审核", approved: "已批准", rejected: "已退回" };
  return <section className="studio-records" aria-label={panel === "assets" ? "素材与审核" : "生成任务"}><header><h2>{panel === "assets" ? "项目素材与审核" : "生成任务"}</h2><div className="studio-actions"><button type="button" disabled={busy} onClick={() => void perform(reload)}><RefreshCw size={14} />刷新</button><button type="button" aria-label="关闭记录面板" onClick={onClose}><X size={16} /></button></div></header>
    {error && <p className="studio-alert" role="alert">{error}</p>}{loading ? <p role="status">正在读取…</p> : <div className="studio-record-list">{panel === "assets" ? [...new Map(assets.map(asset => [asset.assetId, asset])).values()].map(asset => <div className="studio-record" key={asset.assetId}><div><strong>{asset.fileName}</strong><small>{asset.mediaType} · {status[asset.rightsStatus] ?? asset.rightsStatus} · {asset.aiGenerated ? "AI 生成" : "上传素材"}</small></div><div className="studio-actions"><button type="button" disabled={busy} onClick={() => void perform(async () => { const result = await studioRpc<{ media: { contentBase64: string; mediaType: string } }>(scope, { operation: "state.get", namespace: asset.namespace, key: asset.key }); show(result.media, asset.fileName); })}>预览</button>{asset.rightsStatus === "unverified" && <button type="button" onClick={() => { setChosen(asset); setReference(""); setAttested(false); }}>审核</button>}</div></div>) : jobs.map(job => <div className="studio-record" key={job.id}><div><strong>{job.input.prompt.slice(0, 120)}</strong><small>{status[job.status]} · {job.model.model} · {new Date(job.createdAt).toLocaleString("zh-CN")}</small>{job.status === "failed" && <p>生成未完成。请核对渠道状态与配置；系统不会自动重复提交。</p>}</div>{job.status === "completed" && <button type="button" disabled={busy} onClick={() => void perform(async () => { const result = await studioRpc<{ contentBase64?: string; mediaType?: string; text?: string; reviewError?: string }>(scope, { operation: "generation.get", id: job.id }); if (result.contentBase64 && result.mediaType) show({ contentBase64: result.contentBase64, mediaType: result.mediaType }, `生成结果.${result.mediaType.split("/")[1]}`); if (result.text) setError(result.text); if (result.reviewError) setError(result.reviewError); })}>查看结果</button>}</div>)}{!(panel === "assets" ? assets : jobs).length && <p className="studio-empty">{panel === "assets" ? "上传或生成的图片、视频会保存在这里。" : "暂无生成任务。提交后可离开页面，任务由 ERP 继续执行。"}</p>}</div>}
    {chosen && <form className="studio-review" onSubmit={event => { event.preventDefault(); void review(chosen.aiGenerated && scope !== "unassigned" && chosen.mediaType.startsWith("image/") ? "submit" : "approve"); }}><strong>审核：{chosen.fileName}</strong><label>素材来源与使用依据<input required maxLength={500} value={reference} onChange={event => setReference(event.target.value)} placeholder="例如：本人原创设计；或授权文件名称" /></label><label className="studio-checkbox"><input type="checkbox" checked={attested} onChange={event => setAttested(event.target.checked)} required />我已核对素材内容及使用权，可用于当前创作。</label><div className="studio-actions"><button disabled={busy || !attested || !reference.trim()} type="submit" className="primary">{chosen.aiGenerated && scope !== "unassigned" && chosen.mediaType.startsWith("image/") ? "提交到项目方案审核" : "批准作为参考素材"}</button><button type="button" onClick={() => setChosen(undefined)}>取消</button></div></form>}
    {preview && <div className="studio-preview"><div className="studio-actions"><a href={preview.url} download={preview.name}><Download size={14} />下载文件</a><button type="button" onClick={() => setPreview(undefined)}>关闭预览</button></div>{preview.type.startsWith("image/") ? <img src={preview.url} alt={preview.name} /> : preview.type.startsWith("video/") ? <video src={preview.url} controls /> : <audio src={preview.url} controls />}</div>}
  </section>;
}
function errorText(cause: unknown) { return cause instanceof Error ? cause.message : "操作失败，请重试"; }
