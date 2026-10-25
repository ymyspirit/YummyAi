"use client";
import { useLayoutEffect, useRef, useState, useEffect } from "react";
import Link from "next/link";
import { ChevronDown, FileCheck2, ImageIcon, RefreshCw, Settings2, X } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { STUDIO_PERSONAL_CLEAR_EVENT } from "@yummyai/contracts/pod/studio-personal";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import type { ProductVisualProject, ProductVisualWorkspace, VisualSlotKey } from "@yummyai/contracts/catalog/product-visuals";
import type { ProductVisualImageOriginal } from "@yummyai/contracts/catalog/product-visual-generation";
import type { StudioImageBudgetWorkspace } from "@yummyai/contracts/pod/studio-image-budget";
import { assertStudioCurrent, studioReadDenied, StudioApiError, useStudioAccessFence } from "../creative-studio/studio-api";
import { studioImageHash, studioImagePrincipal } from "../creative-studio/studio-image-generation-client";
import { clearStudioImageGenerationIntents, createStudioImageGenerationIntent, studioImageTerminal, type StudioImageGenerationSnapshot } from "../creative-studio/studio-image-generation-intent";
import { createProductVisualGenerationClient, productVisualImageDraft, PRODUCT_VISUAL_DEFAULT_PROMPT, type ProductVisualGenerationClient } from "./product-visual-generation-client";
import "../creative-studio/studio-image-generation.css";

type Access = ReturnType<typeof useStudioAccessFence>;
type Model = ProductVisualWorkspace["models"][number];
type Props = { planId: string; project: ProductVisualProject; slotKey: VisualSlotKey; label: string; model?: Model;
  prompt: string; artworkVersionId?: string; canPrepare: boolean; disabledReason: string; onChanged: () => Promise<void>;
  onUseOriginalInput: (input: { prompt: string; artworkVersionId?: string }) => void };
type Binding = { client: ProductVisualGenerationClient; intent: ReturnType<typeof createStudioImageGenerationIntent>; current: () => void };
const empty = (): StudioImageGenerationSnapshot => ({ missing: false, history: [], nextCursor: null });
const statuses = { prepared: "报价已准备 尚未提交", cancelled: "准备已取消", queued: "已明确提交 等待执行", running: "原任务执行中",
  completed: "原件已登记 尚需送审", failed: "原任务失败", uncertain: "原任务结果未知" };
const message = (cause: unknown) => cause instanceof Error && cause.name !== "AbortError" ? cause.message : "当前读取已停止 原编号保持";

export function ProductVisualImageGeneration(props: Props) {
  const access = useStudioAccessFence(`product-visual-image:${props.planId}:${props.project.id}:${props.slotKey}`);
  return <SlotImagePanel key={access.key} {...props} access={access} />;
}
function SlotImagePanel({ access, ...props }: Props & { access: Access }) {
  const [open, setOpen] = useState(false), [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<StudioImageGenerationSnapshot>(empty), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [ack, setAck] = useState<string | null>(null), [clock, setClock] = useState(Date.now), [original, setOriginal] = useState<ProductVisualImageOriginal>();
  const [budget, setBudget] = useState<StudioImageBudgetWorkspace>(), [budgetError, setBudgetError] = useState(""), [preview, setPreview] = useState<string>();
  const alive = useRef(false), blocked = useRef(false), epoch = useRef(0), running = useRef(false), abort = useRef<AbortController | undefined>(undefined);
  const owner = useRef<Binding | undefined>(undefined), content = useRef<HTMLDivElement>(null), previewUrl = useRef<string | undefined>(undefined);
  const pinKey = canonicalJson({ planId: props.planId, snapshot: { ...props.project.snapshot, slotKey: props.slotKey }, slots: props.project.slots });
  const currentPin = useRef(pinKey); currentPin.current = pinKey;
  const releasePreview = () => { if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = undefined; setPreview(undefined); };
  const stop = () => { epoch.current++; abort.current?.abort(); owner.current = undefined; running.current = false; releasePreview(); };
  const hidePrivate = () => { stop(); if (content.current) { content.current.hidden = true; content.current.inert = true; }
    setOpen(false); setReady(false); setBusy(false); setData(empty()); setBudget(undefined); setBudgetError(""); setOriginal(undefined); setAck(null); setNotice(""); };
  useLayoutEffect(() => {
    alive.current = true;
    const clear = () => { blocked.current = true; stop(); if (content.current) { content.current.hidden = true; content.current.inert = true; }
      setOpen(false); setReady(false); setBusy(false); setData(empty()); setError(""); setNotice(""); setAck(null); setOriginal(undefined); setBudget(undefined); setBudgetError("");
      try { clearStudioImageGenerationIntents(sessionStorage); } catch { /* Global identity cleanup covers the same ASSIST namespace. */ } };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); window.addEventListener(STUDIO_PERSONAL_CLEAR_EVENT, clear);
    return () => { alive.current = false; stop(); window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); window.removeEventListener(STUDIO_PERSONAL_CLEAR_EVENT, clear); };
  }, []);
  useEffect(() => {
    if (!open || !access.available || blocked.current) return;
    const controller = new AbortController(), version = ++epoch.current;
    abort.current = controller; running.current = true; setBusy(true); setReady(false); setError(""); setAck(null); setOriginal(undefined); setBudget(undefined); setBudgetError("");
    try {
      const context = access.capture(controller.signal);
      const current = () => { if (!alive.current || blocked.current || epoch.current !== version || currentPin.current !== pinKey) throw new DOMException("原交付读取已结束", "AbortError"); assertStudioCurrent(context); };
      void (async () => { const hash = await studioImageHash(studioImagePrincipal(context.authority)); current();
        const client = createProductVisualGenerationClient({ planId: props.planId, project: props.project, slotKey: props.slotKey, context });
        const intent = createStudioImageGenerationIntent({ client, ownerHash: hash, storage: sessionStorage, current, id: () => crypto.randomUUID() });
        const binding = { client, intent, current }; owner.current = binding;
        await intent.read(); current(); setData(intent.snapshot()); setReady(true);
        if (content.current) { content.current.hidden = false; content.current.inert = false; }
      })().catch(cause => {
        if (controller.signal.aborted || version !== epoch.current || blocked.current) return;
        if (studioReadDenied(cause) || cause instanceof StudioApiError && cause.status === 404) hidePrivate();
        setError(message(cause));
      }).finally(() => { if (version === epoch.current && alive.current && !blocked.current) { running.current = false; setBusy(false); } });
    } catch (cause) { if (version === epoch.current) { running.current = false; setBusy(false); setError(message(cause)); } }
    return () => { stop(); setBusy(false); };
  }, [open, access.available, access.capture, pinKey, attempt]);
  useEffect(() => { if (!open || data.request?.status !== "prepared") return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [open, data.request?.status]);
  useEffect(() => { setAck(null); }, [props.prompt, props.artworkVersionId, props.model?.selectionRevision, props.canPrepare]);
  async function perform(action: (value: Binding) => Promise<void>) {
    const value = owner.current; if (!value || running.current) return;
    running.current = true; setBusy(true); setError(""); setNotice(""); setAck(null); setOriginal(undefined); releasePreview();
    try { value.current(); await action(value); value.current(); setData(value.intent.snapshot()); }
    catch (cause) {
      if (owner.current !== value || blocked.current || !alive.current) return;
      if (studioReadDenied(cause) || cause instanceof StudioApiError && cause.status === 404) hidePrivate();
      else { try { value.current(); setData(value.intent.snapshot()); } catch { return; } }
      setError(message(cause));
    } finally { if (owner.current === value && alive.current && !blocked.current) { running.current = false; setBusy(false); } }
  }
  const request = data.request, marker = data.marker, model = props.model;
  const terminal = !!data.abandoned || !!request && studioImageTerminal(request);
  const expires = request ? Date.parse(request.quote.expiresAt) : 0;
  const draftChanged = !!request && request.status === "prepared" && (request.originalInput.prompt !== (props.prompt.trim() || PRODUCT_VISUAL_DEFAULT_PROMPT)
    || request.originalInput.visualArtworkVersionId !== (props.slotKey === "artwork" ? undefined : props.artworkVersionId));
  const canCommit = ready && props.canPrepare && !draftChanged && !!request && request.status === "prepared" && !marker?.commitHash
    && request.admission.enabled && request.admission.code === "ready" && request.quote.contextAuthority === access.authority && expires > clock
    && model?.id === props.project.snapshot.modelId && model.selectionRevision === request.quote.selectionRevision;
  const verifiedOriginal = original?.inspection.technical.status === "verified" && original.inspection.technical.kind === "image";
  return <section className="studio-paid-image pv-paid-image" aria-label={`${props.label}报价与原请求`} data-visual-slot={props.slotKey} data-visual-group={props.project.id}>
    <button type="button" className="studio-paid-image-toggle" aria-expanded={open} disabled={!access.available} onClick={() => { if (open) { stop(); setOpen(false); setBusy(false); } else { setClock(Date.now()); setOpen(true); } }}><ImageIcon size={14} /><span>核对本张费用</span><ChevronDown size={14} data-open={open} /></button>
    {!open && error && <p role="alert" className="studio-paid-image-error">{error}</p>}
    <div className="studio-paid-image-collapse" data-open={open && !blocked.current} aria-hidden={!open || blocked.current} inert={!open || blocked.current}><div ref={content} className="studio-paid-image-content" role="region" aria-label={`${props.label}单张费用`} aria-busy={busy}>
      <header><h4>{props.label} · 单张报价与确认</h4><button type="button" aria-label={`关闭${props.label}费用`} onClick={() => { stop(); setOpen(false); setBusy(false); }}><X size={14} /></button></header>
      <p className="studio-paid-image-note">准备与只读找回不调用模型 明确确认当前报价后才允许提交 每张图独立核对 原件生成后仍须送审</p>
      {busy && <p role="status">正在核对原编号 未自动重发生成</p>}{error && <p role="alert" className="studio-paid-image-error">{error}</p>}{notice && <p role="status">{notice}</p>}
      <div className="studio-paid-image-actions"><button type="button" disabled={busy} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={13} />只读核对本槽原请求</button>
        <button type="button" disabled={busy || !ready} onClick={() => void perform(async value => { await value.intent.history(); })}>读取本槽历史</button>
        {data.nextCursor && <button type="button" disabled={busy} onClick={() => void perform(async value => { await value.intent.more(); })}>读取更早记录</button>}
        {access.can(Permission.ModelConfigure) && <button type="button" disabled={busy || !ready} onClick={() => void perform(async value => {
          try { const result = await value.client.budget(); value.current(); setBudget(result); setBudgetError(""); }
          catch (cause) { value.current(); setBudget(undefined); if (cause instanceof StudioApiError && cause.code === "studio_image_budget_forbidden") setBudgetError("当前本人无组织预算配置权限 请联系管理员 未采用替代额度"); else if (studioReadDenied(cause)) throw cause; else setBudgetError(message(cause)); }
        })}><Settings2 size={13} />读取组织预算</button>}</div>
      {budgetError && <p role="alert" className="studio-paid-image-error">{budgetError}</p>}
      {budget ? <dl className="studio-paid-image-quote" aria-label="本槽组织预算"><div><dt>UTC月度区间</dt><dd>{budget.periodStart.slice(0, 10)} 至 {budget.periodEnd.slice(0, 10)}</dd></div><div><dt>组织已占用</dt><dd>USD {budget.occupiedUsd}</dd></div><div><dt>组织月预算</dt><dd>{budget.policy ? `USD ${budget.policy.monthlyCapUsd}` : "尚未配置"}</dd></div><div><dt>图片任务上限</dt><dd>{budget.policy?.imageCapSource === "specific" ? `USD ${budget.policy.imageTaskCapUsd}` : budget.policy?.imageCapSource === "default" ? `默认上限 USD ${budget.policy.defaultTaskCapUsd}` : "当前额度尚未核对"}</dd></div></dl>
        : <p className="studio-paid-image-note">组织月预算与本交付预算分别核对 组织额度未读取不代表零额度 提交时服务器会再次核对 可在生图工作台的组织预算面板维护</p>}
      {!!data.history.length && <label>本槽原生图记录<select aria-label={`${props.label}原生图记录`} value={marker?.requestId ?? ""} disabled={busy || !ready || !!marker && !terminal} onChange={event => void perform(async value => { await value.intent.choose(event.target.value); })}>
        <option value="" disabled>选择原记录</option>{marker && !data.history.some(item => item.requestId === marker.requestId) && <option value={marker.requestId}>{marker.requestId}</option>}{data.history.map(item => <option key={item.requestId} value={item.requestId}>{statuses[item.status]} · {item.requestId}</option>)}</select></label>}
      {ready && !marker && <><p>固定模型 {model?.id === props.project.snapshot.modelId ? `${model.providerLabel} / ${model.label}` : "当前模型不可读取 未自动替换"} · {props.project.snapshot.size} · high · 1张</p>
        <p className="studio-paid-image-prompt">本次调整要求 {props.prompt.trim() || PRODUCT_VISUAL_DEFAULT_PROMPT}</p>
        {model?.imagePricing ? <p>当前每张预估 USD {model.imagePricing.estimatedUsd} · 预算预留 USD {model.imagePricing.reservationUsd} · 以固定报价为准</p> : <p role="status">原固定模型尚无可核对的图片价格 请在模型配置核对 不自动切换模型</p>}
        {!props.canPrepare && <p role="status">{props.disabledReason}</p>}
        <button type="button" className="studio-paid-image-primary" disabled={busy || !props.canPrepare || !model?.imagePricing || model.id !== props.project.snapshot.modelId} onClick={() => void perform(async value => {
          if (!props.canPrepare || !model || model.id !== props.project.snapshot.modelId) throw new Error("本张固定模型或制作依据尚未核对");
          await value.intent.prepare(productVisualImageDraft({ snapshot: props.project.snapshot, slotKey: props.slotKey, selectionRevision: model.selectionRevision, artworkVersionId: props.artworkVersionId, prompt: props.prompt }));
        })}>准备本张固定报价</button></>}
      {marker && <section className="studio-paid-image-original" data-visual-image-request={marker.requestId} data-visual-image-status={data.abandoned ? "cancelled" : request?.status ?? "unknown"}>
        <h4>{data.abandoned ? "尚未提交的准备已放弃" : request ? statuses[request.status] : "原操作结果尚未核对"}</h4><p className="studio-paid-image-id">原编号 {marker.requestId}</p>
        {request?.responseAdoption && <p role="status" className="studio-paid-image-note" data-response-adoption={request.responseAdoption.id}>已采用原响应 原执行仍{request.responseAdoption.originalPhase === "failed" ? "失败" : "待核对"} 产物尚未审核</p>}
        {!request && !data.abandoned && <><p role="status">{data.missing ? "当前未找到原记录 不等于从未提交" : "未取得完整原回执"} 原编号保持 未换键重发</p><button type="button" disabled={busy} onClick={() => void perform(async value => { await value.intent.abandon(); })}>放弃服务器确认尚未提交的准备</button></>}
        {request && <><dl className="studio-paid-image-quote"><div><dt>固定图片模型</dt><dd>{request.quote.providerLabel} / {request.quote.label}</dd></div><div><dt>实际参数</dt><dd>{request.quote.size} · {request.quote.quality} · {request.quote.background} · 1张</dd></div><div><dt>每张预估</dt><dd>USD {request.quote.pricing.estimatedUsd}</dd></div><div><dt>本张预算预留</dt><dd>USD {request.quote.pricing.reservationUsd}</dd></div><div><dt>报价依据</dt><dd>{request.quote.pricing.reference}</dd></div><div><dt>报价到期</dt><dd>{new Date(request.quote.expiresAt).toLocaleString("zh-CN")}</dd></div><div><dt>实际费用</dt><dd>{request.execution.costUsd === null ? "实际费用未知" : `USD ${request.execution.costUsd}`}</dd></div><div><dt>预算账本</dt><dd>{request.execution.budgetState === "reserved" ? `仍预留 USD ${request.execution.budgetAmountUsd ?? request.quote.pricing.reservationUsd}` : request.execution.budgetState === "committed" ? "已记账" : request.execution.budgetState === "released" ? "已释放" : "尚未预留"}</dd></div></dl>
          <p className="studio-paid-image-note">预估与预留均非服务商实际账单 未知费用保留预算占用 不按零费用处理 预算预留不代表服务商扣款硬上限</p>
          <details><summary>本张原输入与报价校验</summary><p className="studio-paid-image-prompt">{request.originalInput.prompt}</p><p className="studio-paid-image-id">报价 {request.quote.quoteHash}</p></details>
          <p className="studio-paid-image-note">本张固定销售方案 V{request.quote.visualDelivery?.salesPlanRevision} · {props.label}{request.originalInput.visualArtworkVersionId && <> · 原审核图稿 <code>{request.originalInput.visualArtworkVersionId}</code></>} 当前填写不会改写这份原报价</p>
          {request.status === "prepared" && <>
            {draftChanged && <><p role="status">当前填写与原报价不同 原报价保持 可明确带回原输入后再核对 或取消尚未提交的准备 未自动重报或换键</p>
              <button type="button" disabled={busy} onClick={() => void perform(async value => {
                value.current(); const artworkVersionId = request.originalInput.visualArtworkVersionId;
                if (props.slotKey !== "artwork" && !props.project.tasks.some(task => task.slotKey === "artwork" && task.result !== null && task.result.versionId === artworkVersionId
                  && task.result.status === "approved" && task.controlledReview && !task.technicalIssues.length)) throw new Error("原图稿审核依据当前不可用 未带回替代版本 请取消尚未提交的准备并重新核对");
                props.onUseOriginalInput({ prompt: request.originalInput.prompt, artworkVersionId });
                setNotice("已按原报价带回调整要求与图稿选择 未提交生成 请重新核对本张报价");
              })}>明确带回原报价输入</button></>}
            {!request.admission.enabled && <p role="status">真实付费生成尚未启用 本次仅准备报价 未预留预算 未排队 未调用模型</p>}
            {expires <= clock && <p role="status">本张报价已过期 请取消尚未提交的准备后重新核对</p>}
            {marker.commitHash && <p role="status">本编号曾发起明确提交 尚未核对结果 仅可按原键读取</p>}
            {model?.selectionRevision !== request.quote.selectionRevision && <p role="status">原模型选择版本已变化 未自动换模型 请取消尚未提交的准备后重新报价</p>}
            <label className="studio-paid-image-ack"><input type="checkbox" checked={ack === request.quote.quoteHash} disabled={busy || !canCommit} onChange={event => setAck(event.target.checked ? request.quote.quoteHash : null)} /><span>我已核对本张实际参数 预估费用及预算预留 明确提交本次报价</span></label>
            <div className="studio-paid-image-actions"><button type="button" className="studio-paid-image-primary" disabled={busy || !canCommit || ack !== request.quote.quoteHash} onClick={() => void perform(async value => { await value.intent.commit(request.quote.quoteHash); await props.onChanged(); })}>确认本张报价并提交</button>
              <button type="button" disabled={busy || !ready} onClick={() => void perform(async value => { await value.intent.cancel(); })}>取消本张尚未提交的准备</button></div>
          </>}
          {request.status === "uncertain" && <p role="status">原任务结果未知 仅按原键读取 未核对前不能另起本张图</p>}
          {request.result && <><p>原件已登记 · {request.result.rightsStatus === "approved" ? "权利状态已批准 业务仍需审核" : request.result.rightsStatus === "rejected" ? "权利未通过" : "权利未核对"} · 尚未自动送审</p>
            <div className="studio-paid-image-actions"><button type="button" disabled={busy} onClick={() => void perform(async value => { const result = await value.client.preview(request); value.current(); const url = URL.createObjectURL(result.blob); try { value.current(); previewUrl.current = url; setPreview(url); } catch (cause) { URL.revokeObjectURL(url); throw cause; } })}>查看本张原图</button>
              <button type="button" disabled={busy} onClick={() => void perform(async value => { const result = await value.client.prepareOriginal(request); value.current(); setOriginal(result); })}><FileCheck2 size={13} />核对本张原件与送审入口</button></div></>}
        </>}
        {terminal && <button type="button" disabled={busy} onClick={() => void perform(async value => { await value.intent.beginAnother(); })}>明确开始本槽另一张</button>}
      </section>}
      {preview && <figure className="studio-paid-image-preview"><img src={preview} alt={`${props.label}本次原图预览`} onError={() => { releasePreview(); setError("原图无法完整显示 原文件与任务保持 未送审"); }} /><figcaption>原图预览不代表业务审核或生产批准</figcaption><button type="button" onClick={releasePreview}>关闭原图预览</button></figure>}
      {original && <section className="studio-paid-image-original" aria-label={`${props.label}原件送审核对`} data-original-scope={original.scope}>
        <h4>本槽原件已读取 尚未送审</h4><dl className="studio-paid-image-quote"><div><dt>原项目</dt><dd><code>{original.scope}</code></dd></div><div><dt>原资产版本</dt><dd><code>{original.inspection.source.assetId}</code> · v{original.inspection.source.assetVersion}</dd></div><div><dt>原字节校验</dt><dd><code>{original.inspection.source.checksumSha256}</code></dd></div><div><dt>原件技术检查</dt><dd>{verifiedOriginal ? "完整图片检查通过 权利和业务仍需审核" : `尚不可送审 ${original.inspection.technical.status}${original.inspection.technical.status !== "verified" ? ` / ${original.inspection.technical.code}` : ""}`}</dd></div></dl>
        {verifiedOriginal ? <><p>下一步在本槽项目的素材与审核中 明确填写名称 权利依据并提交项目方案 之后返回本交付逐项审核</p><Link href={`/creative-designs/studio/assets?brief=${original.scope}&reviewOriginal=${original.generationId}`}>打开该槽原件送审</Link></> : <p role="status">原件检查未就绪 未采用替代文件 未提交方案 请重新核对本张原件</p>}
      </section>}
    </div></div>
  </section>;
}
