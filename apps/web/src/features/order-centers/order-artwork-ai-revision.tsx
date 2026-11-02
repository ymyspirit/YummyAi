"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ImagePlus, LoaderCircle, RefreshCw, Send, Trash2, X } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import {
  DesignAgentViewSchema, OrderDesignReviseCandidateSchema,
  ORDER_DESIGN_REVISION_MAX_ATTACHMENTS, ORDER_DESIGN_REVISION_MAX_FILE_BYTES, ORDER_DESIGN_REVISION_MAX_TOTAL_BYTES,
  type DesignAgentRunView, type OrderDesignReviseCandidate, type OrderDesignRevisionFeedback,
} from "@yummyai/contracts/order/design-agent";
import { useErpAccess } from "../identity/erp-access";
import { centerRequest, fileBase64, orderCommandUncertain, OrderCenterRequestError } from "./order-center-model";
import "./order-artwork-ai-revision.css";

export type OrderArtworkAiRevisionState = { dirty: boolean; busy: boolean; loading: boolean };
type ReferenceImage = { key: string; name: string; byteSize: number; contentBase64: string; preview: string; previewFailed?: boolean };
const blockedMessages: Record<string, string> = {
  agent_revision_not_reviewable: "仅当前未通过审核且来源可核对的待审稿可以交 AI 修改 请核对当前稿件状态",
  agent_revision_pipeline_unsupported: "当前底稿尚不支持这两类 AI 修改 请核对底稿或交美工处理",
  agent_revision_already_requested: "本稿已有修改任务 请刷新无人设计进度查看原任务 不要重复提交",
  agent_revision_production_released: "本稿已有生产安排 不能直接交 AI 修改 请沿原生产返工流程处理",
  agent_revision_subject_ambiguous: "当前稿件不能唯一确定要修改的主体图片 请交美工核对图层",
  agent_revision_subject_unavailable: "当前主体图片或固定素材无法核验 请核对原稿或交美工处理",
  agent_revision_base_changed: "当前待审稿已变化 请重新读取当前稿件后再提交修改",
  agent_revision_successor_not_submitted: "当前稿件尚未提交审核 请先完成本稿提交 再核对 AI 修改支持情况",
  agent_revision_current_proof_unavailable: "当前稿件还没有可核对的完整预览 请先生成并核对本稿预览",
  agent_revision_source_proof_unavailable: "原 Agent 交接预览暂时无法核验 请先恢复原交接文件或交美工处理",
  agent_revision_recipe_changed: "当前稿件已变更原固定制作配方 不能直接交 AI 修改 请交美工核对",
  agent_revision_source_unsupported: "本稿缺少可继续使用的 AI 制作来源 请交美工沿原稿修改",
  agent_editor_changed: "当前稿件或审核版本已变化 请返回重新读取原稿",
  agent_membership_unavailable: "当前本人权限不满足修改要求 请重新核对授权",
};

/** A fresh authority-stamped read keeps private feedback separate from legacy or financial-only panel reads. */
export function OrderArtworkAiRevisionFeedback({ workItemId, runId }: { workItemId: string; runId: string }) {
  const access = useErpAccess(), identity = `${workItemId}:${runId}:${access.authority ?? ""}:${access.preferenceScope ?? ""}`;
  const live = useRef(identity); live.current = identity;
  const [result, setResult] = useState<{ identity: string; feedback: OrderDesignRevisionFeedback } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController(), scope = identity;
    setResult(null); setError("");
    if (!access.authority) return () => abort.abort();
    void centerRequest(`lines/${workItemId}/design-agent`, undefined, abort.signal, access.authority)
      .then(value => {
        const view = DesignAgentViewSchema.parse(value);
        if (abort.signal.aborted || live.current !== scope) return;
        if (view.run?.workItemId !== workItemId || view.run.id !== runId || view.run.privateEvidenceState === "expired" ||
          view.run.privateEvidenceOmitted || !view.run.revisionFeedback) {
          setError("本轮修改意见当前不可读取 请刷新进度核对原任务"); return;
        }
        setResult({ identity: scope, feedback: view.run.revisionFeedback });
      })
      .catch(() => { if (!abort.signal.aborted && live.current === scope) { setResult(null); setError("本轮修改意见暂时无法读取 请刷新进度重新核对"); } });
    return () => abort.abort();
  }, [identity, workItemId, runId, access.authority]);
  const feedback = result?.identity === identity && access.authority ? result.feedback : null;
  if (!access.authority) return null;
  return <section className="oc-ai-revision-feedback" aria-label="本轮修改意见">
    <h4>本轮修改意见</h4>
    {!feedback && <p className="oc-hint" role="status">{error || "正在核对本轮修改意见…"}</p>}
    {feedback && <><p>{feedback.reason}</p><p className="oc-hint">{feedback.mode === "contour_only"
      ? `只优化裁线 · 圆滑 ${feedback.contourRoundingPx} px · 不调用模型 主体图保持`
      : "主体图细节修改 · 以原主体图和参考截图修改 其他文字图层保持"}</p>
      {feedback.source === "submitted_successor" && <p className="oc-hint">本轮基于已提交待审稿修改 原 Agent 制作交接记录保持原样</p>}
      {!!feedback.attachments.length && <ul aria-label="本轮修改参考截图">{feedback.attachments.map(file => <li key={file.id}>
        <span>{file.name}</span><small>{(file.byteSize / 1024 / 1024).toFixed(2)} MiB</small>
      </li>)}</ul>}
      <p className="oc-hint">参考截图不作为顾客原图或生产图层 修改结果仍需运营审核</p></>}
  </section>;
}

export function OrderArtworkAiRevision({
  workItemId, workRevisionId, projectId, versionId, versionNumber, initialReason, disabled, onSubmitted, onClose, onStateChange,
}: {
  workItemId: string; workRevisionId: string | null; projectId: string; versionId: string; versionNumber: number;
  initialReason: string; disabled: boolean; onSubmitted: () => void; onClose: () => void;
  onStateChange?: (state: OrderArtworkAiRevisionState) => void;
}) {
  const access = useErpAccess(), fieldId = useId();
  const identity = `${workItemId}:${projectId}:${versionId}:${access.authority ?? ""}:${access.preferenceScope ?? ""}`;
  const openedIdentity = useRef(identity);
  const allowed = openedIdentity.current === identity && !!access.authority && access.can(Permission.DesignReview);
  const current = useRef(identity); current.current = identity;
  const callbacks = useRef({ onSubmitted, onClose, onStateChange }); callbacks.current = { onSubmitted, onClose, onStateChange };
  const alive = useRef(true), sequence = useRef(0), fileEpoch = useRef(0), posting = useRef(false), choosing = useRef(false);
  const reader = useRef<AbortController | null>(null), writer = useRef<AbortController | null>(null);
  const urls = useRef(new Set<string>()), input = useRef<HTMLInputElement>(null), opinion = useRef<HTMLTextAreaElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [run, setRun] = useState<DesignAgentRunView | null>(null), [runIdentity, setRunIdentity] = useState("");
  const [reason, setReason] = useState(initialReason), [mode, setMode] = useState<OrderDesignReviseCandidate["mode"]>("image_edit");
  const [rounding, setRounding] = useState<"" | "20" | "25" | "30">("");
  const [images, setImages] = useState<ReferenceImage[]>([]), [readingFiles, setReadingFiles] = useState(false);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [closing, setClosing] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [denied, setDenied] = useState(false);
  const [attempt, setAttempt] = useState<OrderDesignReviseCandidate | null>(null);
  const submitted = useRef<OrderDesignReviseCandidate | null>(null);
  const dirty = allowed && !denied && (reason !== initialReason || images.length > 0 || mode !== "image_edit" || rounding !== "" || !!attempt);
  const baseCurrent = runIdentity === identity && run?.workItemId === workItemId && run.workRevisionId === workRevisionId &&
    run.projectId === projectId && (run.revisionBaseVersionId ?? run.currentEditorVersionId) === versionId && run.status === "awaiting_review" &&
    run.privateEvidenceState !== "expired" && run.privateEvidenceOmitted !== true;
  const ready = allowed && !denied && baseCurrent && run?.canRevise === true;
  const inputsDisabled = disabled || busy || loading || readingFiles || !!attempt || !ready;

  function clearImages() {
    fileEpoch.current++;
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.clear(); choosing.current = false; setImages([]); setReadingFiles(false);
  }
  function hidePrivate() {
    sequence.current++; reader.current?.abort(); writer.current?.abort(); clearImages();
    submitted.current = null; setAttempt(null); setReason(""); setRun(null); setRunIdentity(""); setDenied(true);
    setLoading(false); setBusy(false); setNotice(""); setError("当前本人权限或原资料已变化 修改意见与截图已隐藏 请重新核对订单");
  }
  function authorityDenied(cause: unknown) {
    return cause instanceof OrderCenterRequestError && ([401, 403, 404, 410].includes(cause.status) || cause.code === "authority_changed");
  }
  function acknowledge(next: DesignAgentRunView, intent: OrderDesignReviseCandidate) {
    const feedback = next.revisionFeedback;
    return next.privateEvidenceState !== "expired" && !next.privateEvidenceOmitted && next.workItemId === workItemId && feedback?.requestId === intent.idempotencyKey &&
      feedback.parentRunId === intent.runId && feedback.baseProjectId === projectId && feedback.baseVersionId === versionId &&
      feedback.reason === intent.reason && feedback.mode === intent.mode && feedback.contourRoundingPx === intent.contourRoundingPx;
  }
  function accepted() {
    submitted.current = null; setAttempt(null); clearImages(); setReason(""); setBusy(false); setLoading(false);
    callbacks.current.onStateChange?.({ dirty: false, busy: false, loading: false });
    callbacks.current.onSubmitted();
  }
  async function readRun() {
    if (!allowed || posting.current || !alive.current || denied) return;
    const scope = identity, ticket = ++sequence.current, abort = new AbortController();
    reader.current?.abort(); reader.current = abort; setLoading(true); setError("");
    const valid = () => alive.current && current.current === scope && sequence.current === ticket && !abort.signal.aborted;
    try {
      const view = DesignAgentViewSchema.parse(await centerRequest(`lines/${workItemId}/design-agent`, undefined, abort.signal, access.authority!));
      if (!valid()) return;
      if (view.run?.privateEvidenceState === "expired" || view.run?.privateEvidenceOmitted) { hidePrivate(); return; }
      setRun(view.run); setRunIdentity(scope);
      const intent = submitted.current;
      if (intent && view.run && acknowledge(view.run, intent)) { accepted(); return; }
      setNotice(intent ? "尚未核对到本次原修改请求的回执 填写仍保留 不会自动再次提交" : "");
    } catch (cause) {
      if (!valid()) return;
      if (authorityDenied(cause)) hidePrivate();
      else { setRun(null); setRunIdentity(""); setError("修改任务暂时无法核对 请读取原状态 填写仍保留"); }
    } finally { if (valid()) setLoading(false); }
  }
  const readLatest = useRef(readRun); readLatest.current = readRun;
  const hideLatest = useRef(hidePrivate); hideLatest.current = hidePrivate;
  useEffect(() => {
    alive.current = true;
    if (allowed) void readLatest.current(); else hideLatest.current();
    return () => {
      alive.current = false; sequence.current++; fileEpoch.current++; reader.current?.abort(); writer.current?.abort();
      if (closeTimer.current) clearTimeout(closeTimer.current);
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear(); callbacks.current.onStateChange?.({ dirty: false, busy: false, loading: false });
    };
  }, [identity, allowed]);
  useEffect(() => { callbacks.current.onStateChange?.({ dirty, busy: busy || readingFiles, loading }); }, [dirty, busy, readingFiles, loading]);
  useEffect(() => { if (ready) opinion.current?.focus({ preventScroll: true }); }, [ready]);
  useEffect(() => {
    const recheck = () => { if (document.visibilityState !== "hidden" && !posting.current) void readLatest.current(); };
    window.addEventListener("focus", recheck); document.addEventListener("visibilitychange", recheck);
    return () => { window.removeEventListener("focus", recheck); document.removeEventListener("visibilitychange", recheck); };
  }, []);

  async function chooseFiles(files: File[]) {
    if (inputsDisabled || choosing.current || !files.length) return;
    if (images.length + files.length > ORDER_DESIGN_REVISION_MAX_ATTACHMENTS) { setError("最多添加 3 张修改参考截图"); return; }
    if (files.some(file => !file.size || file.size > ORDER_DESIGN_REVISION_MAX_FILE_BYTES ||
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.name.length > 200 || /[/\\]/.test(file.name) ||
      [...file.name].some(character => character.charCodeAt(0) < 32) || !/\.(?:png|jpe?g|webp)$/i.test(file.name))) {
      setError("请选择每张不超过 5 MiB 的 PNG、JPG 或 WebP 截图"); return;
    }
    if ([...images.map(image => image.byteSize), ...files.map(file => file.size)].reduce((sum, size) => sum + size, 0) > ORDER_DESIGN_REVISION_MAX_TOTAL_BYTES) {
      setError("修改参考截图总计不能超过 10 MiB"); return;
    }
    const ticket = ++fileEpoch.current, scope = identity;
    choosing.current = true; setReadingFiles(true); setError(""); setNotice("");
    const added: ReferenceImage[] = [];
    try {
      for (const file of files) {
        const contentBase64 = await fileBase64(file);
        if (!alive.current || ticket !== fileEpoch.current || current.current !== scope) return;
        const preview = URL.createObjectURL(file); urls.current.add(preview);
        added.push({ key: crypto.randomUUID(), name: file.name, byteSize: file.size, contentBase64, preview });
      }
      setImages(value => [...value, ...added]);
    } catch {
      for (const image of added) { URL.revokeObjectURL(image.preview); urls.current.delete(image.preview); }
      if (alive.current && ticket === fileEpoch.current && current.current === scope) setError("截图读取失败 原填写仍保留 请重新选择文件");
    } finally {
      if (alive.current && ticket === fileEpoch.current && current.current === scope) { choosing.current = false; setReadingFiles(false); }
      if (input.current) input.current.value = "";
    }
  }
  function removeImage(image: ReferenceImage) {
    if (inputsDisabled) return;
    URL.revokeObjectURL(image.preview); urls.current.delete(image.preview);
    setImages(value => value.filter(item => item.key !== image.key)); setError("");
  }
  async function submit() {
    if (!ready || inputsDisabled || !run || posting.current || images.some(image => image.previewFailed)) return;
    const parsed = OrderDesignReviseCandidateSchema.safeParse({ runId: run.id, expectedRevision: run.revision,
      expectedEditorVersionId: versionId, idempotencyKey: crypto.randomUUID(), reason: reason.trim(), mode,
      ...(mode === "contour_only" && rounding ? { contourRoundingPx: Number(rounding) } : {}),
      attachments: images.map(image => ({ name: image.name, contentBase64: image.contentBase64 })) });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "请补齐修改意见并核对截图"); return; }
    const intent = parsed.data, scope = identity, ticket = ++sequence.current, abort = new AbortController();
    reader.current?.abort(); writer.current = abort; posting.current = true;
    submitted.current = intent; setAttempt(intent); setBusy(true); setError(""); setNotice("");
    const valid = () => alive.current && current.current === scope && ticket === sequence.current && !abort.signal.aborted;
    try {
      const view = DesignAgentViewSchema.parse(await centerRequest(`lines/${workItemId}/design-agent/revise`, intent, abort.signal, access.authority!));
      if (!valid()) return;
      if (!view.run || !acknowledge(view.run, intent)) throw new Error("revision_receipt_unconfirmed");
      accepted();
    } catch (cause) {
      if (!valid()) return;
      if (authorityDenied(cause)) hidePrivate();
      else if (orderCommandUncertain(cause)) setError("本次修改提交结果尚未核对 请先读取原修改任务 不要再次提交");
      else {
        submitted.current = null; setAttempt(null); setRun(null); setRunIdentity("");
        setError(cause instanceof Error ? cause.message : "本次修改未能提交 请重新核对原稿状态");
      }
    } finally { posting.current = false; if (valid()) setBusy(false); }
  }
  function close() {
    if (busy || readingFiles || attempt || closing) return;
    if (dirty && !window.confirm("有未提交的 AI 修改意见或截图 确定放弃本次填写？")) return;
    setClosing(true);
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 150;
    closeTimer.current = setTimeout(() => callbacks.current.onClose(), delay);
  }

  if (!allowed || denied) return <section className="oc-ai-revision" aria-label="交 AI 修改"><p role="alert" className="oc-error">
    {error || "当前本人身份或审图权限尚未核对 修改意见与截图已隐藏"}</p><button type="button" className="oc-button" onClick={() => callbacks.current.onClose()}>返回审图</button></section>;
  return <section className={`oc-ai-revision${closing ? " is-closing" : ""}`} aria-label="交 AI 修改" aria-busy={busy || loading || readingFiles}>
    <header><div><h3>交 AI 修改</h3><p>{run?.revisionSource === "submitted_successor" ? "基于当前已提交待审稿" : "基于当前待审稿"} V{versionNumber} 新建修改 原稿保留 新稿仍需运营审核</p></div>
      <button type="button" className="oc-button oc-ai-revision-close" aria-label="关闭 AI 修改填写" disabled={busy || readingFiles || !!attempt} onClick={close}><X size={16} /></button></header>
    {loading && <p role="status"><LoaderCircle size={15} className="oc-ai-revision-spinner" />正在核对当前稿件与修改权限…</p>}
    {!loading && !ready && !attempt && <p className="oc-hint">{run?.revisionBlockedCode && blockedMessages[run.revisionBlockedCode] ||
      (run?.canRevise === true && !baseCurrent ? "当前稿件与已核对的任务版本不一致 请重新读取当前稿件" : "本稿当前不能交 AI 修改 请核对原订单与稿件状态 或交美工处理")}</p>}
    {(ready || !!attempt) && <form aria-label="AI 修改意见与参考截图" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={inputsDisabled}><legend>修改范围</legend><div className="oc-ai-revision-modes">
        <label><input type="radio" name={`${fieldId}-mode`} value="image_edit" checked={mode === "image_edit"} onChange={() => { setMode("image_edit"); setRounding(""); }} />
          <span><strong>主体图细节修改</strong><small>以原主体图和截图为参考 1 次模型调用 其他文字图层保持</small></span></label>
        <label><input type="radio" name={`${fieldId}-mode`} value="contour_only" checked={mode === "contour_only"} onChange={() => setMode("contour_only")} />
          <span><strong>只优化裁线</strong><small>不调用模型 不改变主体图 只按明确参数优化独立裁线</small></span></label>
      </div>
      {mode === "contour_only" && <label className="oc-ai-revision-rounding">裁线圆滑参数<select required aria-label="裁线圆滑参数" value={rounding} onChange={event => setRounding(event.target.value as typeof rounding)}>
        <option value="">请选择参数</option><option value="20">20 px</option><option value="25">25 px</option><option value="30">30 px</option></select></label>}
      <label className="oc-ai-revision-reason" htmlFor={`${fieldId}-reason`}>修改意见 <span className="oc-hint">必填</span>
        <textarea id={`${fieldId}-reason`} ref={opinion} required maxLength={2000} rows={3} value={reason} onChange={event => setReason(event.target.value)}
          placeholder="说明具体位置、问题和希望保留的内容 例如只去掉右脸外伸细毛 保持眼睛和主体形状" /></label>
      <div className="oc-ai-revision-reference-heading"><span>修改参考截图 <small>可选</small></span>
        <button type="button" className="oc-button" disabled={images.length >= ORDER_DESIGN_REVISION_MAX_ATTACHMENTS || inputsDisabled} onClick={() => input.current?.click()}><ImagePlus size={15} />添加截图</button>
        <input ref={input} className="oc-ai-revision-file" type="file" multiple accept="image/png,image/jpeg,image/webp" aria-label="添加修改参考截图" onChange={event => void chooseFiles(Array.from(event.target.files ?? []))} />
      </div>
      <p className="oc-hint">最多 3 张 PNG、JPG 或 WebP 单张 5 MiB 总计 10 MiB 截图仅作修改参考 不作为顾客原图或生产图层{mode === "contour_only" ? " 裁线模式截图只供审核对照" : ""}</p>
      {images.length > 0 && <ul className="oc-ai-revision-images">{images.map(image => <li key={image.key}><img src={image.preview} alt={`修改参考截图 ${image.name}`}
        onError={() => { setImages(value => value.map(item => item.key === image.key ? { ...item, previewFailed: true } : item)); setError("有截图无法预览 请移除后重新选择图片"); }} />
        <div><strong>{image.name}</strong><small>{(image.byteSize / 1024 / 1024).toFixed(2)} MiB</small></div>
        <button type="button" className="oc-button" aria-label={`移除修改参考截图 ${image.name}`} disabled={inputsDisabled} onClick={() => removeImage(image)}><Trash2 size={15} /></button></li>)}</ul>}
      <p className="oc-hint">顾客文字、字体或复杂排版修改请交美工 本次修改不改变订单要求或生产批准</p>
      </fieldset>
      <footer><button type="button" className="oc-button" disabled={busy || readingFiles || !!attempt} onClick={close}>取消</button>
        <button type="submit" className="oc-button primary" disabled={inputsDisabled || !reason.trim() || mode === "contour_only" && !rounding || images.some(image => image.previewFailed)}>
          {busy ? <LoaderCircle size={15} className="oc-ai-revision-spinner" /> : <Send size={15} />}{busy ? "正在提交修改…" : "提交 AI 修改"}</button></footer>
    </form>}
    {error && <p className="oc-error" role="alert">{error}</p>}{notice && <p className="oc-notice" role="status">{notice}</p>}
    {(attempt || !ready || error) && <div className="oc-ai-revision-reconcile"><button type="button" className="oc-button" disabled={busy || loading || readingFiles} onClick={() => void readRun()}><RefreshCw size={15} />{attempt ? "核对原修改任务" : "重新核对稿件状态"}</button>
      {attempt && <p className="oc-hint">仅按本次原请求读取回执 不会重新调用模型或再建修改任务</p>}</div>}
  </section>;
}
