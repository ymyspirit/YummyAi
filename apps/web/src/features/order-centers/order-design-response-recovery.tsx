"use client";

import { useEffect, useRef, useState } from "react";
import { ORDER_DESIGN_RECOVERY_MAX_BYTES, type DesignAgentRunView, type OrderDesignRestoreResponse } from "@yummyai/contracts/order/design-agent";

type RestoreInput = Omit<OrderDesignRestoreResponse, "idempotencyKey">;

export function OrderDesignResponseRecoveryForm({ run, disabled, onRestore }: {
  run: DesignAgentRunView; disabled: boolean; onRestore: (input: RestoreInput) => Promise<void>;
}) {
  const [contentBase64, setContentBase64] = useState("");
  const [preview, setPreview] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [sourceState, setSourceState] = useState<"loading" | "ready" | "failed">("loading");
  const [sourceAttempt, setSourceAttempt] = useState(0);
  const [previewState, setPreviewState] = useState<"loading" | "ready" | "failed">("loading");
  const fileEpoch = useRef(0);
  const target = run.responseRecoveryTarget;
  useEffect(() => () => { ++fileEpoch.current; }, []);
  useEffect(() => {
    return () => { if (preview) URL.revokeObjectURL(preview); };
  }, [preview]);
  if (!target) return null;

  async function choose(file: File | undefined) {
    const epoch = ++fileEpoch.current;
    setContentBase64(""); setPreview(""); setPreviewState("loading"); setVerified(false); setError(""); setReading(false);
    if (!file) return;
    if (!file.size || file.size > ORDER_DESIGN_RECOVERY_MAX_BYTES || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError("请选择不超过 20 MiB 的 PNG、JPG 或 WebP 原结果文件。"); return;
    }
    setReading(true);
    try {
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result.slice(reader.result.indexOf(",") + 1)) : reject(new Error("读取失败"));
        reader.onerror = () => reject(new Error("读取失败"));
        reader.readAsDataURL(file);
      });
      if (epoch !== fileEpoch.current) return;
      setContentBase64(content); setPreview(URL.createObjectURL(file));
    } catch { if (epoch === fileEpoch.current) setError("图片读取失败，请重新选择原结果文件。"); }
    finally { if (epoch === fileEpoch.current) setReading(false); }
  }

  const sourceUrl = `/api/production-editor/projects/${run.projectId}/images/${target.sourceAssetId}?kind=preview&attempt=${sourceAttempt}`;
  const imagesReady = sourceState === "ready" && previewState === "ready";
  return <details className="oc-agent-recovery" aria-label="核实模型结果并恢复">
    <summary>核实模型结果并恢复 · {target.stepLabel}</summary>
    <p className="oc-hint">先在提供方记录中核对原请求、模型、参考图和返回图片，再导入该次请求的原结果。当前网关不能自动查询历史结果。内部请求编号本身不能证明提供方已完成任务。</p>
    <dl className="oc-agent-recovery-identity">
      <div><dt>原请求编号</dt><dd>{target.requestId}</dd></div>
      <div><dt>固定模型</dt><dd>{target.model}</dd></div>
      {target.knownResponseChecksum && <div><dt>已收到结果的校验值</dt><dd>{target.knownResponseChecksum}</dd></div>}
    </dl>
    <div className="oc-agent-recovery-images">
      <figure><a href={sourceUrl} target="_blank" rel="noreferrer">
        <img key={sourceAttempt} src={sourceUrl} alt="本步骤已固定的参考图片" onLoad={() => setSourceState("ready")}
          onError={() => { setSourceState("failed"); setVerified(false); }} />
      </a><figcaption>本步骤参考图 · 点击查看</figcaption></figure>
      {preview && <figure>
        <img key={preview} src={preview} alt="待导入的提供方原结果" onLoad={() => setPreviewState("ready")}
          onError={() => { setPreviewState("failed"); setVerified(false); }} />
        <figcaption>待导入原结果 · 尚未通过服务器检查</figcaption>
      </figure>}
    </div>
    {sourceState === "loading" && <p className="oc-hint" role="status">正在读取本步骤参考图…</p>}
    {sourceState === "failed" && <p className="oc-error" role="alert">参考图暂时无法读取，先恢复图片显示再核对原结果。
      <button type="button" className="oc-button" disabled={disabled} onClick={() => { setSourceState("loading"); setVerified(false); setSourceAttempt(value => value + 1); }}>重读参考图</button>
    </p>}
    {preview && previewState === "failed" && <p className="oc-error" role="alert">待导入文件无法显示为图片，请重新选择提供方的原结果文件。</p>}
    <div className="oc-fields">
      <label>提供方原结果文件<input type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled || reading}
        onChange={event => void choose(event.target.files?.[0])} /></label>
      <label>提供方记录编号<input value={reference} maxLength={160} disabled={disabled || reading}
        placeholder="提供方任务、响应或工单编号" onChange={event => { setReference(event.target.value); setVerified(false); }} /></label>
      <label className="oc-full-field">核对依据<textarea value={note} maxLength={1000} rows={3} disabled={disabled || reading}
        placeholder="说明如何核对原请求、参考图与返回图片；至少 10 字，不填写密钥或顾客隐私。"
        onChange={event => { setNote(event.target.value); setVerified(false); }} /></label>
    </div>
    <label className="oc-check"><input type="checkbox" checked={verified} disabled={disabled || reading || !imagesReady}
      onChange={event => setVerified(event.target.checked)} />已核对这是本步骤原请求的原始返回图片，文件未经另行编辑或重新生成</label>
    <p className="oc-hint">这项核对由操作人确认并留痕。导入后继续安全扫描和原有制图检查，复用已完成步骤；不新增这次模型调用，费用未知时仍保留额度。没有可核实的原结果时，请接管制作。</p>
    {error && <p className="oc-error" role="alert">{error}</p>}
    <button type="button" className="oc-button" disabled={disabled || reading || !imagesReady || !verified || !contentBase64 || !reference.trim() || note.trim().length < 10}
      onClick={() => void onRestore({ runId: run.id, expectedRevision: run.revision, stepId: target.stepId, requestId: target.requestId,
        contentBase64, providerReference: reference.trim(), verificationNote: note.trim(), verifiedOriginalResult: true })}>
      {reading ? "正在读取图片…" : "导入原结果并继续制图"}
    </button>
  </details>;
}
