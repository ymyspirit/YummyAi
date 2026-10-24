// Display known business diagnostics in Chinese while retaining the original
// immutable receipt and unknown diagnostics for review.
export function customProductIssueLabel(
  issue: { code: string; message: string },
  unverifiedFactCount: number,
) {
  if (issue.code === "unverified_facts") return `${unverifiedFactCount} 项商品事实仍需卖家核实`;
  const labels: Record<string, string> = {
    missing_sku: "请补充 SKU",
    missing_marketplace: "请明确目标亚马逊站点",
    missing_product_type: "请明确商品类型",
    missing_brand: "正式包需要已确认的品牌",
    missing_material: "请至少填写一种实际材质",
    missing_size: "请至少填写一种成品规格",
    missing_package_quantity: "请明确每包商品数量",
    missing_package_contents: "请填写包装内实际包含的物品",
    missing_process: "请明确生产工艺",
    missing_surface: "请至少定义一个定制面",
    missing_custom_area: "请填写定制区域的宽高 单位为毫米",
    missing_surface_fields: "每个定制面至少需要一个定制字段",
    missing_authorized_assets: "请补充至少一份权利审核通过的实物或成品样品素材",
  };
  return Object.hasOwn(labels, issue.code) ? labels[issue.code]! : issue.message;
}
