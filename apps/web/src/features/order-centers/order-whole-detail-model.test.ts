import { describe, expect, it } from "vitest";
import type { OrderWorkListItem } from "@yummyai/contracts/order/workspace";
import type { WholeOrderDetailView } from "@yummyai/contracts/order/whole-detail";
import { orderReviewQueue, wholeOrderNextStep } from "./order-whole-detail-model";
import { FactoryErpVoidSummarySchema } from "@yummyai/contracts/order/factory-erp-void-review";

const row = (id: string, orderId = "order-a", patch: Partial<OrderWorkListItem> = {}) => ({
  id, orderId, externalLineId: id, quantity: 1, preparation: "pushed", artwork: "approved", proof: "not_required", production: "not_released",
  held: false, sourceChanged: false, afterSalesCount: 0, shippedQuantity: 0, readyQuantity: 0, dueAt: null, sideState: null, platform: "etsy", orderStatus: "reviewed", ...patch,
}) as OrderWorkListItem;
function fixture(): WholeOrderDetailView {
  const lines = [row("pillow-a"), row("pillow-b"), row("pillow-c")];
  return {
    orderId: "order-a", items: lines.map(line => ({ line, summary: { data: null, error: null }, artwork: { data: { versionId: "version", versionNumber: 2, approved: true, approvedVersionNumber: 2, preview: null, productionFile: { name: "pillow.jpg", path: "/private/pillow.jpg" }, productionPending: false }, error: null } })),
    fulfillment: { data: { orderId: "order-a", orderNumber: "synthetic-order", orderStatus: "reviewed", quantity: 3, shipmentIds: [], platformConfirmationPending: false, shipmentSources: [],
      factoryDiagnostics: [], factories: [{ factoryId: "factory", supplierId: "supplier", supplierName: "Synthetic factory", factoryVersionId: "factory-version", factoryName: "Synthetic site", items: lines.map(line => ({ lineId: line.id, capabilityVersionId: "capability", capabilityName: "Synthetic pillow" })) }],
      items: lines.map(line => ({ lineId: line.id, quantity: 1, expectedRevision: 1, expectedProjectionVersion: 1, externalLineId: line.id, title: "Synthetic pillow", sku: null, specification: null,
        readyQuantity: 0, shippedQuantity: 0, renderId: "render", fileName: "pillow.jpg", editorVersionNumber: 2, productionBlockers: [], shipmentBlockers: [], operationBlockers: [], production: null })) }, error: null },
    production: { data: [], error: null }, shipments: { data: [], error: null }, cases: { data: [], error: null }, shipos: { data: [], error: null },
  };
}
describe("whole order navigation and next action", () => {
  it("follows factory scheduling and external shipment separately from internal QC and dispatch", () => {
    const view = fixture();
    view.fulfillment.data!.items.forEach((item, index) => { item.production = { id: `submitted-${index}`, status: "submitted", projectionVersion: 2, wholeOrder: true, qualityResult: null }; });
    view.production.data = view.fulfillment.data!.items.map(item => ({ productionOrder: { id: item.production!.id, supplierId: "supplier", factoryId: "factory", status: "submitted", projectionVersion: 2, currentVersionNumber: 1, expectedCompletionAt: "2026-10-21T10:00:00Z" },
      deliveryReceipt: { packageId: "packet", itemId: item.lineId, status: "submitted", factoryErp: null }, factoryPin: null, versions: [], milestones: [], inspections: [], defects: [] }));
    expect(wholeOrderNextStep(view)).toMatchObject({ title: "跟进工厂排产与发货", section: "delivery" });
    view.production.data.forEach(record => { record.deliveryReceipt!.factoryErp = { bindingId: "binding", externalId: "synthetic", status: "shipped", exception: null, observationId: "observation", importId: "import", rawStatus: "已出库", updatedAtLocal: "2026-10-21 10:00:00", recordedAt: "2026-10-21T11:00:00Z", trackingReference: "synthetic", carrier: "synthetic", carrierService: "synthetic", shippedQuantity: null }; });
    expect(wholeOrderNextStep(view)).toMatchObject({ title: "核对工厂发货凭据", section: "delivery" });
    expect(view.fulfillment.data!.items.map(item => item.readyQuantity)).toEqual([0, 0, 0]);
    view.production.data[0]!.deliveryReceipt!.factoryErp!.exception = "voided_requires_review";
    expect(wholeOrderNextStep(view)).toMatchObject({ title: "核对工厂作废异常", section: "delivery" });
    const id = (n: number) => `01a15e10-0000-7000-8000-${String(n).padStart(12, "0")}`, hash = "a".repeat(64), at = "2026-10-21T09:00:00.000Z";
    const observation = { id: id(1), sequence: 7, importId: id(2), rowNumber: 2, rowChecksum: hash, fileChecksum: hash, previewChecksum: hash, recordedAt: at };
    const latestReview = { id: id(3), bindingId: id(4), factoryId: id(5), observation, source: { importId: id(2), rowNumber: 2, fileChecksum: hash, previewChecksum: hash },
      originalBindingRevision: 1, originalItemsChecksum: hash, originalObservationSequence: 7, reviewRevision: 1, previousReviewId: null,
      outcome: "confirmed_voided", reasonCode: "factory_contact", provenance: "operator_attested", requestChecksum: hash, createdAt: at };
    const summary = FactoryErpVoidSummarySchema.parse({ total: 1, pending: 0, requiresOrderHandling: 1, nextPending: null,
      latest: { ...observation, sourceReadable: true, latestReview, pending: false, requiresOrderHandling: true } });
    const imported = view.production.data[0]!.deliveryReceipt!.factoryErp!;
    imported.voidSummary = summary; imported.exception = null;
    expect(wholeOrderNextStep(view)).toMatchObject({ title: "处理工厂作废后续", section: "delivery" });
    imported.voidSummary = FactoryErpVoidSummarySchema.parse({ ...summary, requiresOrderHandling: 0,
      latest: { ...summary.latest!, requiresOrderHandling: false, latestReview: { ...latestReview, outcome: "confirmed_active" } } });
    expect(wholeOrderNextStep(view)).toMatchObject({ title: "核对工厂发货凭据", section: "delivery" });
    expect(view.fulfillment.data!.items.map(item => item.readyQuantity)).toEqual([0, 0, 0]);
    const pending = { ...observation, id: id(6), sequence: 8, latestReview: null, sourceReadable: true, pending: true, requiresOrderHandling: false };
    imported.voidSummary = FactoryErpVoidSummarySchema.parse({ total: 2, pending: 1, requiresOrderHandling: 0, latest: pending, nextPending: pending });
    expect(wholeOrderNextStep(view)).toMatchObject({ title: "核对工厂作废异常", section: "delivery" });
    view.production.data.forEach(record => { Object.assign(record.deliveryReceipt!.factoryErp!, { bindingReleased: true, bindingReleaseId: "release", historicalStatus: "shipped" }); });
    expect(wholeOrderNextStep(view)).toMatchObject({ title: "跟进工厂排产与发货", section: "delivery" });
  });
  it("navigates once per order while preserving the selected pillow as the queue anchor", () => {
    const rows = [row("a"), row("b"), row("c"), row("d", "order-b")];
    expect(orderReviewQueue(rows, "b")).toEqual(["b", "d"]);
  });
  it("directs the operator to an unfinished sibling instead of sending the reviewed item to production", () => {
    const view = fixture(); view.items[2]!.line.artwork = "in_review";
    expect(wholeOrderNextStep(view)).toMatchObject({ lineId: "pillow-c", module: "artwork", section: "item", action: "审核生产图" });
  });
  it("chooses a held sibling first and preserves a concrete action", () => {
    const view = fixture(); view.items[1]!.line.held = true;
    expect(wholeOrderNextStep(view)).toMatchObject({ lineId: "pillow-b", module: "orders", action: "处理暂停" });
  });
  it("distinguishes pending formal files from a factory ready order", () => {
    const view = fixture(); view.items[1]!.artwork.data!.productionFile = null; view.items[1]!.artwork.data!.productionPending = true;
    expect(wholeOrderNextStep(view)).toMatchObject({ title: "等待正式生产文件", lineId: "pillow-b", module: "artwork" });
    view.items[1]!.artwork.data!.productionFile = { name: "pillow.jpg", path: "/private/second.jpg" };
    expect(wholeOrderNextStep(view)).toMatchObject({ title: "安排整单生产", module: "production" });
  });
  it("does not treat a partial quality result or an unreadable shipment as ready to dispatch", () => {
    const view = fixture(), plan = view.fulfillment.data!;
    plan.items.forEach((item, index) => { item.production = { id: `production-${index}`, status: "completed", projectionVersion: 5, wholeOrder: true, qualityResult: index < 2 ? "passed" : null }; item.readyQuantity = index < 2 ? 1 : 0; });
    expect(wholeOrderNextStep(view)).toMatchObject({ title: "检查本单全部抱枕", module: "production" });
    plan.items[2]!.readyQuantity = 1; plan.shipmentIds = ["shipment"]; view.shipments = { data: null, error: "Shipment unavailable" };
    expect(wholeOrderNextStep(view)).toMatchObject({ section: "refresh", module: "shipments" });
  });
  it("keeps read failures explicit and does not infer handover from a cached label", () => {
    const view = fixture(); view.fulfillment = { data: null, error: "Conditions unavailable" };
    expect(wholeOrderNextStep(view)).toMatchObject({ section: "refresh", description: "Conditions unavailable" });
    view.fulfillment = fixture().fulfillment; view.fulfillment.data!.orderStatus = "shipped"; view.fulfillment.data!.platformConfirmationPending = true;
    expect(wholeOrderNextStep(view)).toMatchObject({ action: "登记平台确认", module: "shipments" });
  });
  it("uses the current whole-order delivery files even when older cancelled production is retained", () => {
    const view = fixture();
    const record = (id: string, delivered: boolean, status = "planned") => ({
      productionOrder: { id, supplierId: "supplier", factoryId: "factory", status, projectionVersion: 1, currentVersionNumber: 1, expectedCompletionAt: "2026-10-07T10:00:00Z" },
      deliveryReceipt: delivered ? { packageId: "packet", itemId: `file-${id}`, status: "pending" as const } : null,
      factoryPin: null, versions: [], milestones: [], inspections: [], defects: [],
    });
    view.fulfillment.data!.items.forEach((item, index) => { item.production = { id: `current-${index}`, status: "planned", projectionVersion: 1, wholeOrder: true, qualityResult: null }; });
    view.production.data = [record("old-cancelled", false, "cancelled"), ...[0, 1, 2].map(index => record(`current-${index}`, true))];
    expect(wholeOrderNextStep(view)).toMatchObject({ target: "production-progress", action: "登记整单发送工厂" });
    view.production.data[3]!.deliveryReceipt = null;
    expect(wholeOrderNextStep(view)).toMatchObject({ section: "delivery", action: "准备整单文件" });
  });
});
