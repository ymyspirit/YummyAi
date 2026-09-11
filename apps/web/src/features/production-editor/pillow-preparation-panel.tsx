"use client";

import type { ShapedPillowDocument } from "@yummyai/contracts/pod/production-editor";
import { getProductionLayout } from "@yummyai/production-editor/geometry";
import { ScanLine } from "lucide-react";
import { PILLOW_SIZES_IN } from "./production-editor-model";

export function PillowPreparationPanel({ document, canTrace, traceHint, onChange, onTrace }: {
  document: ShapedPillowDocument; canTrace: boolean; traceHint: string;
  onChange: (document: ShapedPillowDocument) => void; onTrace: (fitToSize: boolean) => void;
}) {
  const spec = document.spec, layout = getProductionLayout(document);
  return <section className="pe-pillow-preparation" aria-label="抱枕规格与轮廓">
    <div className="pe-pillow-preparation-heading"><h2>抱枕规格与轮廓</h2><span>150 DPI · 条码固定在最下方</span></div>
    <div className="pe-pillow-size-options" role="group" aria-label="抱枕订单规格">{PILLOW_SIZES_IN.map((inches) => <button type="button" className="pe-button" key={inches} aria-pressed={Math.abs((spec.declaredLongestMm ?? 0) - inches * 25.4) < 0.01} onClick={() => onChange({ ...document, spec: { ...spec, declaredLongestMm: inches * 25.4, sizeBasis: "finished" } })}>{inches}<small>in</small></button>)}</div>
    <div className="pe-pillow-spec-summary"><span>标称最长边 <b>{spec.declaredLongestMm ? `${(spec.declaredLongestMm / 25.4).toFixed(0)} in / ${spec.declaredLongestMm.toFixed(1)} mm` : "未选择"}</b></span><label>印刷方式<select aria-label="印刷方式" value={spec.sideMode} onChange={(event) => onChange({ ...document, spec: { ...spec, sideMode: event.target.value as "single" | "double" } })}><option value="single">单面印刷 · 背片留白</option><option value="double">双面印刷 · 背图镜像</option></select></label></div>
    <div className="pe-pillow-trace-actions"><button className="pe-button primary" disabled={!canTrace || !spec.declaredLongestMm} onClick={() => onTrace(true)}><ScanLine size={15} />按规格生成抱枕轮廓</button><button className="pe-button" disabled={!canTrace} onClick={() => onTrace(false)}>按当前图案尺寸生成</button></div>
    <p className="pe-hint">{traceHint} 按规格生成时，将所选图片的可见主体等比例设为标称最长边，再外扩白边。成品尺寸仍需实样核对。</p>
    <dl className="pe-pillow-dimensions"><div><dt>裁片主体（不含条码）</dt><dd>{spec.widthMm.toFixed(1)} × {spec.heightMm.toFixed(1)} mm</dd></div><div><dt>正反片排版</dt><dd>{layout.widthPx} × {layout.heightPx} px</dd></div><div><dt>缝边 / 黑裁线</dt><dd>{(spec.whiteBorderMm * 150 / 25.4).toFixed(0)} px / {(spec.cutLineMm * 150 / 25.4).toFixed(0)} px</dd></div></dl>
  </section>;
}
