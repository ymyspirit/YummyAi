import type { OrderWorkDetail, OrderWorkDraft, OrderWorkListItem } from "@yummyai/contracts/order/workspace";

type Catalog = NonNullable<OrderWorkDetail["catalog"]>;
const basisFields = ["salesRecipeVersionId", "salesPackageId", "artworkVersionId", "specificationVersionId", "printProfileVersionId"] as const;

export function orderCatalogSpus(catalog: Catalog) {
  const values = new Map((catalog.spus ?? []).map(value => [value.id, value]));
  for (const value of catalog.specifications) if (!values.has(value.spuId)) {
    values.set(value.spuId, { id: value.spuId, code: value.spuCode, name: value.spuName });
  }
  return [...values.values()];
}

/** Presentation only: the server supplies the draft and immutable matches. */
export function orderAutomaticBasisView(detail: OrderWorkDetail, draft: OrderWorkDraft) {
  const catalog = detail.catalog, automatic = catalog?.automatic;
  const changed = basisFields.some(key => (draft[key] ?? null) !== (detail.draft[key] ?? null));
  const recipe = catalog?.recipes.find(value => value.id === draft.salesRecipeVersionId);
  const specification = catalog?.specifications.find(value => value.id === (draft.specificationVersionId ?? recipe?.specificationVersionId));
  const spu = catalog && orderCatalogSpus(catalog).find(value => value.id === specification?.spuId);
  const profile = detail.profile?.versionId === draft.printProfileVersionId ? detail.profile : null;
  const process = draft.printProfileVersionId
    ? profile ? `${profile.name} · V${profile.versionNumber}` : specification?.processProfileVersionId === draft.printProfileVersionId
      ? specification.processName || "已绑定本单工艺版本" : "已选本单工艺版本"
    : "通用工艺底稿待审核绑定";
  let title = "本单制作依据", tone: "normal" | "warning" = "normal";
  if (changed) title = "本单制作依据已调整 保存后生效";
  else if (automatic?.status === "preserved") title = "沿用本单固定制作版本";
  else if (automatic?.status === "matched") {
    title = automatic.applied ? "已按定制信息带入规格与工艺" : "已找到匹配规格 请核对当前制作依据";
  } else if (automatic?.status === "partial") {
    title = automatic.applied && specification
      ? draft.printProfileVersionId
        ? specification.productionReady === false ? "规格与工艺已带入 生产资料待核对" : "规格与工艺已带入 制作依据待补齐"
        : "规格已带入 通用工艺底稿待补齐"
      : "制作依据尚未完整匹配"; tone = "warning";
  } else if (automatic?.status === "ambiguous") { title = "存在多个匹配 请核对制作依据"; tone = "warning"; }
  else if (automatic?.status === "conflict") { title = "定制信息与制作依据存在冲突"; tone = "warning"; }
  else if (automatic?.status === "missing") { title = "尚未找到唯一可用规格"; tone = "warning"; }
  const issues = [...new Set([...(changed ? [] : automatic?.issues ?? []), ...(specification?.issues ?? [])])];
  if (specification && !draft.printProfileVersionId && !issues.length) issues.push("本规格尚未绑定可用的已审核通用工艺底稿");
  if (specification?.productionReady === false && !issues.length) issues.push("本规格的生产资料仍需核对");
  if (issues.length) tone = "warning";
  return { title, tone, changed, automatic, recipe, specification, spu, process, issues,
    hasSelection: !!(draft.salesRecipeVersionId || draft.specificationVersionId || draft.printProfileVersionId) };
}

export function orderPlatformShippingView(row: OrderWorkListItem, shippingTime?: OrderWorkDetail["shippingTime"], now = Date.now()) {
  const source = shippingTime?.platform.source ?? row.platformDeadlineSource;
  // A recorded unknown date must not resurrect an older API observation.
  const at = source === "missing" ? null : shippingTime ? shippingTime.platform.at : row.platformShipByAt ?? null;
  const active = shippingTime?.active ?? (!row.archivedAt && row.sideState !== "cancelled" && row.orderStatus !== "voided" && row.shippedQuantity < row.quantity);
  const sourceLabel = source === "marketplace_api" ? "平台 API 同步" : source === "report_import" ? "原始未发货报告" : source === "verified_record" || source === undefined && row.platformDeadlineVerifiedAt
    ? "人工核对记录" : at ? "平台依据待确认" : "未取得平台截止";
  if (!at) return { at, active, sourceLabel, text: active ? "平台最晚发货时间待补齐" : "无平台截止记录", tone: active && row.platform === "amazon" ? "warning" as const : "normal" as const };
  if (!active) return { at, active, sourceLabel, text: "平台截止记录", tone: "normal" as const };
  const remaining = Date.parse(at) - now, minutes = Math.ceil(Math.abs(remaining) / 60_000);
  const totalHours = Math.ceil(minutes / 60), days = Math.floor(totalHours / 24), hours = totalHours % 24;
  const duration = minutes < 60 ? `${Math.max(1, minutes)} 分钟` : days ? `${days} 天${hours ? ` ${hours} 小时` : ""}` : `${hours} 小时`;
  return { at, active, sourceLabel, text: remaining === 0 ? "已到平台截止" : remaining < 0 ? `已超平台截止 ${duration}` : `距平台截止 ${duration}`,
    tone: remaining < 0 ? "danger" as const : remaining <= 86_400_000 ? "warning" as const : "normal" as const };
}
