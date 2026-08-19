"use client";

import type { CustomizationDefinition, ProductStatus } from "@yummyai/contracts";
import type { CustomProductProfileV1 } from "@yummyai/contracts/catalog/custom-product-package";
import { ArrowUpRight, Boxes, CircleDollarSign, Factory, FileSearch2, FileText, PackageCheck, Palette } from "lucide-react";
import Link from "next/link";
import { useActionState, useState } from "react";

import { CustomizationSchemaEditor } from "./customization-schema-editor";
import { CustomProductPackagePanel } from "./custom-product-package-panel";
import { saveProductPlanCustomization, type ProductDevelopmentState } from "./product-actions";
import { ProductDevelopmentActions } from "./product-development-actions";

export interface ProductPlanView {
  id: string;
  name: string;
  description?: string;
  status: ProductStatus;
  sourceReportIds: string[];
  targetCost?: { amount: number; currency: string };
  customization: CustomizationDefinition;
  customProductProfile?: CustomProductProfileV1;
  ownerUserId?: string;
  ownerName?: string;
  createdAt?: string;
  updatedAt?: string;
  spu?: {
    id: string;
    code: string;
    name: string;
    skus: Array<{
      id: string;
      code: string;
      attributes: Record<string, string>;
      unitCost?: { amount: number; currency: string };
    }>;
  };
  suppliers?: Array<{
    id: string;
    name: string;
    priority: number;
    quotedCost?: { amount: number; currency: string };
    minimumOrderQuantity?: number;
    leadTimeDays?: number;
  }>;
  designTasks?: Array<{
    id: string;
    skuCode: string;
    title: string;
    status: string;
    dueAt?: string;
  }>;
  listings?: Array<{
    id: string;
    platform: "amazon" | "etsy";
    marketplaceId?: string;
    locale: string;
    status: string;
  }>;
}

const stages: ProductStatus[] = ["researching", "pending_approval", "approved", "developing", "listing", "ready"];
const initialSaveState: ProductDevelopmentState = { message: "", status: "idle" };

export function isCustomProductProfileEditable(status: ProductStatus): boolean {
  return ["researching", "approved", "developing"].includes(status);
}

export function ProductEditor({ initialPlan }: { initialPlan: ProductPlanView }) {
  const [customization, setCustomization] = useState(initialPlan.customization);
  const [saveState, saveAction, savePending] = useActionState(saveProductPlanCustomization.bind(null, initialPlan.id), initialSaveState);
  const stageIndex = stages.indexOf(initialPlan.status);
  return (
    <div className="product-workbench">
      <header className="product-hero">
        <div>
          <p className="kicker">PRODUCT PLAN / DEVELOPMENT DOCKET</p>
          <h2>{initialPlan.name}</h2>
          <p>{initialPlan.description ?? "从已审批的证据结论推进到可生产、可刊登的商品主数据。"}</p>
        </div>
        <div className="plan-id">
          <span>PLAN ID</span>
          <code>{initialPlan.id}</code>
          <strong>{statusLabel(initialPlan.status)}</strong>
        </div>
      </header>
      <nav className="lifecycle-track" aria-label="产品生命周期">
        {stages.map((stage, index) => (
          <div key={stage} className={index < stageIndex ? "stage-done" : index === stageIndex ? "stage-current" : ""}>
            <span>{index < stageIndex ? "✓" : String(index + 1).padStart(2, "0")}</span>
            <strong>{statusLabel(stage)}</strong>
          </div>
        ))}
      </nav>
      <section className="product-summary" aria-label="产品计划摘要">
        <div>
          <CircleDollarSign size={18} />
          <span>目标成本</span>
          <strong className="mono">{initialPlan.targetCost ? `${initialPlan.targetCost.currency} ${initialPlan.targetCost.amount.toFixed(2)}` : "待核算"}</strong>
        </div>
        <div>
          <PackageCheck size={18} />
          <span>审批证据</span>
          <strong className="mono">{initialPlan.sourceReportIds.length} REPORTS</strong>
        </div>
        <div>
          <Boxes size={18} />
          <span>SKU 数量</span>
          <strong className="mono">{initialPlan.spu?.skus.length ?? 0}</strong>
        </div>
        <div>
          <Factory size={18} />
          <span>供应商候选</span>
          <strong className="mono">{initialPlan.suppliers?.length ?? 0}</strong>
        </div>
      </section>
      <ProductDevelopmentActions plan={initialPlan} />
      <CustomizationSchemaEditor initialSchema={customization} onChange={setCustomization} />
      <CustomProductPackagePanel
        customizationFieldKeys={customization.fields.map((field) => field.key)}
        editable={isCustomProductProfileEditable(initialPlan.status)}
        planId={initialPlan.id}
        profile={initialPlan.customProductProfile}
        researchItemIds={initialPlan.sourceReportIds}
      />
      <div className="product-lower-grid">
        <section className="sku-frame" aria-labelledby="sku-title">
          <header>
            <div>
              <p className="section-code">SPU / SKU REGISTER</p>
              <h2 id="sku-title">商品变体</h2>
            </div>
            <span className="mono">{initialPlan.spu?.code ?? "SPU 待创建"}</span>
          </header>
          {initialPlan.spu ? (
            <table>
              <thead>
                <tr>
                  <th>SKU 编码</th>
                  <th>属性</th>
                  <th>单位成本</th>
                </tr>
              </thead>
              <tbody>
                {initialPlan.spu.skus.map((sku) => (
                  <tr key={sku.code}>
                    <td>
                      <code>{sku.code}</code>
                    </td>
                    <td>
                      {Object.entries(sku.attributes)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(" · ") || "标准款"}
                    </td>
                    <td className="mono">{sku.unitCost ? `${sku.unitCost.currency} ${sku.unitCost.amount.toFixed(2)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="panel-empty">产品计划审批后才能创建 SPU 与 SKU。</p>
          )}
        </section>
        <section className="supplier-frame" aria-labelledby="supplier-title">
          <header>
            <p className="section-code">SUPPLIER CANDIDATES</p>
            <h2 id="supplier-title">供应商优先级</h2>
          </header>
          <ol>
            {initialPlan.suppliers?.map((supplier) => (
              <li key={supplier.id}>
                <span className="supplier-rank mono">P{supplier.priority}</span>
                <div>
                  <strong>{supplier.name}</strong>
                  <small>
                    {supplier.minimumOrderQuantity ? `MOQ ${supplier.minimumOrderQuantity}` : "MOQ 待确认"} · {supplier.leadTimeDays ?? "—"} 天
                  </small>
                </div>
                <b className="mono">{supplier.quotedCost ? `${supplier.quotedCost.currency} ${supplier.quotedCost.amount.toFixed(2)}` : "待报价"}</b>
              </li>
            ))}
          </ol>
        </section>
      </div>
      <section className="product-associations" aria-labelledby="product-associations-title">
        <header>
          <div>
            <p className="section-code">TRACEABLE ASSOCIATIONS</p>
            <h2 id="product-associations-title">关联工作</h2>
          </div>
          <span>仅显示当前租户可见的真实记录</span>
        </header>
        <div>
          <AssociationColumn icon={<FileSearch2 size={17} />} title="研究来源" count={initialPlan.sourceReportIds.length} empty="尚未关联研究报告。">
            {initialPlan.sourceReportIds.map((reportId) => (
              <Link href={`/analysis/${reportId}`} key={reportId}>
                <span>
                  <strong>分析报告</strong>
                  <code>{reportId}</code>
                </span>
                <ArrowUpRight size={14} />
              </Link>
            ))}
          </AssociationColumn>
          <AssociationColumn icon={<Palette size={17} />} title="设计任务" count={initialPlan.designTasks?.length ?? 0} empty={initialPlan.spu ? "当前 SPU/SKU 尚未创建设计任务。" : "创建 SPU/SKU 后才能关联设计任务。"}>
            {initialPlan.designTasks?.map((task) => (
              <Link href={`/design?task=${encodeURIComponent(task.id)}`} key={task.id}>
                <span>
                  <strong>{task.title}</strong>
                  <small>
                    {task.skuCode} · {task.status}
                  </small>
                </span>
                <ArrowUpRight size={14} />
              </Link>
            ))}
          </AssociationColumn>
          <AssociationColumn icon={<FileText size={17} />} title="Listing" count={initialPlan.listings?.length ?? 0} empty={initialPlan.spu ? "当前 SPU 尚未创建 Listing。" : "创建 SPU 后才能关联 Listing。"}>
            {initialPlan.listings?.map((listing) => (
              <Link href={`/listings/${listing.id}`} key={listing.id}>
                <span>
                  <strong>
                    {listing.platform === "amazon" ? "Amazon" : "Etsy"} · {listing.locale}
                  </strong>
                  <small>
                    {listing.marketplaceId ?? "未指定店铺"} · {listing.status}
                  </small>
                </span>
                <ArrowUpRight size={14} />
              </Link>
            ))}
          </AssociationColumn>
        </div>
      </section>
      <form action={saveAction} className="editor-footer">
        <input name="customization" type="hidden" value={JSON.stringify(customization)} />
        <span className="mono">
          SCHEMA V{customization.version} · {customization.fields.length} FIELDS
        </span>
        {saveState.status !== "idle" ? <small role={saveState.status === "error" ? "alert" : "status"}>{saveState.message}</small> : null}
        <button disabled={savePending || initialPlan.status !== "researching"} type="submit">
          {savePending ? "保存中…" : initialPlan.status === "researching" ? "保存产品计划" : "产品计划已锁定"}
        </button>
      </form>
    </div>
  );
}

function AssociationColumn({ children, count, empty, icon, title }: { children?: React.ReactNode; count: number; empty: string; icon: React.ReactNode; title: string }) {
  return (
    <article>
      <header>
        <span>{icon}</span>
        <h3>{title}</h3>
        <b>{count}</b>
      </header>
      {count ? <div className="product-association-links">{children}</div> : <p>{empty}</p>}
    </article>
  );
}

function statusLabel(status: ProductStatus) {
  return {
    researching: "研究中",
    pending_approval: "待审批",
    approved: "已审批",
    developing: "开发中",
    listing: "刊登准备",
    ready: "已就绪",
    archived: "已归档",
  }[status];
}
