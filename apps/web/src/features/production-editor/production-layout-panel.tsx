"use client";

import type { ProductionEditorDocument, ProductionEditorLayer } from "@yummyai/contracts/pod/production-editor";
import type { ProductionEditorImageView } from "@yummyai/contracts/pod/production-editor-api";
import { AlignHorizontalJustifyCenter, AlignVerticalJustifyCenter, Copy, RotateCcw, RotateCw, Upload } from "lucide-react";
import { useState } from "react";

import { imageEffectiveDpi, type LayoutAction } from "./production-layout-tools";

export function ProductionLayoutPanel({ document, layer, images, onAction, onDuplicate, onReplace, onUpload }: {
  document: ProductionEditorDocument; layer: ProductionEditorLayer; images: ProductionEditorImageView[];
  onAction: (action: LayoutAction) => void; onDuplicate: () => void; onReplace: (imageId: string) => void; onUpload: () => void;
}) {
  const [replacement, setReplacement] = useState("");
  const image = layer.kind === "image" ? images.find((item) => item.id === layer.assetId && item.version === layer.assetVersion) : null;
  return <div className="pe-layout-tools">
    <h3>快捷排版</h3>
    <fieldset disabled={layer.locked || !layer.visible}>
      <div className="pe-tool-grid">
        <button className="pe-button" onClick={() => onAction("centerX")}><AlignHorizontalJustifyCenter size={14} />水平居中</button>
        <button className="pe-button" onClick={() => onAction("centerY")}><AlignVerticalJustifyCenter size={14} />垂直居中</button>
        <button className="pe-button" onClick={() => onAction("rotateLeft")}><RotateCcw size={14} />左转 90°</button>
        <button className="pe-button" onClick={() => onAction("rotateRight")}><RotateCw size={14} />右转 90°</button>
      </div>
      <details><summary>边缘对齐</summary><div className="pe-tool-grid">{([["left", "靠左"], ["right", "靠右"], ["top", "靠上"], ["bottom", "靠下"]] as const).map(([action, label]) => <button className="pe-button" key={action} onClick={() => onAction(action)}>{label}</button>)}</div></details>
      <p className="pe-hint">按可见图文与印刷区域的外接框排版；异形边缘仍需目视检查。</p>
      {layer.kind === "image" ? <>
        <div className="pe-tool-grid"><button className="pe-button" onClick={() => onAction("fit")}>主体适应区域</button><button className="pe-button" onClick={() => onAction("resetRatio")}>恢复原图比例</button></div>
        {document.productType === "tire_cover" && <><button className="pe-button pe-tool-wide" disabled={image?.actualAlpha !== false} onClick={() => onAction("cover")}>铺满胎罩背景</button><p className="pe-hint">整图等比铺满并回正，超出圆形部分由画布裁切。透明素材请使用主体适应区域。</p></>}
        <details className="pe-replace-tools"><summary>替换所选图片</summary><label>替换素材<select value={replacement} onChange={(event) => setReplacement(event.target.value)}><option value="">选择本项目素材</option>{images.filter((item) => item.id !== layer.assetId).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><div className="pe-tool-grid"><button className="pe-button" disabled={!replacement} onClick={() => { onReplace(replacement); setReplacement(""); }}>应用替换</button><button className="pe-button" onClick={onUpload}><Upload size={14} />上传并替换</button></div><p className="pe-hint">新图等比放入原占位框，保留中心、旋转及翻转。原素材可再次选用。</p></details>
      </> : <>
        <div className="pe-tool-grid"><button className="pe-button" aria-pressed={!layer.arc} onClick={() => onAction("straightText")}>直排文字</button><button className="pe-button" aria-pressed={!!layer.arc} onClick={() => onAction("arcText")}>顶部弧形</button></div>
        {layer.arc && <><button className="pe-button pe-tool-wide" onClick={() => onAction("fitArc")}>字号适应弧长</button><p className="pe-hint">字号与字距等比调整，保留弧形半径。</p></>}
      </>}
    </fieldset>
    <button className="pe-button pe-tool-wide" disabled={layer.locked || document.layers.length >= 100} onClick={onDuplicate}><Copy size={14} />复制所选图层 <kbd>Ctrl D</kbd></button>
  </div>;
}

export function ProductionResolutionPanel({ document, images, onSelect }: { document: ProductionEditorDocument; images: ProductionEditorImageView[]; onSelect: (id: string) => void }) {
  const entries = document.layers.flatMap((layer) => {
    if (layer.kind !== "image" || !layer.visible || layer.opacity === 0) return [];
    const image = images.find((item) => item.id === layer.assetId && item.version === layer.assetVersion);
    return [{ layer, dpi: image ? imageEffectiveDpi(layer, image) : null }];
  });
  if (!entries.length) return null;
  const low = entries.filter((item) => item.dpi === null || item.dpi < document.spec.dpi);
  return <details className="pe-resolution-check" open={low.length > 0 ? true : undefined}><summary>图片清晰度 · {low.length ? `${low.length} 项需留意` : "达到输出 DPI"}</summary><p className="pe-hint">目标 {document.spec.dpi} DPI，按原图像素和当前印刷尺寸计算。</p><ul>{entries.map(({ layer, dpi }) => <li key={layer.id}><button onClick={() => onSelect(layer.id)}><span>{layer.name}</span><b className={dpi === null || dpi < document.spec.dpi ? "pe-resolution-low" : ""}>{dpi === null ? "素材缺失" : `${Math.floor(dpi)} DPI`}</b></button></li>)}</ul>{low.length > 0 && <p className="pe-hint">点击定位图层，可换用更清晰原图或缩小印刷尺寸。仅修改 DPI 数值不会增加细节。</p>}</details>;
}

export function ProductionShortcutHelp() {
  return <details className="pe-shortcut-help"><summary>快捷键</summary><dl><div><dt>Ctrl / ⌘ S</dt><dd>保存新版本</dd></div><div><dt>Ctrl / ⌘ D</dt><dd>复制所选图层</dd></div><div><dt>方向键 / Shift + 方向键</dt><dd>移动 1 / 10 mm</dd></div><div><dt>Delete</dt><dd>删除未锁定图层</dd></div><div><dt>Ctrl / ⌘ Z · Shift Z</dt><dd>撤销 · 重做</dd></div></dl><p className="pe-hint">先点击画布或图层。输入文字、抠图和勾轮廓时不触发图层快捷键。</p></details>;
}
