import { describe, expect, it } from "vitest";
import type { OrderWorkListItem } from "@yummyai/contracts/order/workspace";
import {
  fulfillmentDeadlineRows, orderCustomizationHighlights, orderFieldLabel,
  orderFieldValue, orderLineUnits, orderMatchingSummary, orderProductLabel,
} from "./order-operations-summary";

const idle = { loading: false, failed: false };
const row = (patch: Partial<OrderWorkListItem> = {}) => ({
  id: "synthetic-line", platform: "amazon", sideState: null, archivedAt: null,
  orderStatus: "reviewed", quantity: 2, shippedQuantity: 0, dueAt: null,
  platformShipByAt: null, ...patch,
}) as OrderWorkListItem;

describe("daily operations communicate actual rows, quantities and source facts", () => {
  it("distinguishes matched orders, product rows and units without using cohort totals", () => {
    expect(orderLineUnits([{ quantity: 3 }, { quantity: 1 }])).toBe(4);
    expect(orderMatchingSummary({ groupTotal: 2, total: 3, matchingQuantity: 6 }, idle)).toBe("筛选结果 2 单 · 3 商品行 · 6 件");
    expect(orderMatchingSummary({ groupTotal: 1, total: 1, matchingQuantity: 3 }, idle)).toBe("筛选结果 1 单 · 1 商品行 · 3 件");
    expect(orderMatchingSummary({ total: 3, matchingQuantity: 6 }, idle)).toBe("筛选结果 3 商品行 · 6 件");
  });
  it("keeps unavailable or legacy counts distinct from an observed zero", () => {
    expect(orderMatchingSummary({ groupTotal: 2, total: 3 }, idle)).toContain("件数待核对");
    expect(orderMatchingSummary({ groupTotal: 0, total: 0, matchingQuantity: 0 }, idle)).toBe("筛选结果 0 单 · 0 商品行 · 0 件");
    expect(orderMatchingSummary({ total: 3, matchingQuantity: 6 }, { loading: true, failed: false })).toBe("正在读取订单与件数…");
    expect(orderMatchingSummary({ total: 3, matchingQuantity: 6 }, { loading: false, failed: true })).toBe("订单与件数暂不可用");
  });
  it("labels the actual product type and leaves unsupported products generic", () => {
    expect(orderProductLabel(row({ productType: "shaped_pillow" }))).toBe("异形抱枕");
    expect(orderProductLabel(row({ productType: "tire_cover" }))).toBe("轮胎罩");
    expect(orderProductLabel(row({ productType: null }))).toBe("订单商品");
  });
  it("prioritizes buyer fields without inventing values or mutating their order", () => {
    const fields = [
      { label: "Upload Image", value: "buyer-original.png" }, { label: "Color", value: "Unknown source shade" },
      { label: "Style", value: "Double-Sided Print — Same Photo on Back" }, { label: "Printing Style", value: "Whole Body" },
      { label: "Size", value: "16 Inch" }, { label: "Extra message", value: "Keep the original image" },
    ];
    const original = structuredClone(fields);
    expect(orderCustomizationHighlights(fields).map(field => field.label)).toEqual(["Size", "Printing Style", "Style", "Color"]);
    expect(fields).toEqual(original);
    expect(orderCustomizationHighlights([{ label: "Size", value: "  " }])).toEqual([]);
    expect(orderFieldLabel("Printing Style", "Whole Body")).toBe("裁切范围");
    expect(orderFieldValue("Whole Body")).toBe("全身");
    expect(orderFieldLabel("Pillow Shape", "Half Body")).toBe("裁切范围");
    expect(orderFieldValue("Half Body")).toBe("半身");
    expect(orderFieldValue("Unknown source shade")).toBe("Unknown source shade");
    expect(orderFieldValue("16 Inch")).toBe("16 Inch");
  });
});

describe("whole-order deadlines retain independent platform and internal evidence", () => {
  it("uses the earliest outstanding platform deadline rather than a completed sibling", () => {
    const rows = [
      row({ id: "already-shipped", shippedQuantity: 2, platformShipByAt: "2026-10-20T00:00:00Z", dueAt: "2026-10-19T00:00:00Z" }),
      row({ id: "later", platformShipByAt: "2026-10-28T00:00:00Z", dueAt: "2026-10-24T00:00:00Z" }),
      row({ id: "earliest", platformShipByAt: "2026-10-27T00:00:00Z", dueAt: "2026-10-26T00:00:00Z" }),
      row({ id: "unknown", platformShipByAt: null }),
    ];
    const original = structuredClone(rows), result = fulfillmentDeadlineRows(rows);
    expect(result.deadlineRow?.id).toBe("earliest");
    expect(result.missingAmazonLineCount).toBe(1);
    expect(result.internalPlanAt).toBe("2026-10-24T00:00:00Z");
    expect(rows).toEqual(original);
  });
  it("does not replace an unknown platform deadline with the known internal plan", () => {
    const result = fulfillmentDeadlineRows([row({ dueAt: "2026-10-26T00:00:00Z" })]);
    expect(result.deadlineRow?.platformShipByAt).toBeNull();
    expect(result.missingAmazonLineCount).toBe(1);
    expect(result.internalPlanAt).toBe("2026-10-26T00:00:00Z");
  });
  it("excludes cancelled, archived and voided siblings from actionable missing-date warnings", () => {
    const result = fulfillmentDeadlineRows([
      row({ sideState: "cancelled" }), row({ archivedAt: "2026-10-25T00:00:00Z" }), row({ orderStatus: "voided" }),
      row({ platform: "etsy" }), row({ id: "active", shippedQuantity: 1, platformShipByAt: "2026-10-27T00:00:00Z" }),
    ]);
    expect(result.deadlineRow?.id).toBe("active");
    expect(result.missingAmazonLineCount).toBe(0);
  });
  it("keeps an empty scope empty and historical deadlines readable without new missing warnings", () => {
    expect(fulfillmentDeadlineRows([])).toEqual({ deadlineRow: null, missingAmazonLineCount: 0, internalPlanAt: null });
    expect(fulfillmentDeadlineRows([row({ shippedQuantity: 2, platformShipByAt: "2026-10-20T00:00:00Z" })])).toMatchObject({ missingAmazonLineCount: 0 });
  });
});
