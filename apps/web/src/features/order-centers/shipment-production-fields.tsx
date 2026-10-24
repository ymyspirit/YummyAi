"use client";
import { useLayoutEffect, useState } from "react";
import { ShipmentProductionAllocationInputSchema, shipmentProductionSourceKey, type ShipmentProductionSource } from "@yummyai/contracts/order/shipment";

type Line = { lineId: string; title: string; quantity: number };
const sourceBasis = (sources: ShipmentProductionSource[]) => JSON.stringify(sources);
function suggested(sources: ShipmentProductionSource[], lines: Line[]) {
  return Object.fromEntries(lines.flatMap(line => {
    const eligible = sources.filter(source => source.orderLineId === line.lineId && !source.blockers.length && source.availableQuantity >= line.quantity);
    return eligible.length === 1 ? [[shipmentProductionSourceKey(eligible[0]!), String(line.quantity)]] : [];
  }));
}
type InitialAllocations = ReadonlyArray<{ lineId?: string; productionAllocations?: unknown }>;
function initialSelection(sources: ShipmentProductionSource[], lines: Line[], initial: InitialAllocations | null | undefined) {
  if (initial === undefined) return { quantities: suggested(sources, lines), missing: false };
  const quantities: Record<string, string> = {};
  let missing = !initial || initial.some(row => !lines.some(line => line.lineId === row.lineId));
  for (const line of lines) {
    const rows = initial?.filter(row => row.lineId === line.lineId) ?? [];
    const parsed = ShipmentProductionAllocationInputSchema.array().min(1).max(100).safeParse(rows.length === 1 ? rows[0]?.productionAllocations : null);
    if (!parsed.success) { missing = true; continue; }
    const seen = new Set<string>();
    for (const allocation of parsed.data) {
      const key = shipmentProductionSourceKey(allocation), source = sources.find(row => row.orderLineId === line.lineId && shipmentProductionSourceKey(row) === key
        && row.productionVersionId === allocation.productionVersionId && row.qualityInspectionId === allocation.qualityInspectionId
        && row.projectionVersion === allocation.expectedProductionProjectionVersion && (row.qualityGroupId ?? null) === (allocation.qualityGroupId ?? null));
      if (!source || source.blockers.length || allocation.quantity > source.availableQuantity || seen.has(key)) { missing = true; continue; }
      seen.add(key); quantities[key] = String(allocation.quantity);
    }
    if (parsed.data.reduce((sum, row) => sum + row.quantity, 0) !== line.quantity) missing = true;
  }
  return { quantities, missing };
}
export function readShipmentProductionAllocations(form: FormData, lineId: string, quantity: number, prefix = "") {
  if (form.get(prefix + "verifiedProductionSources") !== "on") throw new Error("请先按实物核对装箱生产来源");
  const all = JSON.parse(String(form.get(prefix + "shipmentProductionAllocations") || "{}")) as Record<string, unknown>;
  const allocations = ShipmentProductionAllocationInputSchema.array().min(1).parse(all[lineId]);
  if (allocations.reduce((sum, source) => sum + source.quantity, 0) !== quantity) throw new Error("生产来源分配总数必须等于装箱数量");
  return allocations;
}

/** Keep the operator's original physical source choices until an explicit recheck. */
type Props = {
  sources: ShipmentProductionSource[]; lines: Line[]; disabled: boolean; onEditsChanged?: () => void; prefix?: string;
  initialAllocations?: InitialAllocations | null; resetKey?: string;
};
export function ShipmentProductionFields(props: Props) {
  return <ShipmentProductionSelection key={props.resetKey ?? "original"} {...props} />;
}
function ShipmentProductionSelection({ sources, lines, disabled, onEditsChanged, prefix = "", initialAllocations }: Props) {
  const [initial] = useState(() => initialSelection(sources, lines, initialAllocations));
  const [basis, setBasis] = useState(sources), [quantities, setQuantities] = useState<Record<string, string>>(initial.quantities),
    [confirmed, setConfirmed] = useState(false);
  useLayoutEffect(() => { onEditsChanged?.(); }, [quantities, confirmed, onEditsChanged]);
  const stale = sourceBasis(basis) !== sourceBasis(sources);
  const allocations = Object.fromEntries(lines.map(line => [line.lineId, basis.filter(source => source.orderLineId === line.lineId)
    .filter(source => Number(quantities[shipmentProductionSourceKey(source)] ?? 0) > 0).map(source => ({
      productionOrderId: source.productionOrderId, productionVersionId: source.productionVersionId,
      qualityInspectionId: source.qualityInspectionId, expectedProductionProjectionVersion: source.projectionVersion,
      ...(source.qualityGroupId ? { qualityGroupId: source.qualityGroupId } : {}),
      quantity: Number(quantities[shipmentProductionSourceKey(source)]),
    }))]));
  const complete = lines.every(line => allocations[line.lineId]!.reduce((sum, source) => sum + source.quantity, 0) === line.quantity
    && allocations[line.lineId]!.every(source => Number.isInteger(source.quantity) && source.quantity > 0
      && source.quantity <= (basis.find(row => shipmentProductionSourceKey(row) === shipmentProductionSourceKey(source))?.availableQuantity ?? 0)));
  return <fieldset className="oc-shipment-sources" disabled={disabled} aria-label="装箱生产来源">
    <legend>装箱生产来源</legend>
    <p className="oc-hint">核对实际装箱批次与合格记录 单一可用批次已建议数量 审核时重新核对可发数量</p>
    {initialAllocations !== undefined && <p className={initial.missing ? "oc-notice" : "oc-hint"} role="status">{initial.missing
      ? "原建议缺少可核对的生产版本 质检组或分配数量 未用当前新版本替换 请按实际来源补齐并本人核对"
      : "建议数量已按本次可读的原生产版本与质检组带入 尚未确认实物"}</p>}
    {stale && <div className="oc-notice" role="alert"><p>生产来源、质检或占用数量已变化 当前填写已保留 请核对实物后重新分配</p>
      <button type="button" className="oc-button" onClick={() => { setBasis(sources); setQuantities(initialSelection(sources, lines, initialAllocations).quantities); setConfirmed(false); }}>核对生产来源并重新分配</button></div>}
    <input type="hidden" name={prefix + "shipmentProductionAllocations"} value={JSON.stringify(allocations)} readOnly />
    {lines.map(line => <div className="oc-shipment-source-line" key={line.lineId}>
      <p><strong>{line.title}</strong><span>装箱 {line.quantity} 件 · 已分配 {allocations[line.lineId]!.reduce((sum, source) => sum + source.quantity, 0)} 件</span></p>
      {!basis.some(source => source.orderLineId === line.lineId) && <p className="oc-error">尚无生产来源 请先完成该商品的生产与逐项质检</p>}
      {basis.filter(source => source.orderLineId === line.lineId).map(source => <label className="oc-shipment-source-row" key={shipmentProductionSourceKey(source)}>
        <span><strong>{source.source === "remake" ? "补做批次" : "生产批次"} {source.productionOrderId.slice(-8)} · V{source.versionNumber}</strong>
          <small>批次数量 {source.quantity} · 已占用 {source.allocatedQuantity} · 当前可发 {source.availableQuantity}</small>
          {source.qualityGroupId && <small>实物组 {source.groupLabel} · {source.qualityGroupId.slice(-8)}</small>}
          {source.qualityInspectionId && <small>原质检 {source.qualityInspectionId.slice(-8)} · {source.inspectedAt ? new Date(source.inspectedAt).toLocaleString("zh-CN", { hour12: false }) : "时间未记录"}</small>}
          {source.blockers.map(reason => <small className="oc-error" key={reason}>{reason}</small>)}</span>
        <span>本包裹取用<input aria-label={`${line.title} 批次 ${source.productionOrderId.slice(-8)}${source.qualityGroupId ? " 实物组 " + source.groupLabel : ""} 分配数量`} name={`${prefix}shipment-source-${shipmentProductionSourceKey(source)}`}
          type="number" min="0" max={source.availableQuantity} step="1" disabled={stale || !!source.blockers.length || source.availableQuantity === 0}
          value={quantities[shipmentProductionSourceKey(source)] ?? ""} placeholder="0" onChange={event => {
            const value = event.target.value; setQuantities(current => ({ ...current, [shipmentProductionSourceKey(source)]: value })); setConfirmed(false);
          }} /></span>
      </label>)}
    </div>)}
    <label className="oc-check"><input name={prefix + "verifiedProductionSources"} type="checkbox" required checked={confirmed && complete && !stale}
      disabled={stale || !complete} onChange={event => setConfirmed(event.target.checked)} />已按实物核对全部装箱批次 生产版本 合格记录和数量</label>
  </fieldset>;
}
