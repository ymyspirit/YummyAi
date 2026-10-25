import type { OrderWorkListItem, OrderWorkSummary } from "@yummyai/contracts/order/workspace";

type CustomField = OrderWorkSummary["fields"][number];

export function orderLineUnits(rows: readonly Pick<OrderWorkListItem, "quantity">[]) {
  return rows.reduce((sum, row) => sum + row.quantity, 0);
}

export function orderProductLabel(row: Pick<OrderWorkListItem, "productType">) {
  return ({ shaped_pillow: "异形抱枕", tire_cover: "轮胎罩", rectangular_print: "平面印刷" } as Record<string, string>)[row.productType ?? ""] ?? "订单商品";
}

export function orderFieldPriority(label: string) {
  if (/^size\b|尺寸|规格/i.test(label)) return 0;
  if (/^printing style$|^pillow shape$|^shape$|形状|裁切/i.test(label)) return 1;
  if (/^style$|印刷面数|单双面|印刷方式/i.test(label)) return 2;
  if (/^colou?r\b|颜色/i.test(label)) return 3;
  if (/upload.*image|上传图片/i.test(label)) return 20;
  return 5;
}

export function orderCustomizationHighlights(fields: readonly CustomField[]) {
  return fields.filter(field => field.value.trim() && orderFieldPriority(field.label) < 5)
    .toSorted((a, b) => orderFieldPriority(a.label) - orderFieldPriority(b.label)).slice(0, 4);
}

const fieldValues: Record<string, string> = {
  "Only Face": "仅头部", "Full Body": "全身", "Whole Body": "全身", "Half Body": "半身",
  "Single-sided Printing": "单面印刷", "Double-sided Printing": "双面印刷",
  single_sided: "单面印刷", double_sided: "双面印刷",
  "Double-Sided Print — Same Photo on Back": "双面同图",
  "Double-Sided Print - Same Photo on Back": "双面同图",
};
export function orderFieldValue(value: string) { return fieldValues[value] ?? value; }
export function orderFieldLabel(label: string, value: string) {
  if (/^size\b/i.test(label)) return "尺寸";
  if (/^shape$/i.test(label)) return "形状";
  if (/^colou?r\b/i.test(label)) return "颜色";
  if (/^style$/i.test(label) && /印刷|双面同图/.test(fieldValues[value] ?? "")) return "印刷面数";
  if (/^(printing style|pillow shape)$/i.test(label) && /^(Only Face|Full Body|Whole Body|Half Body)$/.test(value)) return "裁切范围";
  return label;
}

export function orderMatchingSummary(data: { total: number; groupTotal?: number; matchingQuantity?: number }, state: { loading: boolean; failed: boolean }) {
  if (state.loading) return "正在读取订单与件数…";
  if (state.failed) return "订单与件数暂不可用";
  const orders = data.groupTotal === undefined ? "" : `${data.groupTotal} 单 · `;
  const units = data.matchingQuantity === undefined ? "件数待核对" : `${data.matchingQuantity} 件`;
  return `筛选结果 ${orders}${data.total} 商品行 · ${units}`;
}

const validDate = (value: string | null | undefined): value is string => !!value && Number.isFinite(Date.parse(value));
const earliest = (dates: string[]) => dates.reduce<string | null>((first, date) => !first || Date.parse(date) < Date.parse(first) ? date : first, null);
export function fulfillmentDeadlineRows(rows: readonly OrderWorkListItem[]) {
  const outstanding = rows.filter(row => !row.archivedAt && row.sideState !== "cancelled" && row.orderStatus !== "voided" && row.shippedQuantity < row.quantity);
  const scope = outstanding.length ? outstanding : rows;
  const known = scope.filter(row => validDate(row.platformShipByAt));
  const deadlineRow = known.reduce<OrderWorkListItem | null>((first, row) => !first || Date.parse(row.platformShipByAt!) < Date.parse(first.platformShipByAt!) ? row : first, null)
    ?? scope[0] ?? null;
  return {
    deadlineRow,
    missingAmazonLineCount: outstanding.filter(row => row.platform === "amazon" && !validDate(row.platformShipByAt)).length,
    internalPlanAt: earliest(scope.map(row => row.dueAt).filter(validDate)),
  };
}
