import type { SalesPlanDetail } from "@yummyai/contracts/catalog/sales-plan";
import type { SalesPlanLaunch } from "@yummyai/contracts/catalog/sales-plan-launch";
import type { PreparationStep } from "@yummyai/contracts/catalog/sales-plan-agent";

/** The model cannot select arbitrary tools or declare an artifact approved. */
export function preparationDecision(detail: SalesPlanDetail, launch: SalesPlanLaunch) {
  const plan = detail.plan;
  const listing = detail.listings.find(l => l.marketplaceId === plan.fields.marketplaceId &&
    l.locale === plan.fields.locale && l.status !== "archived");
  const product = launch.stages.find(s => s.key === "product");
  const design = launch.stages.find(s => s.key === "design");
  const synced = !!listing && listing.planRevision === plan.revision;
  const factsReady = product?.status === "ready";
  const designReady = design?.status === "ready";
  const href = `/sales-plans?plan=${plan.id}`;
  const steps: PreparationStep[] = [
    { key: "product", label: "核对载体与工艺", state: factsReady ? "passed" : "blocked",
      detail: product?.detail ?? "商品资料不可读取", href: product?.href ?? `${href}&step=0` },
    { key: "design", label: "核对印花组合与套图", state: designReady ? "passed" : "blocked",
      detail: design?.detail ?? "制作和图片依据不可读取", href: design?.href ?? `${href}&step=2` },
    { key: "draft", label: "准备本地刊登草稿", state: synced ? "passed" : "pending",
      detail: synced ? "已固定当前方案与刊登版本" : "资料齐备后创建或同步已保存的方案",
      href: listing ? `/listings/${listing.id}` : `${href}&step=4` },
    { key: "review", label: "核对提交审核条件", state: synced && !listing.blockers.length && factsReady && designReady ? "passed" : "waiting",
      detail: !factsReady || !designReady ? "请先补齐上方资料，再核对提交条件" :
        synced ? listing.blockers.slice(0, 4).join("；") || "刊登校验已通过，等待运营提交审核" : "等待当前版本的刊登草稿",
      href: listing ? `/listings/${listing.id}` : `${href}&step=4` },
  ];
  const ready = steps.every(s => s.state === "passed");
  return { listing, steps, ready,
    action: ready ? "ready" as const : !factsReady || !designReady || !detail.listingAccess ? "blocked" as const :
      !synced && listing?.status === "in_review" ? "blocked" as const :
      !synced ? "sync_draft" as const : "review" as const,
    message: ready ? "资料已达到提交刊登审核条件，请运营核对后提交" :
      !factsReady ? steps[0]!.detail : !designReady ? steps[1]!.detail :
      listing?.status === "in_review" && !synced ? "刊登正在审核，请先处理原审核再同步新方案" :
      !synced ? "正在准备当前方案的本地刊登草稿" : steps[3]!.detail,
  };
}
