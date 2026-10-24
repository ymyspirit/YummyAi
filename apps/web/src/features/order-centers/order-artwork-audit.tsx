"use client";
import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, LoaderCircle, ScanSearch } from "lucide-react";
import { AssistViewSchema, type AssistModel, type AssistView } from "@yummyai/contracts/ai/assist";
import type { ArtworkAuditReport } from "@yummyai/contracts/ai/artwork-audit";
import { assistApi } from "../ai-assist/assist-client";

const names = {passed: "通过", failed: "需修改", needs_review: "需复核"};
export function OrderArtworkAudit({ orderId, revision, versionId, disabled, onReport, onBusy }: {
  orderId: string; revision: number; versionId: string; disabled: boolean;
  onReport: (report: ArtworkAuditReport | null) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [models, setModels] = useState<AssistModel[]>([]), [modelId, setModelId] = useState("");
  const [view, setView] = useState<AssistView | null>(null), [loading, setLoading] = useState(true), [sending, setSending] = useState(false), [error, setError] = useState("");
  const alive = useRef(true), requestId = useRef<string | null>(null), submitting = useRef(false);
  const report = !view?.stale && view?.artworkAudit?.versionId === versionId && view.artworkAudit.revision === revision ? view.artworkAudit : null;
  const pending = view?.status === "queued" || view?.status === "running";
  useEffect(() => { onReport(report); }, [report, onReport]);
  useEffect(() => { onBusy(loading || pending || sending); }, [loading, pending, sending, onBusy]);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const [options, history] = await Promise.all([
          assistApi<AssistModel[]>("models", undefined, controller.signal),
          assistApi<Array<{id: string}>>(`runs?kind=artwork_preflight&scope=order:${orderId}&automaticAudit=1`, undefined, controller.signal),
        ]);
        if (!alive.current) return;
        setModels(options); setModelId(options[0]?.id ?? "");
        for (const row of history) {
          const latest = AssistViewSchema.parse(await assistApi(`runs/${row.id}`, undefined, controller.signal));
          if (!alive.current) return;
          const request = latest.request;
          if (request?.kind === "artwork_preflight" && request.expectedEditorVersionId === versionId && request.expectedRevision === revision) { setView(latest); break; }
        }
      } catch (e) { if (alive.current && !controller.signal.aborted) setError(e instanceof Error ? e.message : "核对记录加载失败"); }
      finally { if (alive.current && !controller.signal.aborted) setLoading(false); }
    })();
    return () => { alive.current = false; controller.abort(); };
  }, [orderId, revision, versionId]);
  useEffect(() => {
    if (!pending || !view) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = AssistViewSchema.parse(await assistApi(`runs/${view.id}`, undefined, controller.signal));
        if (!controller.signal.aborted) { setView(next); setError(""); }
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "查询进度失败，请稍后重试"); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3000);
    };
    timer = setTimeout(() => void poll(), 1500);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [pending, view?.id]);
  async function start() {
    if (submitting.current || !modelId) return;
    submitting.current = true; setSending(true); setError("");
    requestId.current ??= crypto.randomUUID();
    try {
      const next = AssistViewSchema.parse(await assistApi("runs", {kind: "artwork_preflight", automaticAudit: true,
        ...(view && !pending ? {retryAudit: true} : {}), orderLineId: orderId, expectedRevision: revision,
        expectedEditorVersionId: versionId, modelId, requestId: requestId.current}));
      if (alive.current) { setView(next); requestId.current = null; }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "未能启动自动核对"); }
    finally { submitting.current = false; if (alive.current) setSending(false); }
  }
  const passed = report?.checks.filter(c => c.status === "passed").length ?? 0;
  const totalTokens = view?.inputTokens != null && view.outputTokens != null ? view.inputTokens + view.outputTokens : null;
  const tokenCount = (value: number | null | undefined) => value == null ? pending ? "待返回" : "未返回" : value.toLocaleString("zh-CN");
  return <section className="oc-artwork-audit" aria-label="自动核对" aria-busy={loading || pending || sending}>
    <div className="oc-section-heading"><h3>自动核对 · 6 项</h3>
      <button type="button" className="oc-button primary" disabled={disabled || loading || pending || sending || !modelId} onClick={() => void start()}>
        {pending || sending ? <LoaderCircle size={16} /> : <ScanSearch size={16} />}
        {sending ? "正在测量生产稿…" : pending ? "AI 正在核对…" : view ? "重新核对 6 项" : "自动核对 6 项"}
      </button>
    </div>
    <p className="oc-hint">自动测尺寸与工艺，AI 对照顾客原图检查内容。完成后由运营决定是否通过审核。</p>
    {!loading && !models.length && <p className="oc-error">尚未配置可用的图文分析模型，请到 AI 模型配置中启用。</p>}
    {models.length > 0 && <label className="oc-audit-model">核对模型 <select aria-label="核对模型" value={modelId} disabled={pending || sending || disabled} onChange={e => {setModelId(e.target.value); requestId.current = null;}}>
      {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
    </select></label>}
    {error && <p role="alert" className="oc-error">{error}</p>}
    {view?.error && <p role="alert" className="oc-error">{view.error}{!view.error.includes("新的模型调用") ? "。重新核对会发起一次新的模型调用。" : "。"}</p>}
    {view?.stale && <p role="status" className="oc-error">原核对结果已失效，请按当前订单和生产稿重新核对。</p>}
    {report && <>
      <p role="status" className={report.complete && passed === 6 ? "oc-notice" : "oc-hint"}>{report.complete ? `已核对：${passed} 项通过，${6 - passed} 项需要处理。` : view?.status === "failed" ? "看图核对未完成，下方保留程序测量结果。" : "尺寸与工艺已测量，正在等待看图核对。"}</p>
      <ul className="oc-audit-results">{report.checks.map(check => <li key={check.code} data-status={check.status}>
        <div className="oc-audit-result-heading"><strong>{check.title}</strong><span>{check.status === "passed" ? <Check size={15} /> : <CircleAlert size={15} />}{names[check.status]}</span></div>
        <p>{check.detail}</p>{check.action && <p><b>下一步：</b>{check.action}</p>}
        {(check.evidence.length > 0 || check.marks.length > 0) && <details><summary>查看核对依据{check.marks.length > 0 ? "与标记位置" : ""}</summary>
          {check.evidence.map((text, i) => <p className="oc-hint" key={i}>{text}</p>)}
          {view?.images.filter(i => check.marks.some(m => m.sourceId === i.sourceId)).map(image => <figure key={image.sourceId}>
            <div className="oc-audit-marked-image"><img src={image.path} alt={`${check.title}：${image.label}`} loading="lazy" />
              {check.marks.filter(m => m.sourceId === image.sourceId).map((mark, i) => <span key={i} className="oc-audit-mark" style={{left: `${mark.x * 100}%`, top: `${mark.y * 100}%`, width: `${mark.width * 100}%`, height: `${mark.height * 100}%`}} title={mark.label} />)}
            </div><figcaption>{check.marks.filter(m => m.sourceId === image.sourceId).map(m => m.label).join("；")}</figcaption>
          </figure>)}
        </details>}
      </li>)}</ul>
      <details className="oc-audit-basis"><summary>本次使用的资料和核对记录</summary>
        <p className="oc-hint">顾客需求 V{report.revision} · 生产稿 V{report.versionNumber} · {view?.modelLabel}</p>
        <p aria-label="本次调用 Token 用量">本次调用 Token：输入 <strong>{tokenCount(view?.inputTokens)}</strong> · 输出 <strong>{tokenCount(view?.outputTokens)}</strong> · 合计 <strong>{tokenCount(totalTokens)}</strong></p>
        <p className="oc-hint">每次调用分别记录；以上仅为本次用量，未返回的用量不按 0 计算。{view?.costUsd != null ? `费用按配置估算 $${view.costUsd.toFixed(4)}，以渠道账单为准。` : "费用待渠道账单确认。"}</p>
        <p className="oc-hint">{report.ruleBasis}</p>
        <p className="oc-hint">细窄处按生产稿两侧裁线间距核对。结果仅适用于本次资料和稿件；改图后重新核对。</p>
        {view?.diagnostics.map((d, i) => <p key={i} className="oc-error">{d}</p>)}
        {!!view?.result?.missingInformation.length && <details><summary>模型补充说明</summary><p className="oc-hint">影响图稿的缺项会列在上方六项结果中；实物打样和工厂验收在后续生产环节确认。</p>{view.result.missingInformation.map((d, i) => <p className="oc-hint" key={i}>{d}</p>)}</details>}
        <div className="oc-audit-images">{view?.images.map(image => <figure key={image.sourceId}><img src={image.path} alt={image.label} loading="lazy" /><figcaption>{image.label}</figcaption></figure>)}</div>
      </details>
    </>}
  </section>;
}
