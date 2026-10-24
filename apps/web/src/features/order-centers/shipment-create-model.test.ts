import { describe, expect, test } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { ShipmentCreateWorkspaceSchema, type ShipmentProductionAllocationInput } from "@yummyai/contracts/order/shipment";
import { buildShipmentCreateContent, createShipmentCreateDraft, shipmentCreateBasisKey, type ShipmentCreateDraft } from "./shipment-create-model";

const id = (value: number) => "019e8350-0000-7000-8000-" + String(value).padStart(12, "0");
function fixture() {
  const workspace = ShipmentCreateWorkspaceSchema.parse({ orderId: id(1), orderNumber: "PACKAGE-FORM-TEST", orderSequence: 6,
    contextAuthority: erpSessionAuthority({ tenantId: id(100), userId: id(101), permissions: [], dataScope: "tenant" }),
    lines: [{ lineId: id(2), title: "商品 A", quantity: 5 }, { lineId: id(3), title: "商品 B", quantity: 1 }], canCreate: true, blockers: [],
    sources: [2, 3].map((line, index) => ({ orderLineId: id(line), productionOrderId: id(10 + index), productionVersionId: id(20 + index),
      versionNumber: 2, projectionVersion: 4, source: "initial", status: "completed", quantity: line === 2 ? 5 : 1,
      qualityInspectionId: id(30 + index), inspectedAt: "2026-10-23T10:00:00.000Z", qualityGroupId: id(40 + index), groupLabel: "合格组",
      allocatedQuantity: 0, availableQuantity: line === 2 ? 3 : 1, blockers: [] })),
  });
  const draft = createShipmentCreateDraft({ shipDate: "2026-10-24T10:00:00.000Z", shipFromCountryCode: "CN", packages: [
    { packageReferenceId: "PKG-A", trackingNumber: "TRACK-A", carrierCode: "UPS", carrierName: "UPS", carrierService: "STANDARD",
      externalLabelId: "LABEL-A", labelCostMinor: 0, labelCurrency: "USD", weightGrams: 500, dimensionsMm: { length: 200, width: 100, height: 40 },
      lines: [{ orderLineId: id(2), quantity: 1 }, { orderLineId: id(3), quantity: 1 }] },
    { packageReferenceId: "PKG-B", trackingNumber: "TRACK-B", carrierCode: "UPS", carrierName: "UPS", carrierService: "STANDARD", lines: [{ orderLineId: id(2), quantity: 1 }] },
  ] });
  const allocations = (_key: string, lineId: string, quantity: number): ShipmentProductionAllocationInput[] => {
    const source = workspace.sources.find(row => row.orderLineId === lineId)!;
    return [{ productionOrderId: source.productionOrderId, productionVersionId: source.productionVersionId,
      qualityInspectionId: source.qualityInspectionId!, qualityGroupId: source.qualityGroupId, expectedProductionProjectionVersion: source.projectionVersion, quantity }];
  };
  return { workspace, draft, allocations };
}
function lineQuantity(draft: ShipmentCreateDraft, first: string, second: string) {
  draft.packages[0]!.lines[0]!.quantity = first; draft.packages[1]!.lines[0]!.quantity = second;
}
describe("original partial and multi-package shipment content", () => {
  test("keeps two-package partial quantities, exact production pins and optional shipping facts", () => {
    const { workspace, draft, allocations } = fixture(), content = buildShipmentCreateContent(draft, workspace, allocations);
    expect(content.packages.map(pkg => pkg.lines.map(line => [line.orderLineId, line.quantity]))).toEqual([[[id(2), 1], [id(3), 1]], [[id(2), 1]]]);
    expect(content.packages[0]).toMatchObject({ labelCostMinor: 0, labelCurrency: "USD", externalLabelId: "LABEL-A", weightGrams: 500,
      dimensionsMm: { length: 200, width: 100, height: 40 } });
    expect(content.packages[1]!.lines[0]!.productionAllocations?.[0]).toMatchObject({ productionVersionId: id(20), qualityInspectionId: id(30), qualityGroupId: id(40) });
    expect("idempotencyKey" in content).toBe(false);
  });
  test("rejects cross-package order overpacking and repeated use beyond the actual available source", () => {
    const { workspace, draft, allocations } = fixture();
    lineQuantity(draft, "3", "3"); expect(() => buildShipmentCreateContent(draft, workspace, allocations)).toThrow("超过原订单商品数量");
    lineQuantity(draft, "2", "2"); expect(() => buildShipmentCreateContent(draft, workspace, allocations)).toThrow("超过当前可发数量");
  });
  test("never substitutes a new version, quality record, group or projection and rejects blocked sources", () => {
    const { workspace, draft, allocations } = fixture();
    for (const patch of [{ productionVersionId: id(80) }, { qualityInspectionId: id(81) }, { qualityGroupId: id(82) }, { expectedProductionProjectionVersion: 5 }])
      expect(() => buildShipmentCreateContent(draft, workspace, (key, line, quantity) => allocations(key, line, quantity).map(value => ({ ...value, ...patch })))).toThrow("无法核对");
    workspace.sources[0]!.blockers = ["实物待核对"];
    expect(() => buildShipmentCreateContent(draft, workspace, allocations)).toThrow("无法核对");
  });
  test("partial model fields do not choose a line and a suggested label asset cannot be silently dropped", () => {
    const partial = createShipmentCreateDraft({ packages: [{ lines: [{ quantity: 1 }] }] });
    expect(partial.packages[0]!.lines[0]).toMatchObject({ orderLineId: "", quantity: "1" });
    const { workspace, draft, allocations } = fixture(); draft.packages[0]!.labelAssetId = id(90);
    expect(() => buildShipmentCreateContent(draft, workspace, allocations)).toThrow("面单资产");
    partial.packages[0]!.lines[0]!.orderLineId = id(91);
    expect(() => buildShipmentCreateContent(partial, workspace, allocations)).toThrow("本单真实商品");
  });
  test("reuses the original content rules and distinguishes reordered facts from changed availability", () => {
    const { workspace, draft, allocations } = fixture(), initial = shipmentCreateBasisKey(workspace);
    expect(shipmentCreateBasisKey({ ...workspace, lines: [...workspace.lines].reverse(), sources: [...workspace.sources].reverse() })).toBe(initial);
    expect(shipmentCreateBasisKey({ ...workspace, sources: workspace.sources.map(source => ({ ...source, availableQuantity: 0 })) })).not.toBe(initial);
    draft.packages[1]!.packageReferenceId = draft.packages[0]!.packageReferenceId;
    expect(() => buildShipmentCreateContent(draft, workspace, allocations)).toThrow("参考号不可重复");
    draft.packages[1]!.packageReferenceId = "PKG-B"; draft.packages[0]!.labelCurrency = "";
    expect(() => buildShipmentCreateContent(draft, workspace, allocations)).toThrow("费用币种须配对");
    draft.packages[0]!.labelCurrency = "USD"; draft.estimatedDeliveryAt = "2026-10-20T10:00";
    expect(() => buildShipmentCreateContent(draft, workspace, allocations)).toThrow("交付时间不能早于发货");
  });
});
