import { Boxes, ShieldCheck } from "lucide-react";

import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import { ProductCatalog } from "../../../features/products/product-catalog";
import { ProductEditor, type ProductPlanView } from "../../../features/products/product-editor";
import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ProductsPage({ searchParams }: { searchParams: SearchParams }) {
  const [result, params] = await Promise.all([loadProductPlans(), searchParams]);
  const query = stringValue(params.q);
  const status = stringValue(params.status);
  const owner = stringValue(params.owner);
  const selectedId = stringValue(params.plan);
  const selectedPlan = selectedId ? result.items.find((plan) => plan.id === selectedId) : undefined;

  return (
    <div className="research-shell product-shell">
      <ErpSidebar
        active="products"
        contextLabel="PRODUCT ERP"
        note="证据审批、产品状态、定制 Schema、成本与供应商候选在同一开发档案中留痕。"
      />
      <main className="research-main product-main">
        <header className="product-index-header">
          <div>
            <p className="kicker">CATALOG / PRODUCT CONTROL</p>
            <h1>产品目录</h1>
            <p>按真实企划状态定位产品，再进入定制 Schema、SPU/SKU、供应商与 Listing 开发档案。</p>
          </div>
          <span>
            <ShieldCheck aria-hidden="true" size={18} />
            EVIDENCE GATED
          </span>
        </header>

        {result.error ? (
          <section className="product-catalog-load-state" role="alert">
            <Boxes aria-hidden="true" size={24} />
            <div>
              <strong>产品目录暂不可用</strong>
              <span>{result.error}</span>
            </div>
          </section>
        ) : (
          <>
            <ProductCatalog
              items={result.items}
              query={query}
              selectedId={selectedId}
              status={status}
              owner={owner}
            />
            {selectedId && !selectedPlan ? (
              <p className="product-selection-error" role="alert">
                指定产品不存在或当前成员无权访问。
              </p>
            ) : null}
            {selectedPlan ? (
              <section
                className="product-detail-section"
                id="product-detail"
                aria-label={`${selectedPlan.name} 产品详情`}
              >
                <ProductEditor initialPlan={selectedPlan} />
              </section>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}

async function loadProductPlans(): Promise<{ items: ProductPlanView[]; error?: string }> {
  if (process.env.PRODUCT_DEMO_MODE === "1") return { items: [demoPlan()] };
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { items: [], error: "尚未配置产品 API。请设置 API_BASE_URL 后重试。" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/products/plans`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`产品计划读取失败 (${response.status})`);
    return { items: (await response.json()) as ProductPlanView[] };
  } catch (error) {
    return { items: [], error: error instanceof Error ? error.message : "产品计划读取失败" };
  }
}

function stringValue(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function demoPlan(): ProductPlanView {
  return {
    id: "0198fbef-4a10-7000-8000-000000000041",
    name: "轻定制旅行礼品杯",
    description: "面向节日与企业礼赠场景，用可选刻字、两档礼盒和明确交付承诺验证中价位机会。",
    status: "developing",
    sourceReportIds: [
      "0198fbef-4a10-7000-8000-000000000042",
      "0198fbef-4a10-7000-8000-000000000043",
    ],
    targetCost: { amount: 8.5, currency: "USD" },
    ownerUserId: "0198fbef-4a10-7000-8000-000000000040",
    ownerName: "Lin Q.",
    createdAt: "2026-07-16T05:10:00.000Z",
    updatedAt: "2026-07-18T03:12:00.000Z",
    customization: {
      version: 3,
      fields: [
        {
          key: "finish",
          label: "杯身颜色",
          type: "color",
          required: true,
          palette: ["#1E3A5F", "#A16207", "#F6F8FA"],
          productionMapping: { targetSystem: "mes", path: "finish.hex" },
        },
        {
          key: "engraving",
          label: "刻字内容",
          type: "short_text",
          required: false,
          validation: { maxLength: 24 },
          productionMapping: { targetSystem: "mes", path: "laser.text" },
        },
        {
          key: "gift_box",
          label: "礼盒",
          type: "single_choice",
          required: true,
          options: [
            { value: "standard", label: "标准礼盒" },
            { value: "premium", label: "高级礼盒" },
          ],
        },
        {
          key: "gift_message",
          label: "赠言",
          type: "long_text",
          required: false,
          visibleWhen: { fieldKey: "gift_box", operator: "equals", value: "premium" },
        },
        {
          key: "logo",
          label: "企业 Logo",
          type: "image",
          required: false,
          validation: {
            allowedMediaTypes: ["image/png", "image/jpeg"],
            maxFiles: 1,
            maxBytes: 10_000_000,
          },
        },
      ],
    },
    spu: {
      id: "0198fbef-4a10-7000-8000-000000000045",
      code: "TRAVEL-MUG-GIFT",
      name: "Travel Mug Gift",
      skus: [
        {
          id: "0198fbef-4a10-7000-8000-000000000046",
          code: "TMG-NVY-16",
          attributes: { finish: "navy", size: "16oz" },
          unitCost: { amount: 7.8, currency: "USD" },
        },
        {
          id: "0198fbef-4a10-7000-8000-000000000047",
          code: "TMG-SND-16",
          attributes: { finish: "sand", size: "16oz" },
          unitCost: { amount: 8.1, currency: "USD" },
        },
      ],
    },
    suppliers: [
      {
        id: "0198fbef-4a10-7000-8000-000000000044",
        name: "Northstar Drinkware",
        priority: 1,
        quotedCost: { amount: 7.8, currency: "USD" },
        minimumOrderQuantity: 300,
        leadTimeDays: 24,
      },
      {
        id: "0198fbef-4a10-7000-8000-000000000045",
        name: "Harbor Gift Works",
        priority: 2,
        quotedCost: { amount: 8.2, currency: "USD" },
        minimumOrderQuantity: 150,
        leadTimeDays: 18,
      },
    ],
    designTasks: [
      { id: "0198fbef-4a10-7000-8000-000000000091", skuCode: "TMG-NVY-16", title: "旅行礼品杯 · 激光刻字与礼盒校样", status: "in_review", dueAt: "2026-07-24T10:00:00.000Z" },
    ],
    listings: [
      { id: "0198fbef-4a10-7000-8000-000000000061", platform: "amazon", marketplaceId: "ATVPDKIKX0DER", locale: "en-US", status: "in_review" },
      { id: "0198fbef-4a10-7000-8000-000000000062", platform: "etsy", locale: "en-US", status: "draft" },
    ],
  };
}
