import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import type { AgentFulfillmentSuggestion } from "@yummyai/contracts/ai/agent-fulfillment-proposal";
import {
  ShipmentCreateContentSchema, shipmentProductionSourceKey,
  type ShipmentCreateWorkspace, type ShipmentProductionAllocationInput,
} from "@yummyai/contracts/order/shipment";

export type ShipmentCreateSuggestion = Extract<AgentFulfillmentSuggestion["original"], { kind: "shipment_create" }>["input"];
export type ShipmentCreateLineDraft = { key: string; orderLineId: string; quantity: string; productionAllocations?: unknown };
export type ShipmentCreatePackageDraft = {
  key: string; packageReferenceId: string; trackingNumber: string; carrierCode: string; carrierName: string; carrierService: string;
  labelAssetId: string | null; externalLabelId: string; labelCostMinor: string; labelCurrency: string; weightGrams: string;
  length: string; width: string; height: string; lines: ShipmentCreateLineDraft[];
};
export type ShipmentCreateDraft = {
  shipDate: string; promisedDeliveryAt: string; estimatedDeliveryAt: string; shipFromCountryCode: string;
  packages: ShipmentCreatePackageDraft[];
};
export class ShipmentCreateValidationError extends Error {}
const text = (value: string | null | undefined) => value ?? "";
const numberText = (value: number | null | undefined) => value === undefined || value === null ? "" : String(value);
function localTime(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
}
export function newShipmentCreatePackage(key: string): ShipmentCreatePackageDraft {
  return { key, packageReferenceId: "", trackingNumber: "", carrierCode: "", carrierName: "", carrierService: "", labelAssetId: null,
    externalLabelId: "", labelCostMinor: "", labelCurrency: "", weightGrams: "", length: "", width: "", height: "",
    lines: [{ key: key + "-line-1", orderLineId: "", quantity: "" }] };
}
/** Model fields are suggestions. No physical or operator confirmation is retained here. */
export function createShipmentCreateDraft(suggestion?: ShipmentCreateSuggestion | null): ShipmentCreateDraft {
  return {
    shipDate: localTime(suggestion?.shipDate), promisedDeliveryAt: localTime(suggestion?.promisedDeliveryAt),
    estimatedDeliveryAt: localTime(suggestion?.estimatedDeliveryAt), shipFromCountryCode: text(suggestion?.shipFromCountryCode),
    packages: suggestion?.packages?.length ? suggestion.packages.map((pkg, index) => {
      const key = "package-" + (index + 1);
      return { ...newShipmentCreatePackage(key), packageReferenceId: text(pkg.packageReferenceId), trackingNumber: text(pkg.trackingNumber),
        carrierCode: text(pkg.carrierCode), carrierName: text(pkg.carrierName), carrierService: text(pkg.carrierService),
        labelAssetId: pkg.labelAssetId ?? null, externalLabelId: text(pkg.externalLabelId), labelCostMinor: numberText(pkg.labelCostMinor),
        labelCurrency: text(pkg.labelCurrency), weightGrams: numberText(pkg.weightGrams), length: numberText(pkg.dimensionsMm?.length),
        width: numberText(pkg.dimensionsMm?.width), height: numberText(pkg.dimensionsMm?.height),
        lines: pkg.lines?.length ? pkg.lines.map((line, row) => ({ key: key + "-line-" + (row + 1),
          orderLineId: text(line.orderLineId), quantity: numberText(line.quantity), productionAllocations: line.productionAllocations }))
          : [{ key: key + "-line-1", orderLineId: "", quantity: "" }],
      };
    }) : [newShipmentCreatePackage("package-1")],
  };
}
export const shipmentCreatePackagePrefix = (key: string) => "shipment-create-" + key + ":";
export const shipmentCreateSelectionKey = (pkg: ShipmentCreatePackageDraft) => canonicalJson(pkg.lines.map(line => [line.key, line.orderLineId, line.quantity]));
/** Reordering an otherwise identical response does not replace an operator's draft. */
export function shipmentCreateBasisKey(value: ShipmentCreateWorkspace) {
  return canonicalJson({ orderId: value.orderId, orderSequence: value.orderSequence,
    lines: [...value.lines].sort((a, b) => a.lineId.localeCompare(b.lineId)),
    sources: [...value.sources].sort((a, b) => (a.orderLineId + ":" + shipmentProductionSourceKey(a)).localeCompare(b.orderLineId + ":" + shipmentProductionSourceKey(b))),
  });
}
export function shipmentCreatePackingLines(pkg: ShipmentCreatePackageDraft, workspace: ShipmentCreateWorkspace) {
  return pkg.lines.flatMap(line => {
    const actual = workspace.lines.find(row => row.lineId === line.orderLineId), quantity = Number(line.quantity);
    return actual && Number.isInteger(quantity) && quantity > 0 ? [{ lineId: actual.lineId, title: actual.title, quantity }] : [];
  });
}
export function shipmentCreateDraftIssues(draft: ShipmentCreateDraft, workspace: ShipmentCreateWorkspace) {
  const issues: string[] = [], totals = new Map<string, number>();
  if (draft.packages.some(pkg => pkg.labelAssetId !== null)) issues.push("建议包含面单资产 此处没有受权面单选择入口 请先在原资产流程核对 本次不准备或丢弃该资产");
  for (const pkg of draft.packages) {
    const seen = new Set<string>();
    for (const line of pkg.lines) {
      const actual = workspace.lines.find(row => row.lineId === line.orderLineId);
      if (!actual) { issues.push("请为每个包裹选择本单真实商品 原建议缺失或不属于本单的商品不会自动替换"); continue; }
      if (seen.has(actual.lineId)) issues.push("同一包裹不能重复选择同一商品 请在一行填写装箱数量");
      seen.add(actual.lineId);
      const quantity = Number(line.quantity);
      if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 100_000) { issues.push("每项装箱数量须为有效正整数"); continue; }
      totals.set(actual.lineId, (totals.get(actual.lineId) ?? 0) + quantity);
    }
  }
  if (workspace.lines.some(line => (totals.get(line.lineId) ?? 0) > line.quantity)) issues.push("各包裹合计装箱数量超过原订单商品数量 请调整本次分配");
  return [...new Set(issues)];
}
function optionalInteger(value: string, label: string) {
  if (!value.trim()) return null;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ShipmentCreateValidationError(label + "须为有效整数");
  return Number(value);
}
function instant(value: string, required: boolean) {
  if (!value && !required) return null;
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw new ShipmentCreateValidationError("请填写有效的发货及交付时间");
  return date.toISOString();
}
/** Keep original pins. Aggregate across every package before the native owner sees this content. */
export function buildShipmentCreateContent(draft: ShipmentCreateDraft, workspace: ShipmentCreateWorkspace,
  allocationsFor: (packageKey: string, lineId: string, quantity: number) => ShipmentProductionAllocationInput[]) {
  const issues = shipmentCreateDraftIssues(draft, workspace);
  if (issues.length) throw new ShipmentCreateValidationError(issues[0]);
  if (!workspace.canCreate) throw new ShipmentCreateValidationError("当前装箱依据不允许建立新包裹 请先处理上方阻断原因");
  const sourceTotals = new Map<string, number>();
  const packages = draft.packages.map(pkg => ({
    packageReferenceId: pkg.packageReferenceId.trim(), trackingNumber: pkg.trackingNumber.trim(), carrierCode: pkg.carrierCode.trim(),
    carrierName: pkg.carrierName.trim(), carrierService: pkg.carrierService.trim(), labelAssetId: pkg.labelAssetId,
    externalLabelId: pkg.externalLabelId.trim() || null, labelCostMinor: optionalInteger(pkg.labelCostMinor, "面单费用"),
    labelCurrency: pkg.labelCurrency.trim() || null, weightGrams: optionalInteger(pkg.weightGrams, "包裹重量"),
    dimensionsMm: [pkg.length, pkg.width, pkg.height].some(value => value.trim())
      ? { length: optionalInteger(pkg.length, "包裹长"), width: optionalInteger(pkg.width, "包裹宽"), height: optionalInteger(pkg.height, "包裹高") } : null,
    lines: pkg.lines.map(line => {
      const quantity = Number(line.quantity), allocations = allocationsFor(pkg.key, line.orderLineId, quantity);
      for (const allocation of allocations) {
        const key = line.orderLineId + ":" + shipmentProductionSourceKey(allocation);
        const source = workspace.sources.find(row => row.orderLineId === line.orderLineId && shipmentProductionSourceKey(row) === shipmentProductionSourceKey(allocation));
        if (!source || source.blockers.length || source.availableQuantity <= 0 || source.productionVersionId !== allocation.productionVersionId
          || source.qualityInspectionId !== allocation.qualityInspectionId || source.projectionVersion !== allocation.expectedProductionProjectionVersion
          || (source.qualityGroupId ?? null) !== (allocation.qualityGroupId ?? null))
          throw new ShipmentCreateValidationError("装箱生产版本 质检或实物组已无法核对 请重新读取并按实物分配 不换用新版本");
        const total = (sourceTotals.get(key) ?? 0) + allocation.quantity;
        if (total > source.availableQuantity) throw new ShipmentCreateValidationError("多个包裹重复取用的生产来源合计超过当前可发数量 请重新分配");
        sourceTotals.set(key, total);
      }
      return { orderLineId: line.orderLineId, quantity, productionAllocations: allocations };
    }),
  }));
  const parsed = ShipmentCreateContentSchema.safeParse({ shipDate: instant(draft.shipDate, true), promisedDeliveryAt: instant(draft.promisedDeliveryAt, false),
    estimatedDeliveryAt: instant(draft.estimatedDeliveryAt, false), shipFromCountryCode: draft.shipFromCountryCode, packages });
  if (!parsed.success) throw new ShipmentCreateValidationError("请核对包裹参考号不可重复 运单与承运信息必填 费用币种须配对 交付时间不能早于发货");
  return parsed.data;
}
