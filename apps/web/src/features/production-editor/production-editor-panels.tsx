"use client";

import type { ProductionEditorDocument, ProductionEditorLayer, ProductionEditorPoint, ShapedPillowDocument, TireCoverDocument } from "@yummyai/contracts/pod/production-editor";
import type { ProductionEditorFontView, ProductionEditorImageView } from "@yummyai/contracts/pod/production-editor-api";
import { useEffect, useState } from "react";
import { pillowBottomCenter } from "@yummyai/production-editor/geometry";

import { productionBodySize, resizedProductionBody } from "./production-editor-model";
import { resizeImageProportionally } from "./production-layout-tools";

export function ProductionProcessPanel({ document, onChange }: { document: ProductionEditorDocument; onChange: (document: ProductionEditorDocument) => void }) {
  const size = productionBodySize(document);
  function pillow(patch: Partial<ShapedPillowDocument["spec"]>) { if (document.productType === "shaped_pillow") onChange({ ...document, spec: { ...document.spec, ...patch } }); }
  function tire(patch: Partial<TireCoverDocument["spec"]>) { if (document.productType === "tire_cover") onChange({ ...document, spec: { ...document.spec, ...patch } }); }
  return <section className="pe-inspector-section"><h2>工艺与尺寸</h2>
    <p className="pe-hint">当前为起始示例。请按实际工厂确认尺寸与计量口径，未确认时可保存草稿。</p>
    {document.productType === "shaped_pillow" ? <>
      <div className="pe-fields-two"><NumberField label="单片轮廓宽（mm）" value={size.width} min={10} max={5000} onChange={(value) => onChange(resizedProductionBody(document, value!, size.height))} /><NumberField label="单片轮廓高（mm）" value={size.height} min={10} max={5000} onChange={(value) => onChange(resizedProductionBody(document, size.width, value!))} /></div>
      <label>尺寸口径<select value={document.spec.sizeBasis} onChange={(event) => pillow({ sizeBasis: event.target.value as ShapedPillowDocument["spec"]["sizeBasis"] })}><option value="unconfirmed">待工厂确认</option><option value="artwork">图案尺寸</option><option value="cut_contour">裁剪轮廓尺寸</option><option value="finished">缝制后成品尺寸</option></select></label>
      <NumberField label="订单标称最长边（mm）" value={document.spec.declaredLongestMm} nullable min={10} max={5000} onChange={(value) => pillow({ declaredLongestMm: value })} />
      <label>正反面工艺<select value={document.spec.sideMode} onChange={(event) => pillow({ sideMode: event.target.value as "single" | "double" })}><option value="single">单面：背片镜像轮廓留白</option><option value="double">双面：主体镜像，文字正读</option></select></label>
      <dl className="pe-spec-note"><div><dt>输出分辨率</dt><dd>150 DPI</dd></div><div><dt>白边参考</dt><dd>200 px ≈ 33.87 mm</dd></div><div><dt>黑裁线参考</dt><dd>6 px ≈ 1.016 mm</dd></div></dl>
      <div className="pe-fields-two"><NumberField label="白边宽度（mm）" value={document.spec.whiteBorderMm} min={0} max={200} onChange={(value) => pillow({ whiteBorderMm: value! })} /><NumberField label="裁线宽度（mm）" value={document.spec.cutLineMm} min={0.01} max={10} onChange={(value) => pillow({ cutLineMm: value! })} /></div>
      <div className="pe-fields-two"><NumberField label="最细部位要求（mm）" value={document.spec.minimumNeckMm} min={1} max={500} onChange={(value) => pillow({ minimumNeckMm: value! })} /><NumberField label="前后片间距（mm）" value={document.spec.panelGapMm} min={0} max={500} onChange={(value) => pillow({ panelGapMm: value! })} /></div>
      <label>最细部位计量口径<select aria-label="最细部位计量口径" value={document.spec.minimumNeckBasis} onChange={(event) => pillow({ minimumNeckBasis: event.target.value as ShapedPillowDocument["spec"]["minimumNeckBasis"] })}><option value="unconfirmed">待工厂确认</option><option value="cut_contour">按裁剪轮廓测量</option><option value="finished">按缝制后成品测量</option></select></label>
      <h3>最下方空白条码框</h3><p className="pe-hint">固定连接主体最下方，正反片同步。宽高按实际要求填写，不允许放在侧边或上方。</p>
      <div className="pe-fields-two"><NumberField label="条码框宽（mm）" value={document.spec.barcodeTab.widthMm} min={1} max={5000} nullable onChange={(value) => pillow({ barcodeTab: { ...document.spec.barcodeTab, widthMm: value } })} /><NumberField label="条码框高（mm）" value={document.spec.barcodeTab.heightMm} min={1} max={5000} nullable onChange={(value) => pillow({ barcodeTab: { ...document.spec.barcodeTab, heightMm: value } })} /></div>
      <NumberField label="条码框中心 X（mm）" value={document.spec.barcodeTab.centerXMm} min={0} max={size.width} onChange={(value) => pillow({ barcodeTab: { ...document.spec.barcodeTab, centerXMm: value! } })} />
      <button className="pe-button" onClick={() => pillow({ barcodeTab: { ...document.spec.barcodeTab, centerXMm: pillowBottomCenter(document) } })}>条码移到主体最下方</button>
    </> : <>
      <NumberField label="圆形直径（mm）" value={document.spec.diameterMm} min={10} max={5000} onChange={(value) => tire({ diameterMm: value! })} />
      <NumberField label="输出 DPI" value={document.spec.dpi} min={72} max={600} integer onChange={(value) => tire({ dpi: value! })} />
      <p className="pe-hint">670 mm / 300 DPI 是可修改示例，需确认是否包含包边、缝份及安装余量。</p>
      <NumberField label="安全区内缩（mm）" value={document.spec.safeInsetMm} min={0} max={size.width / 2} onChange={(value) => tire({ safeInsetMm: value! })} />
      <label className="pe-check"><input type="checkbox" checked={!!document.spec.opening} onChange={(event) => tire({ opening: event.target.checked ? { xMm: size.width / 2, yMm: size.width / 2, diameterMm: 20 } : null })} />需要预留开孔</label>
      {document.spec.opening && <><NumberField label="开孔直径（mm）" value={document.spec.opening.diameterMm} min={1} max={5000} onChange={(value) => tire({ opening: { ...document.spec.opening!, diameterMm: value! } })} /><div className="pe-fields-two"><NumberField label="开孔中心 X（mm）" value={document.spec.opening.xMm} min={-5000} max={5000} onChange={(value) => tire({ opening: { ...document.spec.opening!, xMm: value! } })} /><NumberField label="开孔中心 Y（mm）" value={document.spec.opening.yMm} min={-5000} max={5000} onChange={(value) => tire({ opening: { ...document.spec.opening!, yMm: value! } })} /></div></>}
    </>}
  </section>;
}

export function ProductionLayerPanel({ layer, fonts, images, onChange }: { layer: ProductionEditorLayer | null; fonts: ProductionEditorFontView[]; images: ProductionEditorImageView[]; onChange: (patch: Partial<ProductionEditorLayer>) => void }) {
  const [proportional, setProportional] = useState(true);
  if (!layer) return <section className="pe-inspector-section"><h2>图层属性</h2><p className="pe-hint">选择画布中的图像或文字，调整位置与尺寸。</p></section>;
  const image = layer.kind === "image" ? images.find((item) => item.id === layer.assetId && item.version === layer.assetVersion) : null;
  return <section className="pe-inspector-section"><h2>{layer.kind === "image" ? "图片图层" : layer.arc ? "弧形文字" : "文字图层"}</h2>
    <fieldset className="pe-layer-fields" disabled={layer.locked}><label>图层名称<input value={layer.name} maxLength={160} onChange={(event) => onChange({ name: event.target.value })} /></label>
    {layer.locked && <p className="pe-hint">图层已锁定。画布位置保持固定，可先在图层列表解锁。</p>}
    {image && <p className="pe-hint">原件 {image.width} × {image.height} px · {image.actualAlpha ? "含实际透明区域" : "压平图片，未发现透明区域"}</p>}
    <div className="pe-fields-two"><NumberField label={layer.kind === "text" && layer.arc ? "圆心 X（mm）" : "位置 X（mm）"} value={layer.xMm} min={-10000} max={10000} disabled={layer.locked} onChange={(value) => onChange({ xMm: value! })} /><NumberField label={layer.kind === "text" && layer.arc ? "圆心 Y（mm）" : "位置 Y（mm）"} value={layer.yMm} min={-10000} max={10000} disabled={layer.locked} onChange={(value) => onChange({ yMm: value! })} /></div>
    {layer.kind === "image" ? <>
      <label className="pe-check"><input type="checkbox" checked={proportional} onChange={(event) => setProportional(event.target.checked)} />锁定宽高比例</label>
      <div className="pe-fields-two"><NumberField label="图片宽（mm）" value={layer.widthMm} min={0.1} max={5000} disabled={layer.locked} onChange={(value) => onChange(resizeImageProportionally(layer, "widthMm", value!, proportional))} /><NumberField label="图片高（mm）" value={layer.heightMm} min={0.1} max={5000} disabled={layer.locked} onChange={(value) => onChange(resizeImageProportionally(layer, "heightMm", value!, proportional))} /></div>
      <div className="pe-check-row"><label className="pe-check"><input type="checkbox" checked={layer.flipX} disabled={layer.locked} onChange={(event) => onChange({ flipX: event.target.checked } as Partial<ProductionEditorLayer>)} />水平翻转</label><label className="pe-check"><input type="checkbox" checked={layer.flipY} disabled={layer.locked} onChange={(event) => onChange({ flipY: event.target.checked } as Partial<ProductionEditorLayer>)} />垂直翻转</label></div>
      {image && <p className="pe-hint">有效分辨率约 {Math.round(Math.min(image.width * 25.4 / layer.widthMm, image.height * 25.4 / layer.heightMm))} DPI</p>}
    </> : <>
      <label>文字内容<textarea aria-label="文字内容" value={layer.text} rows={3} maxLength={500} onChange={(event) => onChange({ text: event.target.value } as Partial<ProductionEditorLayer>)} /></label>
      <label>字体<select value={layer.fontId} onChange={(event) => onChange({ fontId: event.target.value } as Partial<ProductionEditorLayer>)}>{fonts.map((font) => <option key={font.id} value={font.id}>{font.name}</option>)}{!fonts.some((font) => font.id === layer.fontId) && <option value={layer.fontId}>字体待加载</option>}</select></label>
      <div className="pe-fields-two"><NumberField label="字号（mm）" value={layer.fontSizeMm} min={0.1} max={500} onChange={(value) => onChange({ fontSizeMm: value! } as Partial<ProductionEditorLayer>)} /><NumberField label="字距（mm）" value={layer.letterSpacingMm} min={-10} max={100} onChange={(value) => onChange({ letterSpacingMm: value! } as Partial<ProductionEditorLayer>)} /></div>
      <label>文字颜色<input type="color" value={layer.color} onChange={(event) => onChange({ color: event.target.value } as Partial<ProductionEditorLayer>)} /></label>
      {layer.arc && <><NumberField label="弧形半径（mm）" value={layer.arc.radiusMm} min={1} max={5000} onChange={(value) => onChange({ arc: { ...layer.arc!, radiusMm: value! } } as Partial<ProductionEditorLayer>)} /><div className="pe-fields-two"><NumberField label="起始角度（°）" value={layer.arc.startAngleDeg} min={-360} max={layer.arc.endAngleDeg - 0.1} onChange={(value) => onChange({ arc: { ...layer.arc!, startAngleDeg: value! } } as Partial<ProductionEditorLayer>)} /><NumberField label="结束角度（°）" value={layer.arc.endAngleDeg} min={layer.arc.startAngleDeg + 0.1} max={360} onChange={(value) => onChange({ arc: { ...layer.arc!, endAngleDeg: value! } } as Partial<ProductionEditorLayer>)} /></div><p className="pe-hint">0° 在圆的右侧，−90° 在顶部。沿起始角到结束角排列文字。</p></>}
    </>}
    <div className="pe-fields-two"><NumberField label="旋转角度（°）" value={layer.rotationDeg} min={-360} max={360} disabled={layer.locked} onChange={(value) => onChange({ rotationDeg: value! })} /><NumberField label="不透明度（%）" value={layer.opacity * 100} min={0} max={100} integer onChange={(value) => onChange({ opacity: value! / 100 })} /></div></fieldset>
  </section>;
}

export function ProductionContourPanel({ points, onChange }: { points: ProductionEditorPoint[]; onChange: (points: ProductionEditorPoint[]) => void }) {
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, Math.max(0, points.length - 1));
  const point = points[index];
  if (!point) return <p className="pe-hint">点击画布放置第一个轮廓节点。</p>;
  function patch(value: Partial<ProductionEditorPoint>) { onChange(points.map((item, pointIndex) => pointIndex === index ? { ...item, ...value } : item)); }
  return <section className="pe-inspector-section"><h2>轮廓节点 · {points.length}</h2><label>当前节点<select value={index} onChange={(event) => setSelected(Number(event.target.value))}>{points.map((_item, pointIndex) => <option key={pointIndex} value={pointIndex}>节点 {pointIndex + 1}</option>)}</select></label><div className="pe-fields-two"><NumberField label="节点 X（mm）" value={point.xMm} min={-10000} max={10000} onChange={(value) => patch({ xMm: value! })} /><NumberField label="节点 Y（mm）" value={point.yMm} min={-10000} max={10000} onChange={(value) => patch({ yMm: value! })} /></div><label className="pe-check"><input type="checkbox" checked={point.smooth} onChange={(event) => patch({ smooth: event.target.checked })} />平滑节点</label><div className="pe-inline-buttons"><button className="pe-button" onClick={() => { const next = points[(index + 1) % points.length]!; const added = { xMm: (point.xMm + next.xMm) / 2, yMm: (point.yMm + next.yMm) / 2, smooth: true }; onChange([...points.slice(0, index + 1), added, ...points.slice(index + 1)]); setSelected(index + 1); }}>在后方增加节点</button><button className="pe-button" disabled={points.length <= 3} onClick={() => onChange(points.filter((_item, pointIndex) => pointIndex !== index))}>删除节点</button></div></section>;
}

export function ProductionConfirmations({ document, onChange, hasPreview }: { document: ProductionEditorDocument; onChange: (document: ProductionEditorDocument) => void; hasPreview: boolean }) {
  const labels: Array<[keyof ProductionEditorDocument["confirmations"], string]> = [["physicalSize", "实际尺寸与尺寸口径已由工厂确认"], ...(document.productType === "shaped_pillow" ? [["whiteBorderRule", "白边与黑裁线规则已确认"], ["narrowParts", "已按工厂口径人工检查最细部位"], ["barcodeTab", "条码框宽、高、位置已确认"], ["backText", "背片工艺与文字阅读方向已确认"]] as Array<[keyof ProductionEditorDocument["confirmations"], string]> : []), ["visualReview", "已查看当前图稿的后台校对预览"]];
  return <section className="pe-inspector-section"><h2>生产前确认</h2>{labels.map(([key, label]) => <label className="pe-check" key={key}><input type="checkbox" checked={document.confirmations[key]} disabled={key === "visualReview" && !hasPreview && !document.confirmations.visualReview} onChange={(event) => onChange({ ...document, confirmations: { ...document.confirmations, [key]: event.target.checked } })} />{label}</label>)}{!hasPreview && <p className="pe-hint">先生成后台校对预览，再确认图文与正反面效果。</p>}</section>;
}

export function NumberField({ label, value, min, max, nullable = false, disabled = false, integer = false, onChange }: { label: string; value: number | null; min: number; max: number; nullable?: boolean; disabled?: boolean; integer?: boolean; onChange: (value: number | null) => void }) {
  const [text, setText] = useState(value === null ? "" : String(round(value)));
  useEffect(() => setText(value === null ? "" : String(round(value))), [value]);
  function commit() { if (!text.trim() && nullable) { onChange(null); return; } const parsed = Number(text); if (!Number.isFinite(parsed) || !text.trim()) { setText(value === null ? "" : String(round(value))); return; } const next = Math.max(min, Math.min(max, integer ? Math.round(parsed) : parsed)); setText(String(round(next))); if (next !== value) onChange(next); }
  return <label>{label}<input type="number" value={text} min={min} max={max} step={integer ? 1 : "any"} disabled={disabled} placeholder={nullable ? "待填写" : undefined} onChange={(event) => setText(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}
function round(value: number) { return Math.round(value * 10000) / 10000; }
