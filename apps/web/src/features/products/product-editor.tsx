"use client";

import type { CustomizationDefinition, ProductStatus } from "@yummyai/contracts";
import { Boxes, CircleDollarSign, Factory, PackageCheck } from "lucide-react";
import { useState } from "react";

import { CustomizationSchemaEditor } from "./customization-schema-editor";

export interface ProductPlanView {
  id: string;
  name: string;
  description?: string;
  status: ProductStatus;
  sourceReportIds: string[];
  targetCost?: { amount: number; currency: string };
  customization: CustomizationDefinition;
  spu?: { code: string; name: string; skus: Array<{ code: string; attributes: Record<string, string>; unitCost?: { amount: number; currency: string } }> };
  suppliers?: Array<{ id: string; name: string; priority: number; quotedCost?: { amount: number; currency: string }; minimumOrderQuantity?: number; leadTimeDays?: number }>;
}

const stages: ProductStatus[] = ["researching", "pending_approval", "approved", "developing", "listing", "ready"];

export function ProductEditor({ initialPlan }: { initialPlan: ProductPlanView }) {
  const [customization, setCustomization] = useState(initialPlan.customization);
  const stageIndex = stages.indexOf(initialPlan.status);
  return (
    <div className="product-workbench">
      <header className="product-hero">
        <div><p className="kicker">PRODUCT PLAN / DEVELOPMENT DOCKET</p><h1>{initialPlan.name}</h1><p>{initialPlan.description ?? "从已审批的证据结论推进到可生产、可刊登的商品主数据。"}</p></div>
        <div className="plan-id"><span>PLAN ID</span><code>{initialPlan.id}</code><strong>{statusLabel(initialPlan.status)}</strong></div>
      </header>
      <nav className="lifecycle-track" aria-label="产品生命周期">
        {stages.map((stage, index) => <div key={stage} className={index < stageIndex ? "stage-done" : index === stageIndex ? "stage-current" : ""}><span>{index < stageIndex ? "✓" : String(index + 1).padStart(2, "0")}</span><strong>{statusLabel(stage)}</strong></div>)}
      </nav>
      <section className="product-summary" aria-label="产品计划摘要">
        <div><CircleDollarSign size={18} /><span>目标成本</span><strong className="mono">{initialPlan.targetCost ? `${initialPlan.targetCost.currency} ${initialPlan.targetCost.amount.toFixed(2)}` : "待核算"}</strong></div>
        <div><PackageCheck size={18} /><span>审批证据</span><strong className="mono">{initialPlan.sourceReportIds.length} REPORTS</strong></div>
        <div><Boxes size={18} /><span>SKU 数量</span><strong className="mono">{initialPlan.spu?.skus.length ?? 0}</strong></div>
        <div><Factory size={18} /><span>供应商候选</span><strong className="mono">{initialPlan.suppliers?.length ?? 0}</strong></div>
      </section>
      <CustomizationSchemaEditor initialSchema={customization} onChange={setCustomization} />
      <div className="product-lower-grid">
        <section className="sku-frame" aria-labelledby="sku-title">
          <header><div><p className="section-code">SPU / SKU REGISTER</p><h2 id="sku-title">商品变体</h2></div><span className="mono">{initialPlan.spu?.code ?? "SPU 待创建"}</span></header>
          {initialPlan.spu ? <table><thead><tr><th>SKU 编码</th><th>属性</th><th>单位成本</th></tr></thead><tbody>{initialPlan.spu.skus.map((sku) => <tr key={sku.code}><td><code>{sku.code}</code></td><td>{Object.entries(sku.attributes).map(([key, value]) => `${key}: ${value}`).join(" · ") || "标准款"}</td><td className="mono">{sku.unitCost ? `${sku.unitCost.currency} ${sku.unitCost.amount.toFixed(2)}` : "—"}</td></tr>)}</tbody></table> : <p className="panel-empty">产品计划审批后才能创建 SPU 与 SKU。</p>}
        </section>
        <section className="supplier-frame" aria-labelledby="supplier-title">
          <header><p className="section-code">SUPPLIER CANDIDATES</p><h2 id="supplier-title">供应商优先级</h2></header>
          <ol>{initialPlan.suppliers?.map((supplier) => <li key={supplier.id}><span className="supplier-rank mono">P{supplier.priority}</span><div><strong>{supplier.name}</strong><small>{supplier.minimumOrderQuantity ? `MOQ ${supplier.minimumOrderQuantity}` : "MOQ 待确认"} · {supplier.leadTimeDays ?? "—"} 天</small></div><b className="mono">{supplier.quotedCost ? `${supplier.quotedCost.currency} ${supplier.quotedCost.amount.toFixed(2)}` : "待报价"}</b></li>)}</ol>
        </section>
      </div>
      <footer className="editor-footer"><span className="mono">SCHEMA V{customization.version} · {customization.fields.length} FIELDS</span><button type="button">保存产品计划</button></footer>
    </div>
  );
}

function statusLabel(status: ProductStatus) {
  return ({ researching: "研究中", pending_approval: "待审批", approved: "已审批", developing: "开发中", listing: "刊登准备", ready: "已就绪", archived: "已归档" })[status];
}
