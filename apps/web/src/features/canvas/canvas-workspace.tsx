"use client";

import { CANVAS_BRIDGE, CANVAS_WORKFLOW_TEMPLATES, CanvasBriefSchema, CanvasProductionTemplateSchema, CanvasResultViewSchema, CreateCanvasBriefInputSchema, type CanvasBrief, type CanvasProductionTemplate, type CanvasResultView } from "@yummyai/contracts/pod/canvas-bridge";
import { ArrowRight, Check, Circle, Copy, ExternalLink, FileImage, FolderOpen, LayoutTemplate, Plus, RefreshCw, Scissors, Search, Shapes, Workflow, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { SpotlightCard } from "../../components/react-bits/spotlight-card";
import { canvasApi, connectCanvas } from "./canvas-connection";
import { CanvasResults } from "./canvas-results";
import { canvasResultSelection, nextCanvasPrompt, recentCanvasProjects, type CanvasBriefRow } from "./canvas-workspace-model";
import "./canvas-workspace.css";
import { ProductionEditorSession } from "../production-editor/production-editor-session";
import type { ProductionKind } from "../production-editor/production-editor-model";

type Asset = CanvasBrief["referenceAssets"][number];
type TemplateKey = typeof CANVAS_WORKFLOW_TEMPLATES[number]["key"];
const TEMPLATE_ICONS = { freeform: Plus, original_pattern: Shapes, tire_cover: Circle, shaped_pillow: Scissors };

export function CanvasWorkspace({ canvasUrl, initialBriefId }: { canvasUrl: string | null; initialBriefId?: string }) {
  const [rows, setRows] = useState<CanvasBriefRow[]>([]), [assets, setAssets] = useState<Asset[]>([]), [templates, setTemplates] = useState<CanvasProductionTemplate[]>([]);
  const [brief, setBrief] = useState<CanvasBrief>(), [results, setResults] = useState<CanvasResultView[]>([]), [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [name, setName] = useState(""), [prompt, setPrompt] = useState(""), [references, setReferences] = useState<string[]>([]), [templateKey, setTemplateKey] = useState<TemplateKey>("freeform");
  const [showCreate, setShowCreate] = useState(!initialBriefId), [search, setSearch] = useState(""), [projectFilter, setProjectFilter] = useState("all");
  const [resultFilter, setResultFilter] = useState("all"), [rejecting, setRejecting] = useState(false), [rejectionReason, setRejectionReason] = useState("");
  const [nextPrompt, setNextPrompt] = useState(""), [templateVersionId, setTemplateVersionId] = useState("");
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [status, setStatus] = useState("尚未连接画布"), [pluginUrl, setPluginUrl] = useState("");
  const [productionTarget, setProductionTarget] = useState<{ projectId?: string; name: string; kind?: ProductionKind } | null>(null);
  const disconnect = useRef<(() => void) | undefined>(undefined), working = useRef(false);
  const createAttempt = useRef({ signature: "", requestId: "" });
  const activeBrief = useRef<string | undefined>(initialBriefId), loadedBrief = useRef<string | undefined>(undefined), readGeneration = useRef(0);
  const title = useRef<HTMLHeadingElement>(null);
  function rememberBrief(id?: string) {
    activeBrief.current = id;
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("brief", id); else url.searchParams.delete("brief");
    window.history.replaceState(null, "", url.href);
  }
  const loadBrief = useCallback(async (id: string) => {
    const generation = ++readGeneration.current;
    const [data, result] = await Promise.all([canvasApi(`briefs/${id}`), canvasApi(`briefs/${id}/results`)]);
    if (activeBrief.current !== id || generation !== readGeneration.current) return;
    const next = CanvasBriefSchema.parse(data);
    if (loadedBrief.current !== id) {
      setSelected([]); setNextPrompt(nextCanvasPrompt(next)); setTemplateVersionId(""); setRejecting(false); setResultFilter("all");
    }
    loadedBrief.current = id; setBrief(next); setResults(CanvasResultViewSchema.array().parse(result.items));
  }, []);
  const reload = useCallback(async () => {
    const [list, options, production] = await Promise.all([canvasApi("briefs"), canvasApi("options"), canvasApi("production-templates")]);
    setRows(list as unknown as CanvasBriefRow[]); setAssets(options.referenceAssets as Asset[]); setTemplates(CanvasProductionTemplateSchema.array().parse(production.items));
    if (activeBrief.current) await loadBrief(activeBrief.current);
  }, [loadBrief]);
  useEffect(() => {
    setPluginUrl(`${window.location.origin}/plugins/${CANVAS_BRIDGE.pluginFile}`);
    void reload().catch((cause: unknown) => setError(message(cause))).finally(() => setLoading(false));
    return () => { disconnect.current?.(); readGeneration.current += 1; };
  }, [reload]);
  async function perform(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (cause) { setError(message(cause)); }
    finally { working.current = false; setBusy(false); }
  }
  function resetConnection() { disconnect.current?.(); disconnect.current = undefined; setStatus("尚未连接画布"); }
  async function activate(id: string) {
    resetConnection(); rememberBrief(id); setShowCreate(false);
    if (loadedBrief.current !== id) { setBrief(undefined); setResults([]); }
    await loadBrief(id); title.current?.focus();
  }
  function startNew() {
    if (busy) return;
    resetConnection(); rememberBrief(); readGeneration.current += 1; loadedBrief.current = undefined;
    setBrief(undefined); setResults([]); setShowCreate(true); setName(""); setPrompt(""); setReferences([]); setTemplateKey("freeform"); setError(""); setNotice("");
    createAttempt.current = { signature: "", requestId: "" };
  }
  function chooseTemplate(key: TemplateKey) {
    setTemplateKey(key); setPrompt(CANVAS_WORKFLOW_TEMPLATES.find((template) => template.key === key)!.steps[0]!.instructions);
  }
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const signature = JSON.stringify({ name, prompt, referenceAssetIds: references, templateKey });
    if (createAttempt.current.signature !== signature) createAttempt.current = { signature, requestId: crypto.randomUUID() };
    const parsed = CreateCanvasBriefInputSchema.safeParse({ name, prompt, referenceAssetIds: references, templateKey, requestId: createAttempt.current.requestId });
    if (!parsed.success) { setError("请填写需求名称和创作说明，参考素材最多选择 10 张。"); return; }
    await perform(async () => { const created = CanvasBriefSchema.parse(await canvasApi("briefs", parsed.data)); await activate(created.id); await reload(); setNotice("创作项目已保存。打开画布即可开始当前步骤。"); });
  }
  function openCanvas() {
    if (!canvasUrl || !brief) return;
    resetConnection();
    const channelId = crypto.randomUUID(), url = new URL(canvasUrl), boundId = brief.id;
    url.searchParams.set("yummyaiOrigin", window.location.origin); url.searchParams.set("yummyaiChannel", channelId);
    const popup = window.open(url.href, "yummyai-creative-canvas");
    if (!popup) { setError("浏览器阻止了新窗口，请允许此页面打开画布后重试。"); return; }
    disconnect.current = connectCanvas({ popup, origin: url.origin, channelId, briefId: boundId,
      onStatus: (value) => { if (activeBrief.current === boundId) setStatus(value); },
      onResult: () => { void reload().catch((cause: unknown) => setError(message(cause))); },
    });
    setStatus("画布已打开，等待插件连接。首次使用请展开下方连接说明。");
  }
  async function review(decision: "approve" | "reject") {
    if (!brief) return;
    const ids = canvasResultSelection(results, selected).pending.map((row) => row.versionId);
    await perform(async () => {
      const response = await canvasApi(`briefs/${brief.id}/review`, { versionIds: ids, decision, ...(decision === "reject" ? { rejectionReason } : {}) });
      const outcomes = response.outcomes as Array<{ versionId: string; ok: boolean }>;
      const failed = outcomes.filter((outcome) => !outcome.ok).length;
      await reload(); setRejecting(false);
      if (decision === "reject") setSelected((current) => current.filter((id) => !outcomes.some((outcome) => outcome.versionId === id && outcome.ok)));
      setNotice(`已${decision === "approve" ? "批准" : "退回"} ${outcomes.length - failed} 个方案。${failed ? `${failed} 个方案状态已变化，请重新核对。` : ""}`);
    });
  }
  async function continueWorkflow() {
    if (!brief) return;
    await perform(async () => {
      const next = CanvasBriefSchema.parse(await canvasApi(`briefs/${brief.id}/continue`, { versionIds: selection.approved.map((row) => row.versionId), prompt: nextPrompt }));
      await activate(next.id); await reload(); setNotice("下一步已创建，已通过的方案已作为参考素材带入。打开画布继续制作。");
    });
  }
  async function production() {
    if (!brief) return;
    const template = templates.find((item) => item.versionId === templateVersionId);
    if (!template) return;
    await perform(async () => {
      let success = 0; const failures: string[] = [];
      for (const result of selection.approved) {
        try { await canvasApi(`briefs/${brief.id}/production`, { versionId: result.versionId, templateProjectId: template.projectId, templateVersionId: template.versionId }); success += 1; }
        catch (cause) { failures.push(`${result.name}：${message(cause)}`); }
      }
      await reload(); setNotice(`已关联 ${success} 份生产草稿，可从对应方案下打开。`);
      if (failures.length) setError(failures.join("；"));
    });
  }
  async function copyPlugin() { try { await navigator.clipboard.writeText(pluginUrl); setNotice("插件地址已复制，请在原版画布的第三方插件中安装。"); } catch { setError("复制失败，请选择并复制插件地址。"); } }
  const allProjects = recentCanvasProjects(rows);
  const projects = allProjects.filter((project) => project.name.toLowerCase().includes(search.trim().toLowerCase()) && (projectFilter === "all" || (projectFilter === "review" ? project.latest.status === "awaiting_review" : projectFilter === "done" ? project.latest.status === "completed" || project.latest.status === "cancelled" : project.latest.status === "running")));
  const selection = canvasResultSelection(results, selected), nextStep = brief?.workflow?.template.steps[(brief?.workflow?.stepIndex ?? 0) + 1];
  const visibleResults = results.filter((result) => resultFilter === "all" || result.status === resultFilter);
  const eligibleTemplates = templates.filter((template) => !brief?.workflow?.template.productType || template.productType === brief.workflow.template.productType);
  const canAdvance = !busy && !selection.unreviewed && results.length > 0 && results.length === brief?.resultCount && selection.approved.length > 0 && brief.status !== "cancelled";
  const selectedTemplate = CANVAS_WORKFLOW_TEMPLATES.find((template) => template.key === templateKey)!;
  if (productionTarget && brief) return <ProductionEditorSession title={productionTarget.name}
    subtitle={`创意项目：${brief.name} · ${productionTarget.projectId ? "生产草稿" : "通用工艺底稿"}`}
    returnLabel="返回当前创意项目" projectId={productionTarget.projectId} kind={productionTarget.kind}
    onClose={() => { setProductionTarget(null); void perform(reload); requestAnimationFrame(() => title.current?.focus()); }} />;

  return <div className="canvas-erp-workspace" aria-busy={busy || loading}>
    <header className="canvas-erp-header"><div><h1>创意工作台</h1><p>从模板开始，在这里筛选方案、完成审核并继续生产作图。</p></div><div className="canvas-actions"><details className="canvas-tools-menu"><summary>辅助工具</summary><nav aria-label="创意辅助工具"><Link href="/creative-designs">批量生图</Link><Link href="/pod-workbench">图片处理工具</Link><Link href="/design">设计任务与校样</Link></nav></details><button type="button" onClick={() => void perform(reload)} disabled={busy || loading}><RefreshCw size={15} />刷新任务</button><button type="button" className="primary" onClick={startNew} disabled={busy}><Plus size={16} />新建创作</button></div></header>
    {error ? <p role="alert" className="canvas-notice error">{error}</p> : null}{notice ? <p role="status" className="canvas-notice">{notice}</p> : null}
    {!canvasUrl ? <p className="canvas-notice error">画布地址未配置或无效，请先完成画布部署。</p> : null}
    <div className="canvas-workbench-layout">
      <aside className="canvas-projects" aria-label="创作项目"><h2><FolderOpen size={16} aria-hidden="true" />最近项目 <small>{recentCanvasProjects(rows).length}</small></h2>
        <label className="canvas-search"><Search size={16} /><input aria-label="搜索创作项目" placeholder="搜索项目名称" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <select aria-label="筛选项目状态" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="all">全部项目</option><option value="active">待创作</option><option value="review">待审核</option><option value="done">已完成审核 / 已取消</option></select>
        {loading ? <p role="status" className="canvas-help">正在读取项目…</p> : projects.length ? <div className="canvas-project-list">{projects.map((project) => <button type="button" key={project.rootId} disabled={busy} aria-pressed={project.rootId === (brief?.workflow?.rootBatchId ?? brief?.id)} onClick={() => void perform(() => activate(project.latest.id))}>
          <b>{project.name}</b><small>{project.latest.workflow?.template.name ?? "自由创作"} · 第 {(project.latest.workflow?.stepIndex ?? 0) + 1} 步</small>
          <span><i className={`canvas-status-dot ${project.latest.status}`} />{project.latest.status === "cancelled" ? "已取消" : project.latest.status === "completed" ? "本步审核完成" : project.latest.resultCount ? "待审核" : "待创作"}<small>{project.latest.approvedCount ?? 0}/{project.latest.resultCount} 已通过</small></span>
        </button>)}</div> : <p className="canvas-help">{search || projectFilter !== "all" ? "没有匹配的项目。" : "还没有项目，选一个模板开始。"}</p>}
      </aside>
      <label className="canvas-mobile-projects">切换创作项目<select aria-label="切换创作项目" disabled={busy || loading} value={allProjects.find((project) => project.rootId === (brief?.workflow?.rootBatchId ?? brief?.id))?.latest.id ?? ""} onChange={(event) => { if (event.target.value) void perform(() => activate(event.target.value)); }}><option value="">选择最近项目</option>{allProjects.map((project) => <option key={project.rootId} value={project.latest.id}>{project.name} · 第 {(project.latest.workflow?.stepIndex ?? 0) + 1} 步</option>)}</select></label>
      <div className="canvas-workbench-main">
        {showCreate ? <section className="canvas-create"><header className="canvas-section-header"><div><h2>从模板开始</h2><p>每个项目保留自己的步骤与审核记录。</p></div></header>
          <div className="canvas-template-grid">{CANVAS_WORKFLOW_TEMPLATES.map((template) => { const Icon = TEMPLATE_ICONS[template.key]; return <SpotlightCard key={template.key} className={`canvas-template ${templateKey === template.key ? "selected" : ""}`}><button type="button" disabled={busy} aria-pressed={templateKey === template.key} onClick={() => chooseTemplate(template.key)}><Icon size={22} /><b>{template.name}</b><span>{template.description}</span><small>{template.steps.length} 个创作步骤 · 人工审核</small></button></SpotlightCard>; })}</div>
          <div className="canvas-template-summary"><LayoutTemplate size={16} /><b>{selectedTemplate.name}</b><span>{selectedTemplate.steps.map((step) => step.name).join(" → ")}</span></div>
          <form className="canvas-brief-form" onSubmit={(event) => void create(event)}><fieldset disabled={busy || loading}><div className="canvas-create-fields">
            <div><label>需求名称<input value={name} maxLength={160} required onChange={(event) => setName(event.target.value)} placeholder="例如：备胎罩山野露营系列" /></label><label>创作说明<textarea value={prompt} maxLength={8000} required rows={5} onChange={(event) => setPrompt(event.target.value)} placeholder="描述主题、文字、风格和需要保留的元素" /></label></div>
            <div><h3>授权参考素材 <small>{references.length}/10</small></h3><p className="canvas-help">只显示已批准的通用素材。买家定制订单在订单工作台中处理。</p>
              {assets.length ? <div className="canvas-asset-choices">{assets.map((asset) => <label className="canvas-check" key={asset.id}><input type="checkbox" checked={references.includes(asset.id)} disabled={!references.includes(asset.id) && references.length >= 10} onChange={(event) => setReferences((current) => event.target.checked ? [...current, asset.id] : current.filter((id) => id !== asset.id))} /><FileImage size={15} /><span>{asset.fileName}</span></label>)}</div> : <p className="canvas-help">暂无授权素材，可以先创建纯文字需求。</p>}
            </div></div><button className="primary" type="submit" disabled={busy || loading || !name.trim() || !prompt.trim()}>{busy ? "保存中…" : "保存创作需求"}<ArrowRight size={16} /></button></fieldset></form>
        </section> : brief ? <>
          <section className="canvas-current"><header className="canvas-section-header"><div><small>{brief.workflow?.template.name ?? "自由创作"}</small><h2 ref={title} tabIndex={-1}>{brief.name}</h2></div><div className="canvas-actions">
            {brief.nextBriefId ? <button className="primary" disabled={busy} onClick={() => void perform(() => activate(brief.nextBriefId!))}>打开下一步<ArrowRight size={16} /></button> : <div className="canvas-open-action"><button type="button" className="primary" disabled={!canvasUrl || busy || brief.status === "cancelled"} onClick={openCanvas}><ExternalLink size={16} />打开创意画布</button><small>在独立窗口打开无限画布</small></div>}
          </div></header>
          <ol className="canvas-step-rail" aria-label="创作步骤">{(brief.workflow?.template.steps ?? [{ key: "create", name: "创作与审核", instructions: "" }]).map((step, index) => {
            const current = brief.workflow?.stepIndex ?? 0;
            const row = rows.find((item) => item.workflow?.rootBatchId === brief.workflow?.rootBatchId && item.workflow?.stepIndex === index);
            return <li key={step.key} aria-current={index === current ? "step" : undefined}><button type="button" disabled={busy || !row || row.id === brief.id} onClick={() => row && void perform(() => activate(row.id))}><span className="canvas-step-number">{index < current || index === current && brief.nextBriefId ? <Check size={15} /> : index + 1}</span><span><b>{step.name}</b><small>{index < current || index === current && brief.nextBriefId ? "已继续" : index === current ? selection.unreviewed ? `${selection.unreviewed} 个方案待审核` : brief.resultCount ? "本步审核完成" : "当前步骤" : row ? "已创建" : "未开始"}</small></span></button></li>;
          })}</ol>
          <details className="canvas-brief-details"><summary>创作要求与参考素材 <small>{brief.referenceAssets.length} 张素材 · {brief.resultCount}/4 个方案</small></summary><p className="canvas-brief-prompt">{brief.prompt}</p>{brief.negativePrompt ? <p>避免：{brief.negativePrompt}</p> : null}<ul>{brief.referenceAssets.map((asset) => <li key={asset.id}><FileImage size={14} />{asset.fileName}</li>)}</ul></details>
          <p className="canvas-connection-state"><Workflow size={15} />{status}</p><p className="canvas-help">作图时保留本页。刷新或关闭本页后，重新点击“打开创意画布”恢复连接。</p>
          </section>
          <section className="canvas-review"><header className="canvas-section-header"><div><h2>方案与审核 <small>{results.length}/4</small></h2><p>先查看大图，批准保留的方案；退回原因会随版本保存。</p></div></header>
            {results.length !== brief.resultCount ? <p className="canvas-notice error" role="alert">部分方案的素材不可用，请刷新重试；恢复完整结果后才能继续。</p> : null}
            {results.length ? <><div className="canvas-result-toolbar"><select aria-label="筛选方案状态" value={resultFilter} onChange={(event) => setResultFilter(event.target.value)}><option value="all">全部方案</option><option value="pending_review">待审核</option><option value="approved">已通过</option><option value="rejected">已退回</option></select><button disabled={busy || !visibleResults.some((result) => result.status === "pending_review" || result.status === "approved")} onClick={() => setSelected(visibleResults.filter((result) => result.status === "pending_review" || result.status === "approved").map((result) => result.versionId))}>全选可用方案</button><button disabled={busy || !selected.length} onClick={() => setSelected([])}>清空选择</button><span className="canvas-help">已选 {selected.length} 个</span></div>
              {visibleResults.length ? <CanvasResults results={visibleResults} selected={selected} disabled={busy} onSelection={setSelected} onOpenProduction={(projectId, name) => setProductionTarget({ projectId, name })} /> : <p className="canvas-empty">此状态下暂无方案。</p>}
              <div className="canvas-review-actions"><button className="primary" disabled={busy || !selection.pending.length} onClick={() => void review("approve")}><Check size={16} />批准选中{selection.pending.length ? `（${selection.pending.length}）` : ""}</button><button disabled={busy || !selection.pending.length} onClick={() => setRejecting(true)}><X size={16} />退回选中</button><span className="canvas-help">审核通过后作为创意母版保留，生产文件仍需工艺检查。</span></div>
              {rejecting ? <form className="canvas-rejection-form" onSubmit={(event) => { event.preventDefault(); void review("reject"); }}><label>退回原因<textarea rows={2} value={rejectionReason} maxLength={1000} required onChange={(event) => setRejectionReason(event.target.value)} placeholder="例如：文字拼写需修正，或边缘有明显缺口" /></label><div className="canvas-actions"><button type="submit" disabled={busy || !rejectionReason.trim() || !selection.pending.length}>确认退回</button><button type="button" disabled={busy} onClick={() => setRejecting(false)}>取消</button></div></form> : null}
            </> : <div className="canvas-empty"><FileImage size={30} /><h3>等待画布回传方案</h3><p>在画布的「ERP 创作任务」节点选择图片，提交后会显示在这里。每个步骤最多 4 个方案。</p></div>}
          </section>
          {brief.status !== "cancelled" && !brief.nextBriefId && results.length > 0 ? <section className="canvas-next"><header><span className="canvas-eyebrow">下一步</span><h2>{nextStep ? nextStep.name : "关联工艺底稿，制作生产图"}</h2><p>{selection.unreviewed ? `还有 ${selection.unreviewed} 个方案未完成审核。` : "当前方案已完成审核，勾选要继续使用的已通过方案。"}</p></header>
            {nextStep ? <><label>下一步创作说明<textarea rows={3} maxLength={8000} value={nextPrompt} onChange={(event) => setNextPrompt(event.target.value)} disabled={busy} /></label><button className="primary" disabled={!canAdvance || !nextPrompt.trim()} onClick={() => void continueWorkflow()}>用选中方案继续<ArrowRight size={16} /></button></> : <>
              <label>产品工艺底稿<select aria-label="产品工艺底稿" value={templateVersionId} disabled={busy} onChange={(event) => setTemplateVersionId(event.target.value)}><option value="">选择已审核的通用工艺底稿</option>{eligibleTemplates.map((template) => <option key={template.versionId} value={template.versionId}>{template.name} · {template.productType === "tire_cover" ? "备胎罩" : "异形抱枕"} · V{template.versionNumber}</option>)}</select></label>
              <p className="canvas-help">复用底稿的尺寸、工艺参数与轮廓，另建生产草稿并导入选中图案。原有图文不复制，新稿需重新确认尺寸、摆放和工艺。</p>
              {!eligibleTemplates.length ? <p className="canvas-notice">暂无可用工艺底稿。点击下方“配置工艺底稿”，核对并审核后返回当前项目即可选择。</p> : null}
              <div className="canvas-actions"><button className="primary" disabled={!canAdvance || !eligibleTemplates.some((template) => template.versionId === templateVersionId)} onClick={() => void production()}>生成生产草稿{selection.approved.length ? `（${selection.approved.length}）` : ""}<ArrowRight size={16} /></button><button type="button" disabled={busy} onClick={() => setProductionTarget({ name: "配置工艺底稿", kind: brief.workflow?.template.productType ?? undefined })}>配置工艺底稿</button></div>
            </>}
          </section> : null}
        </> : <div className="canvas-empty" role="status">{loading || busy ? "正在读取创作项目…" : "从左侧选择一个项目，或新建创作。"}</div>}
        <details className="canvas-setup"><summary>画布连接与插件安装</summary><ol><li>打开原版画布顶部的“节点插件 → 第三方插件”，粘贴下方地址并安装。1.0.0 仍可单张回传；批量功能使用 1.1.0。</li><li>在底部“扩展节点”中添加“ERP 创作任务”。左侧点击节点名称可定位表单。</li><li>点击“读取当前需求”，加入步骤和参考素材；完成设计后选择图片回传。</li></ol><label>插件地址<input readOnly value={pluginUrl} onFocus={(event) => event.currentTarget.select()} /></label><button type="button" onClick={() => void copyPlugin()}><Copy size={14} />复制插件地址</button><p>画布 {CANVAS_BRIDGE.upstreamVersion} · 插件 {CANVAS_BRIDGE.pluginVersion}。AI 生图由原版画布中配置的模型执行；创建任务不会自动调用模型。</p></details>
      </div>
    </div>
  </div>;
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : "操作失败，请刷新后重试"; }
