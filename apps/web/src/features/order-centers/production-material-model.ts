import { RecordProductionMaterialSchema, measuredQuantityExceedsPlan, type ProductionMaterialsWorkspace, type RecordProductionMaterial } from "@yummyai/contracts/order/material-execution";
import { addStockQuantity, compareStockQuantity, formatStockQuantity, stockQuantityFromRatio, stockQuantityMatchesUnit, stockQuantityValue } from "@yummyai/contracts/inventory/quantity";
import type { z } from "zod";
import type { ProductionMaterialStockOptionsSchema, ProductionMaterialReservationOptionsSchema } from "@yummyai/contracts/order/material-execution";
import { unitNames } from "../manual-operations/operation-types";

export const materialKindNames: Record<RecordProductionMaterial["kind"], string> = { reserve: "备料预留", consume: "记录实际耗用", release: "释放未用预留", return: "记录实际退料", factory_report: "登记工厂报告", factory_correction: "更正原工厂报告" };
export type MaterialMode = { kind: RecordProductionMaterial["kind"]; materialCode: string; originalEntryId?: string; reservationEntryId?: string };
export type MaterialDraft = { quantity: string; dimension: string; reservation: string; occurredAt: string; reason: string; reportReference: string; confirmed: boolean };
export const emptyMaterialDraft = (): MaterialDraft => ({ quantity: "", dimension: "", reservation: "", occurredAt: "", reason: "", reportReference: "", confirmed: false });
export const materialBasisStamp = (view: ProductionMaterialsWorkspace) => JSON.stringify([view.bindingId, view.productionRevision, view.contextAuthority, view.sourceContentChecksum,
  view.lines.map(line => [line.code, line.actualNetQuantity, line.outstandingReservedQuantity]),
  view.entries.map(entry => [entry.id, entry.remainingReservedQuantity, entry.correctableQuantity])]);
type Stock = z.infer<typeof ProductionMaterialStockOptionsSchema>["items"][number];
type Reservation = z.infer<typeof ProductionMaterialReservationOptionsSchema>["items"][number];

export function plannedMaterialLabel(numerator: string, denominator: string, unit: keyof typeof unitNames) {
  try { return formatStockQuantity(stockQuantityFromRatio(BigInt(numerator), BigInt(denominator))) + " " + unitNames[unit]; }
  catch { return `${BigInt(numerator).toLocaleString("zh-CN")} / ${BigInt(denominator).toLocaleString("zh-CN")} ${unitNames[unit]}`; }
}
export function buildMaterialInput(view: ProductionMaterialsWorkspace, mode: MaterialMode, draft: MaterialDraft,
  stock: Stock[], reservations: Reservation[], requestKey: string): RecordProductionMaterial {
  const line = view.lines.find(row => row.code === mode.materialCode);
  if (!view.bindingId || !line || !view.canWrite) throw new Error("请先核对原制造依据与当前操作权限");
  if (!view.currentBinding && ["reserve", "consume", "factory_report"].includes(mode.kind)) throw new Error("新备料及耗用须核对当前制造版本");
  if (mode.kind === "reserve" && ["completed", "cancel_requested", "cancelled", "failed"].includes(view.productionStatus)) throw new Error("当前生产状态不接受新增备料预留");
  if (!draft.occurredAt || !Number.isFinite(new Date(draft.occurredAt).getTime())) throw new Error("请填写实际发生时间");
  if (draft.reason.trim() && draft.reason.trim().length < 10) throw new Error("填写原因时请说明完整 至少10个字");
  if (draft.reason.trim().length > 1000) throw new Error("原因最多1000个字");
  const base = { bindingId: view.bindingId, materialCode: line.code, contextAuthority: view.contextAuthority,
    expectedProductionRevision: view.productionRevision, idempotencyKey: requestKey, occurredAt: new Date(draft.occurredAt).toISOString(), reason: draft.reason.trim() || null };
  const original = mode.originalEntryId ? view.entries.find(row => row.id === mode.originalEntryId) : undefined;
  if (mode.kind === "release") {
    if (!original || original.kind !== "reserve" || compareStockQuantity(original.remainingReservedQuantity ?? 0, 0) <= 0) throw new Error("原备料没有可释放余量 请重新核对");
    return RecordProductionMaterialSchema.parse({ ...base, kind: mode.kind, originalEntryId: original.id });
  }
  let quantity: number | string;
  try { quantity = stockQuantityValue(draft.quantity.trim()); } catch { throw new Error("请填写正数 数量最多9位小数"); }
  if (compareStockQuantity(quantity, 0) <= 0 || !stockQuantityMatchesUnit(quantity, line.unit)) throw new Error("请核对数量 计数单位须为整件 整对或整套");
  if (["consume", "return", "factory_report"].includes(mode.kind) && !draft.confirmed) throw new Error("请先确认实际发生的数量与来源");
  const mustExplain = ["return", "factory_correction"].includes(mode.kind) || ["completed", "cancel_requested", "cancelled", "failed"].includes(view.productionStatus) ||
    ["reserve", "consume", "factory_report"].includes(mode.kind) && measuredQuantityExceedsPlan(addStockQuantity(addStockQuantity(line.actualNetQuantity,
      mode.kind === "reserve" ? line.outstandingReservedQuantity : 0), quantity), line.plannedNumerator, line.plannedDenominator);
  if (mustExplain && draft.reason.trim().length < 10) throw new Error("更正 补记或超过原计划的数量须说明原因 至少10个字");
  if (mode.kind === "return" || mode.kind === "factory_correction") {
    if (!original || original.kind !== (mode.kind === "return" ? "consume" : "factory_report") || compareStockQuantity(quantity, original.correctableQuantity ?? 0) > 0)
      throw new Error("更正数量不能超过原记录的可更正余量");
    return RecordProductionMaterialSchema.parse({ ...base, kind: mode.kind, quantity, originalEntryId: original.id, ...(mode.kind === "return" ? { actualConfirmed: true } : {}) });
  }
  if (mode.kind === "factory_report") {
    if (!draft.reportReference.trim() || draft.reportReference.trim().length > 200) throw new Error("请填写工厂报告来源 最多200个字");
    return RecordProductionMaterialSchema.parse({ ...base, kind: mode.kind, quantity, reportReference: draft.reportReference, actualConfirmed: true });
  }
  const reservationId = mode.reservationEntryId ?? draft.reservation;
  const reservation = reservationId ? reservations.find(row => row.entryId === reservationId) : undefined;
  const dimension = stock.find(row => row.dimensionKey === draft.dimension);
  if (mode.kind === "consume" && reservationId) {
    if (!reservation || !reservation.dimensionActive || compareStockQuantity(quantity, reservation.remainingQuantity) > 0) throw new Error("请重新核对原备料余量与库位");
    return RecordProductionMaterialSchema.parse({ ...base, kind: mode.kind, quantity, locationId: reservation.locationId, lotId: reservation.lotId, reservationEntryId: reservation.entryId, actualConfirmed: true });
  }
  if (!dimension || dimension.stockItemId !== line.stockItemId || dimension.unit !== line.unit || compareStockQuantity(quantity, dimension.availableQuantity) > 0)
    throw new Error("请核对可用库存及库位批次 不得占用其他预留");
  return RecordProductionMaterialSchema.parse({ ...base, kind: mode.kind, quantity, locationId: dimension.locationId, lotId: dimension.lotId,
    ...(mode.kind === "consume" ? { reservationEntryId: null, actualConfirmed: true } : {}) });
}
