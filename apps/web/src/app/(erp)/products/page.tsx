import { Boxes } from "lucide-react";

import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import { ProductEditor, type ProductPlanView } from "../../../features/products/product-editor";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const result = await loadProductPlan();
  return (
    <div className="research-shell product-shell">
      <ErpSidebar active="products" contextLabel="PRODUCT ERP" note="证据审批、产品状态、定制 Schema、成本与供应商候选在同一开发档案中留痕。" />
      <main className="research-main product-main">
        {result.plan ? <ProductEditor initialPlan={result.plan} /> : <section className="analysis-error" role="alert"><Boxes size={28} /><h1>暂无产品计划</h1><p>{result.error ?? "从已审批的分析报告创建第一个产品计划。"}</p><a href="/research">返回研究资料库</a></section>}
      </main>
    </div>
  );
}

async function loadProductPlan(): Promise<{ plan?: ProductPlanView; error?: string }> {
  if (process.env.PRODUCT_DEMO_MODE === "1") return { plan: demoPlan() };
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置产品 API。请设置 API_BASE_URL 后重试。" };
  const headers: Record<string, string> = process.env.API_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}` } : {};
  try {
    const response = await fetch(`${apiBase.replace(/\/$/, "")}/v1/products/plans`, { cache: "no-store", headers });
    if (!response.ok) throw new Error(`产品计划读取失败 (${response.status})`);
    const plans = await response.json() as ProductPlanView[];
    return plans[0] ? { plan: plans[0] } : {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "产品计划读取失败" };
  }
}

function demoPlan(): ProductPlanView {
  return {
    id: "0198fbef-4a10-7000-8000-000000000041",
    name: "轻定制旅行礼品杯",
    description: "面向节日与企业礼赠场景，用可选刻字、两档礼盒和明确交付承诺验证中价位机会。",
    status: "developing",
    sourceReportIds: ["0198fbef-4a10-7000-8000-000000000042", "0198fbef-4a10-7000-8000-000000000043"],
    targetCost: { amount: 8.5, currency: "USD" },
    customization: { version: 3, fields: [
      { key: "finish", label: "杯身颜色", type: "color", required: true, palette: ["#1E3A5F", "#A16207", "#F6F8FA"], productionMapping: { targetSystem: "mes", path: "finish.hex" } },
      { key: "engraving", label: "刻字内容", type: "short_text", required: false, validation: { maxLength: 24 }, productionMapping: { targetSystem: "mes", path: "laser.text" } },
      { key: "gift_box", label: "礼盒", type: "single_choice", required: true, options: [{ value: "standard", label: "标准礼盒" }, { value: "premium", label: "高级礼盒" }] },
      { key: "gift_message", label: "赠言", type: "long_text", required: false, visibleWhen: { fieldKey: "gift_box", operator: "equals", value: "premium" } },
      { key: "logo", label: "企业 Logo", type: "image", required: false, validation: { allowedMediaTypes: ["image/png", "image/jpeg"], maxFiles: 1, maxBytes: 10_000_000 } },
    ] },
    spu: { code: "TRAVEL-MUG-GIFT", name: "Travel Mug Gift", skus: [
      { code: "TMG-NVY-16", attributes: { finish: "navy", size: "16oz" }, unitCost: { amount: 7.8, currency: "USD" } },
      { code: "TMG-SND-16", attributes: { finish: "sand", size: "16oz" }, unitCost: { amount: 8.1, currency: "USD" } },
    ] },
    suppliers: [
      { id: "0198fbef-4a10-7000-8000-000000000044", name: "Northstar Drinkware", priority: 1, quotedCost: { amount: 7.8, currency: "USD" }, minimumOrderQuantity: 300, leadTimeDays: 24 },
      { id: "0198fbef-4a10-7000-8000-000000000045", name: "Harbor Gift Works", priority: 2, quotedCost: { amount: 8.2, currency: "USD" }, minimumOrderQuantity: 150, leadTimeDays: 18 },
    ],
  };
}
