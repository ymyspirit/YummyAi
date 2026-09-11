"use client";
import type { ProductionEditorDocument } from "@yummyai/contracts/pod/production-editor";
import type { OrderProductionRequirements } from "./order-production-requirements";
import { ClipboardList } from "lucide-react";

export function OrderRequirementsPanel({ requirements, document, onApply, disabled }: { requirements: OrderProductionRequirements; document?: ProductionEditorDocument; onApply: () => void; disabled?: boolean }) {
  const mismatch = document?.productType === "shaped_pillow" && ((requirements.sizeInches && Math.abs((document.spec.declaredLongestMm ?? 0) - requirements.sizeInches * 25.4) > 0.01) || (requirements.sideMode && document.spec.sideMode !== requirements.sideMode));
  return <section className="pe-order-requirements" aria-label="顾客制作要求"><div className="pe-requirements-heading"><h2><ClipboardList size={16} />顾客制作要求</h2><span>先确认保留范围，再处理图片</span></div>
    <div className="pe-requirements-summary"><strong>{requirements.subject === "head" ? "仅保留完整头部" : requirements.subject === "body" ? "保留完整主体（全身）" : "保留范围待确认"}</strong><span>{requirements.sizeInches ? `${requirements.sizeInches} 英寸` : "尺寸待确认"}</span><span>{requirements.sideMode === "single" ? "单面印刷 · 背片留白" : requirements.sideMode === "double" ? "双面印刷" : "印刷方式待确认"}</span></div>
    {requirements.subject === "head" && <p>保留头顶、双耳和下巴，去掉身体与背景；毛发、胡须边缘在抠图后放大检查。请在原图框选具体头部范围。</p>}
    {requirements.warnings.map((warning) => <p className="pe-requirements-warning" key={warning}>{warning}</p>)}
    {mismatch && <div className="pe-requirements-mismatch"><span>当前草稿的规格与订单选项不一致。</span><button className="pe-button" disabled={disabled} onClick={onApply}>带入订单规格与印刷方式</button></div>}
    <details><summary>对照顾客原始选项</summary><dl>{requirements.fields.map((field, index) => <div key={index}><dt>{field.label}</dt><dd>{field.value || "（空）"}</dd></div>)}</dl></details>
  </section>;
}
