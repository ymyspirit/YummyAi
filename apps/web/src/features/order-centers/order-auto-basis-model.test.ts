import { describe, expect, it } from "vitest";
import type { OrderWorkDetail, OrderWorkDraft, OrderWorkListItem } from "@yummyai/contracts/order/workspace";
import { orderAutomaticBasisView, orderCatalogSpus, orderPlatformShippingView } from "./order-auto-basis-model";

type Catalog = NonNullable<OrderWorkDetail["catalog"]>;
const draft: OrderWorkDraft = { printProfileVersionId: null, specificationVersionId: "synthetic-spec-16", fields: [], images: [],
  instructions: "", customerApprovalRequired: false, dueAt: null };
const specification = (id: string, spuId = "synthetic-shaped-pillow") => ({ id, spuId, spuCode: "CUSTOM-SHAPED-PILLOW", spuName: "异形抱枕",
  name: id, version: 1, processProfileVersionId: null, processName: "", dimensions: "16 inches", productionReady: false,
  issues: ["规格生产事实尚未完成核对"] });
const catalog = () => ({ status: "unmatched", packageId: null, recipes: [], artworks: [], specifications: [specification("synthetic-spec-16")],
  automatic: { status: "partial", applied: true, sourceVersionId: "synthetic-source", sizeInches: 16,
    spuId: "synthetic-shaped-pillow", specificationVersionId: "synthetic-spec-16", processProfileVersionId: null,
    reasons: ["Synthetic explicit 16 inch source"], issues: ["通用工艺待核对"] } }) as Catalog;
const detail = (value = catalog()) => ({ draft, catalog: value, profile: null }) as OrderWorkDetail;
const row = (patch: Partial<OrderWorkListItem> = {}) => ({ platform: "amazon", archivedAt: null, sideState: null, orderStatus: "awaiting_review",
  quantity: 2, shippedQuantity: 0, platformShipByAt: null, platformDeadlineVerifiedAt: null, dueAt: null, ...patch }) as OrderWorkListItem;
const time = (patch: Partial<NonNullable<OrderWorkDetail["shippingTime"]>["platform"]> = {}) => ({
  computedAt: "2026-10-26T00:00:00.000Z", platform: { at: null, source: "missing", sourceVersionId: null, verifiedAt: null, ...patch },
  internal: { at: "2026-10-20T00:00:00.000Z", source: "operator", confidence: "explicit", evidenceReference: null },
  active: true, nextAttentionAt: null, countdownBasis: null, remainingSeconds: null, platformOverdue: false, internalOverdue: true, missingReasons: [],
}) as NonNullable<OrderWorkDetail["shippingTime"]>;

describe("order matching presentation preserves the operator's actual choice", () => {
  it("shows visible SPUs with no specification and deduplicates historical specification parents", () => {
    const value = catalog();
    value.spus = [{ id: "synthetic-shaped-pillow", code: "CURRENT", name: "Current product name" },
      { id: "synthetic-unconfigured", code: "NO-SPEC", name: "No specification yet" }];
    value.specifications.push(specification("historical-16", "synthetic-historical-spu"));
    expect(orderCatalogSpus(value)).toEqual([
      { id: "synthetic-shaped-pillow", code: "CURRENT", name: "Current product name" },
      { id: "synthetic-unconfigured", code: "NO-SPEC", name: "No specification yet" },
      { id: "synthetic-historical-spu", code: "CUSTOM-SHAPED-PILLOW", name: "异形抱枕" },
    ]);
  });

  it("keeps an automatic partial match explicit about missing process and production facts", () => {
    const actual = orderAutomaticBasisView(detail(), draft);
    expect(actual).toMatchObject({ changed: false, tone: "warning", hasSelection: true, process: "通用工艺底稿待审核绑定" });
    expect(actual.specification?.id).toBe(draft.specificationVersionId);
    expect(actual.issues).toEqual(["通用工艺待核对", "规格生产事实尚未完成核对"]);
  });

  it("presents an exact server match and a preserved basis with their actual source states", () => {
    const value = catalog(), selected = { ...draft, printProfileVersionId: "synthetic-process-16" };
    value.specifications[0] = { ...value.specifications[0]!, processProfileVersionId: selected.printProfileVersionId,
      processName: "Synthetic common 16 inch process", productionReady: true, issues: [] };
    value.automatic = { ...value.automatic!, status: "matched", processProfileVersionId: selected.printProfileVersionId, issues: [] };
    const source = { ...detail(value), draft: selected };
    expect(orderAutomaticBasisView(source, selected)).toMatchObject({ changed: false, tone: "normal", title: "已按定制信息带入规格与工艺",
      specification: { id: selected.specificationVersionId }, process: "Synthetic common 16 inch process" });
    value.automatic = { ...value.automatic, status: "preserved" };
    expect(orderAutomaticBasisView(source, selected).title).toBe("沿用本单固定制作版本");
  });

  it.each([
    [false, "规格与工艺已带入 生产资料待核对"],
    [undefined, "规格与工艺已带入 制作依据待补齐"],
  ] as const)("keeps partial matches with an existing process distinct from a missing process: %s", (productionReady, title) => {
    const value = catalog(), selected = { ...draft, printProfileVersionId: "synthetic-process-16" };
    value.specifications[0] = { ...value.specifications[0]!, processProfileVersionId: selected.printProfileVersionId,
      processName: "Synthetic common 16 inch process", productionReady, issues: [] };
    value.automatic = { ...value.automatic!, processProfileVersionId: selected.printProfileVersionId, issues: ["Synthetic outstanding check"] };
    const source = { ...detail(value), draft: selected };
    expect(orderAutomaticBasisView(source, selected)).toMatchObject({ title, tone: "warning", changed: false, process: "Synthetic common 16 inch process" });
  });

  it("does not reapply the server suggestion after a local manual choice or clear", () => {
    const value = catalog();
    value.specifications.push({ ...specification("synthetic-manual-10"), issues: ["Local choice requires confirmation"] });
    const source = detail(value), original = structuredClone(source);
    const local = { ...draft, specificationVersionId: "synthetic-manual-10" };
    const actual = orderAutomaticBasisView(source, local);
    expect(actual).toMatchObject({ changed: true, specification: { id: "synthetic-manual-10" }, title: "本单制作依据已调整 保存后生效" });
    expect(actual.issues).toEqual(["Local choice requires confirmation"]);
    const cleared = orderAutomaticBasisView(source, { ...draft, specificationVersionId: null });
    expect(cleared).toMatchObject({ changed: true, hasSelection: false });
    expect(cleared.specification).toBeUndefined();
    expect(source).toEqual(original);
    expect(local.specificationVersionId).toBe("synthetic-manual-10");
  });
});

describe("shipping presentation uses only a real platform promise", () => {
  const now = Date.parse("2026-10-26T00:00:00.000Z"), deadline = "2026-10-26T02:00:00.000Z";

  it("does not create a platform deadline from an internal date or the order's purchase date", () => {
    const actual = orderPlatformShippingView(row({ dueAt: "2026-10-20T00:00:00.000Z", placedAt: "2026-10-24T00:00:00.000Z" }), undefined, now);
    expect(actual).toMatchObject({ at: null, sourceLabel: "未取得平台截止", text: "平台最晚发货时间待补齐", tone: "warning" });
  });

  it("honors missing source and a recorded null instead of reviving an older row date", () => {
    expect(orderPlatformShippingView(row({ platformShipByAt: deadline, platformDeadlineSource: "missing" }), undefined, now).at).toBeNull();
    const cleared = time({ source: "verified_record", verifiedAt: "2026-10-26T00:00:00.000Z" });
    expect(orderPlatformShippingView(row({ platformShipByAt: deadline, platformDeadlineSource: "marketplace_api" }), cleared, now))
      .toMatchObject({ at: null, sourceLabel: "人工核对记录", text: "平台最晚发货时间待补齐" });
  });

  it.each([
    ["marketplace_api", "平台 API 同步"], ["report_import", "原始未发货报告"], ["verified_record", "人工核对记录"],
  ] as const)("shows the independent %s source and exact platform countdown", (source, sourceLabel) => {
    expect(orderPlatformShippingView(row({ platformShipByAt: deadline, platformDeadlineSource: source, dueAt: "2026-10-20T00:00:00.000Z" }), undefined, now))
      .toMatchObject({ at: deadline, active: true, sourceLabel, text: "距平台截止 2 小时", tone: "warning" });
  });

  it("keeps completed and cancelled orders historical rather than overdue active work", () => {
    const closed: Partial<OrderWorkListItem>[] = [{ shippedQuantity: 2 }, { sideState: "cancelled" }, { orderStatus: "voided" }, { archivedAt: "2026-10-25T00:00:00.000Z" }];
    for (const patch of closed)
      expect(orderPlatformShippingView(row({ ...patch, platformShipByAt: "2026-10-20T00:00:00.000Z", platformDeadlineSource: "marketplace_api" }), undefined, now))
        .toMatchObject({ active: false, text: "平台截止记录", tone: "normal" });
  });
});
