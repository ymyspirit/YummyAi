"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, ChevronDown, FileInput, ImageIcon, RefreshCw, Settings2, X } from "lucide-react";
import { z } from "zod";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { StudioImagePricingSchema } from "@yummyai/contracts/ai/studio-image-pricing";
import { STUDIO_PERSONAL_CLEAR_EVENT, type StudioModel, type StudioWorkspace } from "@yummyai/contracts/pod/studio-personal";
import { StudioImageBudgetSettingsSchema, type StudioImageBudgetWorkspace } from "@yummyai/contracts/pod/studio-image-budget";
import type { StudioPaidImageInput, StudioPaidImageRequest } from "@yummyai/contracts/pod/studio-paid-image";
import { assertStudioCurrent, StudioApiError, studioReadDenied, type StudioRequestContext } from "./studio-api";
import { createStudioImageGenerationClient, studioImageDecimal, studioImageHash, studioImagePrincipal, type StudioImageGenerationClient } from "./studio-image-generation-client";
import { abandonStudioImagePreparation, clearStudioImageGenerationIntents, createStudioImageGenerationIntent, studioImagePreparationMarkers, studioImageTerminal, type StudioImageGenerationMarker, type StudioImageGenerationSnapshot } from "./studio-image-generation-intent";
import "./studio-image-generation.css";

type Intent = ReturnType<typeof createStudioImageGenerationIntent>;
type Binding = { client: StudioImageGenerationClient; intent: Intent; current: () => void; epoch: number };
type Reference = Awaited<ReturnType<StudioImageGenerationClient["assets"]>>[number];
type PriceTarget = { channelId: string; modelId: string; revision: string };
const empty = (): StudioImageGenerationSnapshot => ({ missing: false, history: [], nextCursor: null });
const statuses: Record<StudioPaidImageRequest["status"], string> = {
  prepared: "报价已准备 尚未提交", cancelled: "准备已取消", queued: "已提交 等待执行", running: "正在执行",
  completed: "原图已登记", failed: "原任务已失败", uncertain: "原任务结果未知",
};
const errorText = (cause: unknown) => cause instanceof z.ZodError ? "生图记录或输入未通过核对 原编号与原稿保持"
  : cause instanceof Error && cause.name !== "AbortError" ? cause.message : "当前操作已停止 原编号保持";
const originalName = (value: string) => value.includes("::") ? value.slice(value.indexOf("::") + 2) : value;

export function StudioImageGenerationPanel({ scope, workspace, active, capture, flush, onReadDenied, onBusy }: {
  scope: string; workspace?: StudioWorkspace; active: boolean; capture: (signal?: AbortSignal) => StudioRequestContext;
  flush: () => Promise<void>; onReadDenied: () => void; onBusy: (value: boolean) => void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [ready, setReady] = useState(false), [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<StudioImageGenerationSnapshot>(empty), [models, setModels] = useState<StudioModel[]>([]), [assets, setAssets] = useState<Reference[]>([]);
  const [modelId, setModelId] = useState(""), [prompt, setPrompt] = useState(""), [size, setSize] = useState("1024x1024");
  const [quality, setQuality] = useState<StudioPaidImageInput["quality"]>("auto"), [background, setBackground] = useState<StudioPaidImageInput["background"]>("auto");
  const [referenceKeys, setReferenceKeys] = useState<string[]>([]), [imported, setImported] = useState<Array<{ key: string; name: string }>>([]);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [modelError, setModelError] = useState(""), [assetError, setAssetError] = useState("");
  const [ack, setAck] = useState<string | null>(null), [clock, setClock] = useState(() => Date.now()), [preview, setPreview] = useState<string>();
  const [priceTarget, setPriceTarget] = useState<PriceTarget>(), [estimated, setEstimated] = useState(""), [reservation, setReservation] = useState(""), [priceReference, setPriceReference] = useState("");
  const [budgetOpen, setBudgetOpen] = useState(false), [budget, setBudget] = useState<StudioImageBudgetWorkspace>(), [budgetError, setBudgetError] = useState("");
  const [monthlyCap, setMonthlyCap] = useState(""), [defaultTaskCap, setDefaultTaskCap] = useState(""), [imageTaskCap, setImageTaskCap] = useState("");
  const [budgetRevision, setBudgetRevision] = useState<string | null>(), [budgetNeedsReview, setBudgetNeedsReview] = useState(false);
  const budgetReadBy = useRef<Binding | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null), alive = useRef(false), cleared = useRef(false), epoch = useRef(0), running = useRef(false);
  const binding = useRef<Binding | undefined>(undefined), abort = useRef<AbortController | undefined>(undefined), previewUrl = useRef<string | undefined>(undefined);
  const workspaceRef = useRef(workspace); workspaceRef.current = workspace;
  const releasePreview = () => { if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = undefined; setPreview(undefined); };
  const available = workspace?.paidImageVersion === 1 && workspace.capabilities.read;

  useLayoutEffect(() => {
    alive.current = true; cleared.current = false;
    const clear = () => {
      cleared.current = true; epoch.current++; if (running.current) abort.current?.abort(); binding.current = undefined; running.current = false;
      if (root.current) { root.current.hidden = true; root.current.inert = true; }
      releasePreview(); setOpen(false); setBusy(false); onBusy(false); setReady(false); setData(empty()); setModels([]); setAssets([]);
      setModelId(""); setPrompt(""); setReferenceKeys([]); setImported([]); setPriceTarget(undefined); setEstimated(""); setReservation(""); setPriceReference("");
      setError(""); setNotice(""); setModelError(""); setAssetError(""); setAck(null);
      setBudgetOpen(false); setBudget(undefined); setBudgetError(""); setMonthlyCap(""); setDefaultTaskCap(""); setImageTaskCap(""); setBudgetRevision(undefined); setBudgetNeedsReview(false); budgetReadBy.current = undefined;
      try { clearStudioImageGenerationIntents(sessionStorage); } catch { /* Global identity clearing also removes this ASSIST child namespace. */ }
    };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); window.addEventListener(STUDIO_PERSONAL_CLEAR_EVENT, clear);
    return () => {
      alive.current = false; epoch.current++; if (running.current) abort.current?.abort(); binding.current = undefined; onBusy(false);
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = undefined;
      window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); window.removeEventListener(STUDIO_PERSONAL_CLEAR_EVENT, clear);
    };
  }, [onBusy]);

  useEffect(() => {
    setReady(false);
    if (!open || !active || !available || cleared.current) return;
    const controller = new AbortController(), generation = ++epoch.current;
    abort.current = controller; binding.current = undefined; budgetReadBy.current = undefined; running.current = true; setBusy(true); onBusy(true); setError(""); setAck(null);
    let context: StudioRequestContext;
    const current = () => {
      if (!alive.current || cleared.current || generation !== epoch.current) throw new DOMException("生图归属已变化", "AbortError");
      const value = workspaceRef.current;
      if (!value?.capabilities.read || value.paidImageVersion !== 1 || value.scope !== scope || value.contextAuthority !== context.authority)
        throw new StudioApiError("当前本人或生图范围已变化 旧内容未采用", 409, "authority_changed");
      assertStudioCurrent(context);
    };
    try {
      const captured = capture(controller.signal);
      context = { ...captured, isCurrent: () => alive.current && !cleared.current && generation === epoch.current
        && workspaceRef.current?.scope === scope && workspaceRef.current?.contextAuthority === captured.authority
        && workspaceRef.current?.capabilities.read === true && workspaceRef.current?.paidImageVersion === 1 && captured.isCurrent() };
      void (async () => {
        const ownerHash = await studioImageHash(studioImagePrincipal(context.authority)); current();
        const client = createStudioImageGenerationClient({ scope, context });
        const intent = createStudioImageGenerationIntent({ client, ownerHash, storage: sessionStorage, current, id: () => crypto.randomUUID() });
        binding.current = { client, intent, current, epoch: generation };
        const results = await Promise.allSettled([intent.read(), client.models(), client.assets()]); current();
        const denial = results.find(item => item.status === "rejected" && studioReadDenied(item.reason));
        if (denial?.status === "rejected") throw denial.reason;
        setData(intent.snapshot()); setReady(results[0].status === "fulfilled");
        if (results[0].status === "rejected") setError(errorText(results[0].reason));
        if (results[1].status === "fulfilled") { setModels(results[1].value); setModelError(""); }
        else { setModels([]); setModelError(errorText(results[1].reason)); }
        if (results[2].status === "fulfilled") { setAssets(results[2].value); setAssetError(""); }
        else { setAssets([]); setAssetError(errorText(results[2].reason)); }
      })().catch(cause => {
        if (controller.signal.aborted || generation !== epoch.current || cleared.current) return;
        if (studioReadDenied(cause)) { releasePreview(); if (root.current) root.current.hidden = true; onReadDenied(); }
        else setError(errorText(cause));
      }).finally(() => {
        if (generation === epoch.current && alive.current && !cleared.current) { running.current = false; setBusy(false); onBusy(false); }
      });
    } catch (cause) {
      running.current = false; setBusy(false); onBusy(false);
      if (studioReadDenied(cause)) { if (root.current) root.current.hidden = true; onReadDenied(); }
      else setError(errorText(cause));
    }
    return () => {
      epoch.current++; if (running.current) abort.current?.abort(); binding.current = undefined; running.current = false; setBusy(false); onBusy(false); releasePreview();
    };
  }, [scope, open, active, available, workspace?.contextAuthority, capture, attempt, onReadDenied, onBusy]);

  useEffect(() => {
    if (!open || !active || data.request?.status !== "prepared") return;
    const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer);
  }, [open, active, data.request?.status]);

  async function perform(action: (value: Binding) => Promise<void>) {
    const value = binding.current; if (!value || running.current) return;
    running.current = true; setBusy(true); onBusy(true); setError(""); setNotice(""); setAck(null); releasePreview();
    try { value.current(); await action(value); value.current(); setData(value.intent.snapshot()); }
    catch (cause) {
      if (binding.current !== value || cleared.current || !alive.current) return;
      if (budgetForbidden(cause)) { budgetReadBy.current = undefined; setBudget(undefined); setBudgetError("当前本人没有组织范围的预算配置权限 请联系组织管理员 原稿与图片请求保持"); return; }
      if (studioReadDenied(cause)) { if (root.current) root.current.hidden = true; onReadDenied(); return; }
      try { value.current(); setData(value.intent.snapshot()); setError(errorText(cause)); } catch { /* Never refill a departed owner. */ }
    } finally {
      if (binding.current === value && alive.current && !cleared.current) { running.current = false; setBusy(false); onBusy(false); }
    }
  }
  const budgetForbidden = (cause: unknown) => cause instanceof StudioApiError && cause.status === 403 && cause.code === "studio_image_budget_forbidden";
  function assertBudget(value: Binding) {
    value.current(); if (!workspaceRef.current?.capabilities.configure) throw new StudioApiError("请联系具备组织范围配置权限的管理员设置预算", 403, "studio_image_budget_forbidden");
  }
  async function readBudget(value: Binding, afterUnconfirmedSave = false) {
    try {
      assertBudget(value); const fresh = await value.client.budget(); assertBudget(value);
      budgetReadBy.current = value; setBudget(fresh); setBudgetError("");
      if (budgetRevision === undefined) setBudgetRevision(fresh.revision);
      setBudgetNeedsReview(previous => previous || afterUnconfirmedSave || budgetRevision !== undefined && budgetRevision !== fresh.revision);
      return true;
    } catch (cause) {
      value.current(); budgetReadBy.current = undefined; setBudget(undefined);
      if (budgetForbidden(cause)) { setBudgetError("当前本人没有组织范围的预算配置权限 请联系组织管理员 原稿与图片请求保持"); return false; }
      if (studioReadDenied(cause)) throw cause;
      setBudgetError(`组织预算暂未核对 ${errorText(cause)} 填写内容保持 未采用替代额度`); return false;
    }
  }
  async function saveBudget(value: Binding) {
    assertBudget(value);
    if (!budget || budgetRevision === undefined || budgetReadBy.current !== value || budgetNeedsReview) throw new Error("请先重新读取组织预算并核对当前版本 未发送保存");
    const settings = (() => {
      try { return StudioImageBudgetSettingsSchema.parse({ revision: budgetRevision, monthlyCapUsd: studioImageDecimal(monthlyCap, 6), defaultTaskCapUsd: studioImageDecimal(defaultTaskCap, 6), imageTaskCapUsd: studioImageDecimal(imageTaskCap, 6) }); }
      catch { setBudgetError("三个预算金额都需要明确填写为大于零的美元金额 最多六位小数 填写内容保持 未发送保存"); return; }
    })();
    if (!settings) return;
    try {
      const fresh = await value.client.saveBudget(settings); assertBudget(value);
      budgetReadBy.current = value; setBudget(fresh); setBudgetRevision(fresh.revision); setBudgetNeedsReview(false); setBudgetError("");
      setNotice("组织预算已保存 未自动准备报价 提交生成或更换原请求编号");
    } catch (cause) {
      value.current(); budgetReadBy.current = undefined; setBudgetNeedsReview(true);
      if (budgetForbidden(cause)) { setBudget(undefined); setBudgetError("当前本人没有组织范围的预算配置权限 请联系组织管理员 填写内容保持 原稿与图片请求保持"); return; }
      if (studioReadDenied(cause)) throw cause;
      const problem = errorText(cause), refreshed = await readBudget(value, true); value.current();
      if (refreshed) setBudgetError(`原保存回执尚未确认 ${problem} 填写内容已保留 已只读刷新组织现值 请核对后按当前版本继续编辑 未自动再次保存`);
    }
  }
  const close = () => { epoch.current++; if (running.current) abort.current?.abort(); binding.current = undefined; budgetReadBy.current = undefined; running.current = false; setBusy(false); onBusy(false); releasePreview(); setBudgetOpen(false); setOpen(false); };
  const selected = models.find(model => model.id === modelId), request = data.request, marker = data.marker;
  const terminal = !!data.abandoned || !!request && studioImageTerminal(request);
  const expires = request ? new Date(request.quote.expiresAt).getTime() : 0;
  const canCommit = ready && !!request && request.status === "prepared" && !marker?.commitHash && request.admission.enabled && request.admission.code === "ready"
    && request.quote.contextAuthority === workspace?.contextAuthority && expires > clock;
  const references = [...new Map([...assets.map(asset => ({ key: asset.key, name: asset.fileName })), ...imported].map(item => [item.key, item])).values()];
  const canWrite = workspace?.capabilities.save && workspace.capabilities.mediaWrite;
  const show = active && open && !cleared.current;

  return <section className="studio-paid-image" data-studio-paid-image="single" hidden={!active}>
    <button className="studio-paid-image-toggle" type="button" aria-expanded={open} onClick={() => { if (open) close(); else { setOpen(true); setClock(Date.now()); } }}>
      <ImageIcon size={15} /><span>生图与费用</span><small>单张 · 先核对报价</small><ChevronDown size={15} data-open={open} />
    </button>
    <div className="studio-paid-image-collapse" data-open={show} aria-hidden={!show} inert={!show}>
      <div ref={root} className="studio-paid-image-content" role="region" aria-label="单张生图与费用" aria-busy={busy}>
        <header><div><h2>单张图片生成</h2><p>先保存原输入与报价 明确确认后才允许提交</p></div><button type="button" aria-label="关闭生图与费用" onClick={close}><X size={15} /></button></header>
        {!available && <p role="status">当前创作服务尚未提供单张生图费用核对 请联系管理员更新服务</p>}
        {available && <>
          <p className="studio-paid-image-note">本入口独立核对单张报价 仅在本次报价明确允许时才可提交 原工作台的多张生图与视频仍暂停</p>
          <div className="studio-paid-image-actions"><button type="button" disabled={busy} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={14} />{ready ? "只读核对原生图请求" : "重试读取本人生图记录"}</button>
            <button type="button" disabled={busy || !ready} onClick={() => void perform(async value => { await value.intent.history(); })}>读取本人生图历史</button>
            {data.nextCursor && <button type="button" disabled={busy || !ready} onClick={() => void perform(async value => { await value.intent.more(); })}>读取更早生图记录</button>}
          </div>
          {busy && <p role="status">正在核对原编号与当前资料 未自动重发生成</p>}
          {error && <p className="studio-paid-image-error" role="alert"><AlertCircle size={15} />{error}</p>}
          {notice && <p className="studio-paid-image-note" role="status">{notice}</p>}
          {workspace?.capabilities.configure && <div className="studio-paid-image-budget">
            <button type="button" aria-expanded={budgetOpen} disabled={busy || !binding.current} onClick={() => {
              if (budgetOpen) setBudgetOpen(false); else { setBudgetOpen(true); void perform(async value => { await readBudget(value); }); }
            }}><Settings2 size={14} />组织预算<ChevronDown size={14} data-open={budgetOpen} /></button>
            <div className="studio-paid-image-collapse" data-open={budgetOpen} aria-hidden={!budgetOpen} inert={!budgetOpen}>
              <div className="studio-paid-image-budget-body" role="region" aria-label="组织预算" data-studio-image-budget-ready={!!budget && budgetReadBy.current === binding.current}>
                <p className="studio-paid-image-note">组织月预算供全部 AI 共享 默认任务预留上限影响未单独配置的任务 单张图片上限只影响 image 这些额度不是服务商强制扣款上限</p>
                <button type="button" disabled={busy} onClick={() => void perform(async value => { await readBudget(value); })}><RefreshCw size={14} />重新读取组织预算</button>
                {budgetError && <p className="studio-paid-image-error" role="alert">{budgetError}</p>}
                {budget && <dl className="studio-paid-image-quote"><div><dt>UTC 当月区间</dt><dd>{new Date(budget.periodStart).toISOString().slice(0, 10)} 至 {new Date(budget.periodEnd).toISOString().slice(0, 10)} 不含结束日</dd></div>
                  <div><dt>当前占用</dt><dd>USD {budget.occupiedUsd} · 已预留与已记账之和</dd></div><div><dt>当前组织月预算</dt><dd>{budget.policy ? `USD ${budget.policy.monthlyCapUsd}` : "尚未配置"}</dd></div>
                  <div><dt>当前默认任务上限</dt><dd>{budget.policy ? `USD ${budget.policy.defaultTaskCapUsd}` : "尚未配置"}</dd></div>
                  <div><dt>当前单张图片上限</dt><dd>{!budget.policy ? "尚未配置" : budget.policy.imageCapSource === "invalid" ? "原图片上限配置无效 请组织管理员核对" : budget.policy.imageCapSource === "default" ? `未单独配置 沿用默认任务上限 USD ${budget.policy.defaultTaskCapUsd}` : budget.policy.imageTaskCapUsd === null ? "当前图片上限尚未核对" : `USD ${budget.policy.imageTaskCapUsd}`}</dd></div>
                </dl>}
                {!budget && !budgetError && <p role="status">组织预算尚未读取 未采用默认数字</p>}
                <p className="studio-paid-image-note">请明确填写三个金额 当前组织现值仅供核对 不会自动覆盖你的填写</p>
                <div className="studio-paid-image-fields"><label>组织月预算美元<input aria-label="组织月预算美元" inputMode="decimal" value={monthlyCap} disabled={busy} onChange={event => setMonthlyCap(event.target.value)} /></label>
                  <label>默认任务预留上限美元<input aria-label="默认任务预留上限美元" inputMode="decimal" value={defaultTaskCap} disabled={busy} onChange={event => setDefaultTaskCap(event.target.value)} /></label>
                  <label>单张图片预留上限美元<input aria-label="单张图片预留上限美元" inputMode="decimal" value={imageTaskCap} disabled={busy} onChange={event => setImageTaskCap(event.target.value)} /></label></div>
                {budget && budgetNeedsReview && <button type="button" disabled={busy || budgetReadBy.current !== binding.current} onClick={() => void perform(async value => {
                  assertBudget(value); if (budgetReadBy.current !== value) throw new Error("请先重新读取组织预算 未更换原版本");
                  setBudgetRevision(budget.revision); setBudgetNeedsReview(false); setBudgetError("");
                })}>按当前版本保留填写内容</button>}
                <button type="button" disabled={busy || !budget || budgetRevision === undefined || budgetReadBy.current !== binding.current || budgetNeedsReview || !monthlyCap.trim() || !defaultTaskCap.trim() || !imageTaskCap.trim()} onClick={() => void perform(saveBudget)}>保存组织预算</button>
              </div>
            </div>
          </div>}
          {!!data.history.length && <label>本人原生图记录<select aria-label="本人单张生图记录" value={marker?.requestId ?? ""} disabled={busy || !ready || !!marker && !terminal} onChange={event => void perform(async value => { await value.intent.choose(event.target.value); })}>
            <option value="" disabled>选择已保存的原记录</option>{marker && !data.history.some(item => item.requestId === marker.requestId) && <option value={marker.requestId}>当前原编号 · {marker.requestId}</option>}
            {data.history.map(item => <option key={item.requestId} value={item.requestId}>{statuses[item.status]} · {item.quote.label} · {item.requestId}</option>)}
          </select></label>}
          {ready && !marker && <>
            <div className="studio-paid-image-actions"><button type="button" disabled={busy} onClick={() => void perform(async value => {
              await flush(); value.current(); const draft = await value.client.draft(); value.current();
              if (!draft) throw new Error("当前没有已保存的图片输入草稿 可以在本面板填写");
              setPrompt(draft.prompt); setSize(draft.size); setQuality(draft.quality); setBackground("auto"); setImported(draft.references); setReferenceKeys(draft.references.map(item => item.key)); setModelId(""); setPriceTarget(undefined);
              setNotice(`已载入保存后的提示词 参考图 尺寸与质量 原模型 ${originalName(draft.model) || "未选择"} 仅供核对 请在本面板明确选择图片模型 数量固定为 1 背景为自动`);
            })}><FileInput size={14} />载入当前输入草稿</button><button type="button" disabled={busy} onClick={() => void perform(async value => { const next = await value.client.models(); value.current(); setModels(next); setModelError(""); })}><RefreshCw size={14} />刷新图片模型</button></div>
            <p className="studio-paid-image-note">只带入已保存的编辑字段 并非完整原请求重放 本面板输入会在准备报价时保存 原工作台草稿不会改写</p>
            <label>图片模型<select aria-label="单张生图图片模型" value={modelId} disabled={busy} onChange={event => { setModelId(event.target.value); setPriceTarget(undefined); }}>
              <option value="">请选择图片模型</option>{modelId && !selected && <option value={modelId}>原选择当前不可用 请明确重选</option>}
              {models.map(model => <option key={model.id} value={model.id}>{model.label} · {model.providerLabel}</option>)}
            </select></label>
            {modelError && <p className="studio-paid-image-error" role="alert">图片模型目录未读完 {modelError}</p>}
            {!modelError && !models.length && <p className="studio-paid-image-note">当前没有可用图片模型 {workspace?.capabilities.configure && <Link href="/settings/ai">打开 ERP 模型配置</Link>}</p>}
            {modelId && !selected && <p role="alert" className="studio-paid-image-error">原选择已失效 未自动替换模型 提示词与参考图保持</p>}
            <label>提示词<textarea aria-label="单张图片提示词" value={prompt} maxLength={8000} rows={4} disabled={busy} onChange={event => setPrompt(event.target.value)} /></label>
            <div className="studio-paid-image-fields"><label>尺寸<input aria-label="单张图片尺寸" value={size} maxLength={30} disabled={busy} onChange={event => setSize(event.target.value)} /></label>
              <label>质量<select aria-label="单张图片质量" value={quality} disabled={busy} onChange={event => setQuality(event.target.value as StudioPaidImageInput["quality"])}><option value="auto">自动</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
              <label>背景<select aria-label="单张图片背景" value={background} disabled={busy} onChange={event => setBackground(event.target.value as StudioPaidImageInput["background"])}><option value="auto">自动</option><option value="transparent">透明</option><option value="opaque">不透明</option></select></label>
            </div>
            <label>已批准参考图 · 最多 10 张<select multiple aria-label="单张图片参考图" value={referenceKeys} disabled={busy} onChange={event => { const next = Array.from(event.target.selectedOptions, option => option.value); if (next.length <= 10) setReferenceKeys(next); else setError("最多选择 10 张已批准参考图"); }}>
              {references.map(item => <option key={item.key} value={item.key}>{item.name}{imported.some(source => source.key === item.key) && !assets.some(asset => asset.key === item.key) ? " · 原草稿引用 由服务器核对" : ""}</option>)}
            </select></label>
            {assetError && <p role="status" className="studio-paid-image-note">参考图目录当前未读完 原草稿引用保留 服务器仍会核对每张参考图 {assetError}</p>}
            {selected && !selected.imagePricing && <p role="status" className="studio-paid-image-note">此图片模型尚未填写每张预估费用与预算预留 无报价不能提交</p>}
            {selected?.imagePricing && <p className="studio-paid-image-note">当前每张预估 USD {selected.imagePricing.estimatedUsd} · 预算预留 USD {selected.imagePricing.reservationUsd} · 最终以固定报价为准</p>}
            {selected && workspace?.capabilities.configure && <button type="button" disabled={busy} onClick={() => void perform(async value => {
              const snapshot = await value.client.configuration(); value.current();
              const matches = snapshot.channels.flatMap(channel => channel.models.filter(model => model.id === selected.id && model.capability === "image").map(model => ({ channel, model })));
              if (matches.length !== 1) throw new Error("图片模型配置已变化 请刷新目录后重新选择");
              const match = matches[0]; if (!match) throw new Error("图片模型配置不可读取");
              setPriceTarget({ channelId: match.channel.id, modelId: match.model.id, revision: match.channel.revision });
              setEstimated(match.model.imagePricing?.estimatedUsd ?? ""); setReservation(match.model.imagePricing?.reservationUsd ?? ""); setPriceReference(match.model.imagePricing?.reference ?? "");
            })}><Settings2 size={14} />{selected.imagePricing ? "核对图片价格设置" : "设置此图片模型价格"}</button>}
            {priceTarget && workspace?.capabilities.configure && <fieldset className="studio-paid-image-pricing"><legend>单张图片价格设置</legend>
              <p className="studio-paid-image-note">由操作者填写估算依据 不继承文本模型的 token 报价 预算预留需大于零 且不小于每张预估 预留不代表服务商硬性费用上限</p>
              <div className="studio-paid-image-fields"><label>每张预估美元<input aria-label="图片每张预估美元" inputMode="decimal" value={estimated} disabled={busy} onChange={event => setEstimated(event.target.value)} /></label>
                <label>每张预算预留美元<input aria-label="图片每张预算预留美元" inputMode="decimal" value={reservation} disabled={busy} onChange={event => setReservation(event.target.value)} /></label></div>
              <label>报价依据<input aria-label="图片报价依据" maxLength={500} value={priceReference} disabled={busy} onChange={event => setPriceReference(event.target.value)} /></label>
              <button type="button" disabled={busy} onClick={() => void perform(async value => {
                if (!workspaceRef.current?.capabilities.configure) throw new StudioApiError("当前本人没有模型配置权限", 403);
                const pricing = StudioImagePricingSchema.parse({ estimatedUsd: studioImageDecimal(estimated, 8), reservationUsd: studioImageDecimal(reservation, 6), reference: priceReference });
                await value.client.savePricing(priceTarget.channelId, priceTarget.modelId, priceTarget.revision, pricing); value.current();
                const next = await value.client.models(); value.current(); setModels(next); setModelId(""); setPriceTarget(undefined); setModelError("");
                setNotice("图片价格已保存 模型版本已更新 请明确重选模型后核对报价 提示词与原稿保持");
              })}>保存图片价格</button><button type="button" disabled={busy} onClick={() => setPriceTarget(undefined)}>收起价格设置</button>
            </fieldset>}
            {!canWrite && <p role="status" className="studio-paid-image-note">当前本人缺少创作保存或素材写入权限 可以只读核对已有记录</p>}
            <button className="studio-paid-image-primary" type="button" disabled={busy || !ready || !selected?.imagePricing || !prompt.trim() || !canWrite || !!modelError} onClick={() => void perform(async value => {
              if (!selected?.imagePricing) throw new Error("请先明确选择已配置图片价格的模型");
              await value.intent.prepare({ capability: "image", modelId: selected.id, selectionRevision: selected.selectionRevision, prompt, size, quality, background, referenceKeys, seconds: 4 });
            })}>核对单张图片费用</button>
          </>}
          {marker && <div className="studio-paid-image-original" data-studio-image-request={marker.requestId} data-studio-image-status={data.abandoned ? "cancelled" : request?.status ?? "unknown"}>
            <h3>{data.abandoned ? "尚未提交的准备已放弃" : request ? statuses[request.status] : "原准备或提交结果尚未核对"}</h3>
            <p className="studio-paid-image-id">原编号 {marker.requestId}</p>
            {request?.responseAdoption && <p role="status" className="studio-paid-image-note" data-response-adoption={request.responseAdoption.id}>已采用原响应 原执行仍{request.responseAdoption.originalPhase === "failed" ? "失败" : "待核对"} 产物尚未审核</p>}
            {!request && !data.abandoned && <p role="status">{data.missing ? "当前未找到原记录 未找到不等于未提交" : "未取得完整原回执"} 原编号保持 不会自动生成新编号或再次提交</p>}
            {data.abandoned && <p role="status">服务器已按原编号确认放弃尚未提交的准备 该编号不能迟到启动生成</p>}
            {request && <>
              <dl className="studio-paid-image-quote"><div><dt>图片模型</dt><dd>{request.quote.label} · {request.quote.providerLabel}</dd></div><div><dt>实际参数</dt><dd>{request.quote.size} · {request.quote.quality} · {request.quote.background} · 1 张</dd></div>
                <div><dt>每张预估费用</dt><dd>USD {request.quote.pricing.estimatedUsd}</dd></div><div><dt>本次预算预留</dt><dd>USD {request.quote.pricing.reservationUsd}</dd></div>
                <div><dt>报价依据</dt><dd>{request.quote.pricing.reference}</dd></div><div><dt>报价到期</dt><dd>{new Date(request.quote.expiresAt).toLocaleString()}</dd></div>
                <div><dt>实际费用</dt><dd>{request.execution.costUsd === null ? "实际费用未知" : `USD ${request.execution.costUsd}`}</dd></div><div><dt>预算状态</dt><dd>{request.execution.budgetState === "reserved" ? `仍预留 USD ${request.execution.budgetAmountUsd ?? request.quote.pricing.reservationUsd}` : request.execution.budgetState === "committed" ? "已记账" : request.execution.budgetState === "released" ? "已释放" : "尚未预留"}</dd></div>
              </dl>
              <p className="studio-paid-image-note">此报价为操作者估算 并非服务商实际账单 预算预留不代表服务商硬性费用上限 未知实际费用不会当作零费用或结算完成</p>
              <details><summary>原输入与固定报价</summary><p className="studio-paid-image-prompt">{request.input.prompt}</p><p>参考图 {request.quote.references.length} 张 · 本次固定生成 1 张</p><p className="studio-paid-image-id">报价 {request.quote.quoteHash}</p></details>
              {request.status === "prepared" && <>
                {!request.admission.enabled && <p role="status" className="studio-paid-image-note">真实付费生成尚未启用 本次仅保存了准备 未预留预算 未排队 未调用模型</p>}
                {request.quote.contextAuthority !== workspace?.contextAuthority && <p role="status">原报价的权限版本已变化 仅供只读核对 请取消尚未提交的准备后重新报价</p>}
                {expires <= clock && <p role="status">本次报价已过期 请取消尚未提交的准备后重新报价</p>}
                {marker.commitHash && <p role="status">本编号已发起过明确提交 未确认是否生效 仅可只读核对 不会再次提交</p>}
                <label className="studio-paid-image-ack"><input type="checkbox" checked={ack === request.quote.quoteHash} disabled={busy || !canCommit || !canWrite} onChange={event => setAck(event.target.checked ? request.quote.quoteHash : null)} /><span>我已核对本次单张图片的实际参数 预估费用和预算预留</span></label>
                <div className="studio-paid-image-actions"><button className="studio-paid-image-primary" type="button" disabled={busy || !canCommit || !canWrite || ack !== request.quote.quoteHash} onClick={() => void perform(async value => { await value.intent.commit(request.quote.quoteHash); })}>确认本次报价并提交</button>
                  <button type="button" disabled={busy || !ready} onClick={() => void perform(async value => { await value.intent.cancel(); })}>取消尚未提交的准备</button></div>
              </>}
              {request.status === "uncertain" && <p role="status">原任务结果未知 请按原编号只读核对 未确认前不能另起同一张图</p>}
              {request.result && <><p>原图已登记 · {request.result.rightsStatus === "approved" ? "权利已批准" : request.result.rightsStatus === "rejected" ? "权利未通过" : "权利未核验 仍需审核"} · {request.result.byteSize} B</p>
                <button type="button" disabled={busy} onClick={() => void perform(async value => {
                  const result = await value.client.preview(request); value.current(); const url = URL.createObjectURL(result.blob);
                  try { value.current(); previewUrl.current = url; setPreview(url); } catch (cause) { URL.revokeObjectURL(url); throw cause; }
                })}>查看本次原图</button><Link href={`/creative-designs/studio/assets?brief=${encodeURIComponent(scope)}`}>进入素材与审核</Link></>}
            </>}
            {!request && !data.abandoned && <><p className="studio-paid-image-note">放弃操作只会结束服务器确认尚未提交的准备 如已开始生成则拒绝 不能据此判断未收费</p><button type="button" disabled={busy} onClick={() => void perform(async value => { await value.intent.abandon(); })}>放弃尚未提交的准备</button></>}
            {terminal && <button type="button" disabled={busy} onClick={() => void perform(async value => { await value.intent.beginAnother(); setModelId(""); setReady(true); setNotice("原记录仍保留在本人历史 请明确选择模型后准备下一张"); })}>明确开始另一张</button>}
          </div>}
          {preview && <figure className="studio-paid-image-preview"><img src={preview} alt="本次单张生图原图" onError={() => { releasePreview(); setError("本次原图无法在浏览器解码 原文件与任务状态保持"); }} /><figcaption>原图技术预览不代表业务审核或生产批准</figcaption><button type="button" onClick={releasePreview}>关闭原图预览</button></figure>}
        </>}
      </div>
    </div>
  </section>;
}

/** A cancellation-only entry after project read access has ended. It never
 * revives the old workspace, iframe, quote, prompt, source images or execution. */
export function StudioImagePreparationCleanup({ capture, onReadDenied, onBusy }: {
  capture: (signal?: AbortSignal) => StudioRequestContext; onReadDenied: () => void; onBusy: (value: boolean) => void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [ready, setReady] = useState(false), [attempt, setAttempt] = useState(0);
  const [ownerHash, setOwnerHash] = useState(""), [rows, setRows] = useState<ReturnType<typeof studioImagePreparationMarkers>>({ markers: [], invalid: 0, limited: false });
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const root = useRef<HTMLDivElement>(null), alive = useRef(false), cleared = useRef(false), epoch = useRef(0), running = useRef(false), abort = useRef<AbortController | undefined>(undefined);
  const erase = () => {
    cleared.current = true; epoch.current++; if (running.current) abort.current?.abort(); running.current = false;
    if (root.current) { root.current.hidden = true; root.current.inert = true; }
    setOpen(false); setBusy(false); onBusy(false); setReady(false); setOwnerHash(""); setRows({ markers: [], invalid: 0, limited: false }); setError(""); setNotice("");
    try { clearStudioImageGenerationIntents(sessionStorage); } catch { /* Identity clearing owns the same ASSIST child prefix. */ }
  };
  useLayoutEffect(() => {
    alive.current = true; cleared.current = false;
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, erase); window.addEventListener(STUDIO_PERSONAL_CLEAR_EVENT, erase);
    return () => {
      alive.current = false; epoch.current++; if (running.current) abort.current?.abort(); onBusy(false);
      window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, erase); window.removeEventListener(STUDIO_PERSONAL_CLEAR_EVENT, erase);
    };
  }, [onBusy]);
  function contextFor(controller: AbortController, version: number) {
    const captured = capture(controller.signal);
    const context = { ...captured, isCurrent: () => alive.current && !cleared.current && epoch.current === version && captured.isCurrent() };
    return { context, current: () => assertStudioCurrent(context) };
  }
  useEffect(() => {
    if (!open || cleared.current) return;
    const controller = new AbortController(), version = ++epoch.current;
    abort.current = controller; running.current = true; setBusy(true); onBusy(true); setReady(false); setError("");
    void (async () => {
      const value = contextFor(controller, version), hash = await studioImageHash(studioImagePrincipal(value.context.authority)); value.current();
      const markers = studioImagePreparationMarkers(hash, sessionStorage); value.current(); setOwnerHash(hash); setRows(markers); setReady(true);
    })().catch(cause => {
      if (version !== epoch.current || controller.signal.aborted || !alive.current || cleared.current) return;
      if (studioReadDenied(cause)) { erase(); onReadDenied(); } else setError(errorText(cause));
    }).finally(() => { if (version === epoch.current && alive.current && !cleared.current) { running.current = false; setBusy(false); onBusy(false); } });
    return () => { epoch.current++; if (running.current) abort.current?.abort(); running.current = false; setBusy(false); onBusy(false); };
  }, [open, attempt, capture, onReadDenied, onBusy]);
  async function abandon(marker: StudioImageGenerationMarker) {
    if (!ready || running.current || !ownerHash || cleared.current) return;
    const controller = new AbortController(), version = ++epoch.current;
    abort.current = controller; running.current = true; setBusy(true); onBusy(true); setError(""); setNotice("");
    try {
      const value = contextFor(controller, version), hash = await studioImageHash(studioImagePrincipal(value.context.authority)); value.current();
      if (hash !== ownerHash) throw new StudioApiError("当前本人已变化 原准备标识已隐藏", 409, "authority_changed");
      const client = createStudioImageGenerationClient({ scope: marker.scope, context: value.context });
      await abandonStudioImagePreparation({ ownerHash: hash, marker, storage: sessionStorage, current: value.current, abandon: (targetScope, requestId) => {
        if (targetScope !== client.scope) throw new Error("原准备归属已变化 未放弃其他范围"); return client.abandon(requestId);
      } }); value.current();
      const remaining = studioImagePreparationMarkers(hash, sessionStorage); value.current(); setRows(remaining);
      setNotice("服务器已按原编号确认放弃尚未提交的准备 本地活动标识已清除 原不可变记录保留");
    } catch (cause) {
      if (version !== epoch.current || controller.signal.aborted || !alive.current || cleared.current) return;
      if (studioReadDenied(cause)) { erase(); onReadDenied(); }
      else setError(cause instanceof StudioApiError && cause.status === 409
        ? "服务器尚未确认可放弃 原标识保持 如已开始生成请按原任务只读核对 不能据此判断未收费" : errorText(cause));
    } finally { if (version === epoch.current && alive.current && !cleared.current) { running.current = false; setBusy(false); onBusy(false); } }
  }
  const close = () => { epoch.current++; if (running.current) abort.current?.abort(); running.current = false; setBusy(false); onBusy(false); setOpen(false); };
  return <section className="studio-paid-image" data-studio-paid-image="preparation-cleanup">
    <button className="studio-paid-image-toggle" type="button" aria-expanded={open} onClick={() => { if (open) close(); else setOpen(true); }}><RefreshCw size={15} /><span>未提交准备核对</span><ChevronDown size={15} data-open={open} /></button>
    <div className="studio-paid-image-collapse" data-open={open && !cleared.current} inert={!open || cleared.current} aria-hidden={!open || cleared.current}>
      <div ref={root} className="studio-paid-image-content" role="region" aria-label="未提交准备核对" aria-busy={busy}>
        <header><h2>仅核对本人原准备编号</h2><button type="button" aria-label="关闭未提交准备核对" onClick={close}><X size={15} /></button></header>
        <p>原项目当前不可读取 此入口不加载旧提示词 报价 素材或工作台 只请求放弃服务器确认尚未提交的准备 已开始生成会拒绝</p>
        <button type="button" disabled={busy} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={14} />重新读取本地准备编号</button>
        {busy && <p role="status">正在核对本人原标识 未恢复任务或调用模型</p>}
        {error && <p role="alert" className="studio-paid-image-error">{error}</p>}{notice && <p role="status" className="studio-paid-image-note">{notice}</p>}
        {ready && !rows.markers.length && <p role="status">当前本人没有可核对的本地准备编号 此结果不代表服务器没有历史请求</p>}
        {!!rows.invalid && <p role="alert" className="studio-paid-image-error">有 {rows.invalid} 条本人标识损坏或不可读取 未清除这些标识</p>}
        {rows.limited && <p role="status">本次只读取按范围排序的前 100 条标识 还有其他标识 未将未读取项当作不存在</p>}
        {rows.markers.map(marker => <div className="studio-paid-image-original" key={`${marker.scope}:${marker.requestId}`} data-studio-image-preparation={marker.requestId}>
          <p className="studio-paid-image-id">范围 {marker.scope === "unassigned" ? "个人工作区" : marker.scope}<br />原编号 {marker.requestId}</p>
          <p className="studio-paid-image-note">{marker.commitHash ? "曾发起明确提交 是否已生效尚未核对 仅服务器可判断能否放弃" : "本地标识不能证明未提交 放弃回执未确认前保留原编号"}</p>
          <button type="button" disabled={busy || !ready} onClick={() => void abandon(marker)}>放弃尚未提交的准备</button>
        </div>)}
      </div>
    </div>
  </section>;
}
