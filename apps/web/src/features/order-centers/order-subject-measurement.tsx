"use client";
import { useEffect, useState } from "react";
import { CheckCircle2, Ruler, RotateCcw, TriangleAlert } from "lucide-react";
import type { OrderWorkDetail } from "@yummyai/contracts/order/workspace";
import type { ProductionEditorDetailView } from "@yummyai/contracts/pod/production-editor-api";
import type { PillowSubjectMeasurement } from "@yummyai/production-editor/pillow-subject";
import { compareSubjectSize, customerSubjectSize, measureTransparentSubject, placedSubjectMeasurement, subjectMeasurementCandidate } from "./order-subject-measurement-model";

type MeasurementState = { key: string; measurement?: PillowSubjectMeasurement; url?: string; error?: string };
const number = (value: number) => Number(value.toFixed(2)).toString();

export function OrderSubjectMeasurement({ editor, detail }: { editor: ProductionEditorDetailView; detail: OrderWorkDetail }) {
  const candidate = subjectMeasurementCandidate(editor);
  const expected = customerSubjectSize(detail, editor);
  const [state, setState] = useState<MeasurementState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const asset = candidate.asset;
  const width = asset?.width, height = asset?.height;
  const key = `${editor.project.id}:${editor.version.id}:${asset?.id ?? "none"}:${attempt}`;
  const path = asset ? `/api/production-editor/projects/${editor.project.id}/images/${asset.id}?kind=original` : null;
  useEffect(() => {
    if (!path || !width || !height) return;
    const abort = new AbortController();
    let objectUrl: string | undefined;
    void (async () => {
      try {
        const response = await fetch(path, { cache: "no-store", signal: abort.signal });
        if (!response.ok) throw new Error([401, 403].includes(response.status) ? "无权读取当前主体素材，请核对登录与权限。" : "读取主体素材失败，请重新测量。");
        const blob = await response.blob();
        if (abort.signal.aborted) return;
        const bitmap = await createImageBitmap(blob);
        let measurement: PillowSubjectMeasurement;
        try {
          if (bitmap.width !== width || bitmap.height !== height) throw new Error("素材实际像素与版本记录不一致，不能据此核对尺寸。");
          const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) throw new Error("浏览器无法读取图像像素。");
          context.drawImage(bitmap, 0, 0);
          const rgba = context.getImageData(0, 0, width, height).data;
          measurement = measureTransparentSubject({ width, height, rgba });
          canvas.width = 1; canvas.height = 1;
        } finally { bitmap.close(); }
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ key, measurement, url: objectUrl });
      } catch (cause) {
        if (!abort.signal.aborted) setState({ key, error: cause instanceof Error && cause.message === "pillow_subject_not_visible"
          ? "没有找到可测量的图案，请检查抠图是否完整。" : cause instanceof Error ? cause.message : "主体测量失败，请重试。" });
      }
    })();
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [key, path, width, height]);
  if (editor.version.document.productType !== "shaped_pillow") return null;
  const current = state?.key === key ? state : null;
  const measured = current?.measurement && candidate.layer ? placedSubjectMeasurement(current.measurement, candidate.layer) : null;
  const comparison = measured ? compareSubjectSize(measured, expected.inches) : "unconfirmed";
  const bounds = measured?.measurement.bounds;
  const busy = !!path && !current;
  const longestDirection = measured ? measured.widthMm >= measured.heightMm ? "宽度" : "高度" : null;
  const sizeDifference = measured && expected.inches !== null ? measured.longestMm - expected.inches * 25.4 : null;
  return <section className="oc-subject-measurement" aria-label="主体尺寸核对" aria-busy={busy}>
    <div className="oc-subject-heading"><h3><Ruler size={16} />主体尺寸核对 <span className="oc-badge">V{editor.version.versionNumber}</span></h3>
      {path && <button type="button" className="oc-button" disabled={busy} onClick={() => setAttempt(value => value + 1)}><RotateCcw size={13} />重新测量</button>}
    </div>
    <dl className="oc-subject-values">
      <div><dt>顾客下单（最长边）</dt><dd>{expected.inches === null ? "待核对" : <>{expected.inches} 英寸<small>{number(expected.inches * 2.54)} 厘米</small></>}</dd></div>
      <div><dt>当前图案（最长边）</dt><dd>{measured ? <>{number(measured.longestInches)} 英寸<small>{number(measured.longestMm / 10)} 厘米</small></> : busy ? "测量中…" : "无法测量"}</dd></div>
    </dl>
    {measured && <div className="oc-subject-result" data-result={comparison} role="status">
      {comparison === "match" ? <CheckCircle2 size={16} aria-hidden="true" /> : <TriangleAlert size={16} aria-hidden="true" />}
      <div><strong>{comparison === "match" ? "尺寸一致" : comparison === "mismatch" ? "尺寸不一致，需修改" : "尺寸待核对"}</strong>
        <p>{comparison === "mismatch" ? `当前图案比顾客要求偏${sizeDifference! > 0 ? "大" : "小"} ${number(Math.abs(sizeDifference!) / 10)} 厘米，请交给制图人员调整。`
          : !measured.proportional ? "图案被拉宽或拉长了，请交给制图人员恢复原有比例。"
          : `按图案的${longestDirection}核对顾客下单尺寸。`}</p>
      </div>
    </div>}
    {measured && measured.effectivePpi < 150 && <p className="oc-notice">图片放大后可能模糊，请交给制图人员补清晰或更换高清图后重新送审。</p>}
    {busy && <p className="oc-hint" role="status">正在测量当前图案…</p>}
    {(candidate.reason || current?.error) && <p className="oc-notice" role={current?.error ? "alert" : "status"}>{candidate.reason ?? current?.error}</p>}
    {(expected.inches === null || detail.line.sourceChanged) && <p className="oc-notice">{expected.note}</p>}
    {measured && <>
      <figure className="oc-subject-boundary">
        <div className="oc-subject-diagram">
          <div className="oc-subject-width-label">宽 {number(measured.widthMm / 10)} 厘米</div>
          <div className="oc-subject-image" style={{ aspectRatio: `${width} / ${height}`, maxWidth: Math.min(280, 300 * width! / height!) }}>
            {/* Private immutable source, already authorized above; this is not the composed white-background sheet. */}
            <img src={current!.url} alt="当前图案尺寸示意图" />
            <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true"><rect x={bounds!.x} y={bounds!.y} width={bounds!.width} height={bounds!.height} vectorEffect="non-scaling-stroke" /></svg>
            <span className="oc-subject-width-line" aria-hidden="true" style={{ left: `${bounds!.x / width! * 100}%`, width: `${bounds!.width / width! * 100}%` }} />
            <span className="oc-subject-height-line" aria-hidden="true" style={{ top: `${bounds!.y / height! * 100}%`, height: `${bounds!.height / height! * 100}%` }} />
            <span className="oc-subject-height-label">高 {number(measured.heightMm / 10)} 厘米</span>
          </div>
        </div>
        <figcaption><strong>请看图确认</strong><p>图案是否完整，四周有没有多余背景或小点。有问题请交给制图人员修正。</p>
          <p className="oc-hint">这里测量印刷图案，缝制后的抱枕大小以工厂确认为准。</p>
        </figcaption>
      </figure>
      <details className="oc-subject-technical">
        <summary>像素与测量详情（供制图人员查看）</summary>
        <dl className="oc-subject-values">
          <div><dt>输出主体 · 宽 × 高</dt><dd>{Math.round(measured.outputWidthPx)} × {Math.round(measured.outputHeightPx)} px <small>150 DPI</small></dd></div>
          <div><dt>素材主体 · 宽 × 高</dt><dd>{bounds!.width} × {bounds!.height} px <small>{number(measured.effectivePpi)} PPI</small></dd></div>
        </dl>
        <p className="oc-hint">{expected.note}</p>
        <p className="oc-hint">素材整图 {width} × {height} px。绿色框为主体边界，透明留白不计入。</p>
        <p className="oc-hint">仅核对图稿主体，不含缝边、条码框和留白；按 150 DPI 像素取整比较，目标有效分辨率为 150 PPI。</p>
        <p className="oc-hint">本次按透明边界 Alpha ≥ 32 测量，{editor.version.document.automation?.pillowPipeline ? "沿用新版配方口径。" : "用于辅助核对，未改写旧任务的测量规则或确认记录。"}</p>
      </details>
    </>}
  </section>;
}
