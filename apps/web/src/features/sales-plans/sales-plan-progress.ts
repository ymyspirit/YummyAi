import { specificationFactsReady } from "@yummyai/contracts/catalog/development";
import type { SalesPlanFields, SalesPlanListing } from "@yummyai/contracts/catalog/sales-plan";
import type { SpecificationView } from "@yummyai/contracts/catalog/development";

export const salesPlanSteps = ["载体与工艺", "印花设计", "商品组合", "套图与文案", "刊登审核"] as const;
export function salesPlanProgress(
  fields: SalesPlanFields,
  specifications: SpecificationView[],
  listings: SalesPlanListing[],
) {
  const selected = specifications.filter((spec) => fields.specificationIds.includes(spec.id));
  const product =
    selected.length === fields.specificationIds.length &&
    selected.length > 0 &&
    selected.every((spec) => specificationFactsReady(spec.facts));
  const content =
    !!fields.title.trim() &&
    !!fields.description.trim() &&
    fields.bullets.some((bullet) => !!bullet.trim()) &&
    !!fields.mainImageId &&
    (fields.mode === "standard" ||
      ((fields.customization.fields.length > 0 || !!fields.patternChoices) && !!fields.customInstructions.trim()));
  return [
    { complete: product, detail: product ? "所选规格事实已确认" : "选择规格并核对商品事实" },
    { complete: fields.artworkVersionIds.length > 0, detail: fields.artworkVersionIds.length ? `已选择 ${fields.artworkVersionIds.length} 个印花版本` : "准备原创印花或顾客定制方案" },
    { complete: fields.skuIds.length > 0, detail: fields.skuIds.length ? `已关联 ${fields.skuIds.length} 个销售 SKU` : "固定规格、制作面与定制字段映射" },
    {
      complete: content,
      detail: content ? "基础图文已准备，仍需审核" : "准备图文、设计及定制素材",
    },
    {
      complete: false,
      detail: listings.length ? "本地刊登已创建，查看平台提交结果" : "创建本地刊登草稿",
    },
  ];
}
