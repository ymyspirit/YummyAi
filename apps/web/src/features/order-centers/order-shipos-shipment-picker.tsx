"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ShiposOrderShipmentEvidenceSchema, type ShiposOrderShipmentEvidence } from "@yummyai/contracts/suppliers/shipos";
import { centerRequest, dateTime } from "./order-center-model";

export function OrderShiposShipmentPicker({ orderId, refresh, disabled, selectedId, onSelect, onClear }: {
  orderId: string; refresh: string; disabled: boolean; selectedId?: string;
  onSelect(record: ShiposOrderShipmentEvidence): void; onClear(): void;
}) {
  const [records, setRecords] = useState<ShiposOrderShipmentEvidence[]>([]), [error, setError] = useState(""), [reading, setReading] = useState(true), [reload, setReload] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setReading(true); setError("");
    void centerRequest(`orders/${orderId}/shipos-evidence`, undefined, abort.signal).then(value => {
      if (!abort.signal.aborted) setRecords(ShiposOrderShipmentEvidenceSchema.array().parse(value));
    }).catch(() => { if (!abort.signal.aborted) setError("ShipOS 已同步记录暂时无法读取，可重试或手动核对运单。"); })
      .finally(() => { if (!abort.signal.aborted) setReading(false); });
    return () => abort.abort();
  }, [orderId, refresh, reload]);
  return <div className="oc-shipos-picker" aria-label="带入已有 ShipOS 运单" aria-busy={reading}>
    <div className="oc-whole-heading"><strong>ShipOS 已有运单</strong><button className="oc-text-button" type="button" disabled={disabled || reading} onClick={() => setReload(value => value + 1)}>重新读取已有运单</button></div>
    {reading && <p className="oc-hint" role="status">正在读取本单已同步的运单…</p>}
    {error && <p className="oc-error" role="alert">{error}</p>}
    {!reading && !error && !records.length && <p className="oc-hint">本单暂无已关联的 ShipOS 运单。可先在<Link href="/shipments?view=logistics">物流同步</Link>查询工厂已有订单，再回到这里核对。</p>}
    {records.map(item => <div className="oc-whole-waybill" key={item.record.id}>
      <strong>{item.supplierName} · {item.record.trackingNumber ?? "暂无运单号"}</strong>
      <p>{item.record.channel ?? "渠道未返回"} · 查询于 {dateTime(item.record.fetchedAt)}</p>
      <p className="oc-hint">{item.carrierMapping ? `${item.carrierMapping.carrierName} · ${item.carrierMapping.carrierService} · ${item.carrierMapping.shipFromCountryCode}` : "尚无对应的承运信息配置，带入后请核对填写承运商、服务和发货国家。"}</p>
      {item.blockers.map(reason => <p key={reason} className="oc-error">{reason}</p>)}
      <div className="oc-action-row"><button type="button" className="oc-button" disabled={disabled || reading || !!error || !!item.blockers.length} onClick={() => onSelect(item)}>{selectedId === item.record.id ? "重新带入此运单" : "带入整单包裹"}</button>
        {item.record.labelAvailable && item.record.match === "matched" && <a download href={`/api/shipos/${item.supplierId}/records/${item.record.id}/label`}>下载现有面单</a>}
        <Link href={`/suppliers/${item.supplierId}#shipos-channel-mappings`}>配置此渠道承运信息</Link>
        <Link href={`/shipments?view=logistics&supplierId=${item.supplierId}`}>同步最新记录</Link></div>
    </div>)}
    {selectedId && <p className="oc-notice">已带入已有运单。请核对下方包裹信息；保存包裹仍需审核和实际交运记录。<button type="button" className="oc-text-button" disabled={disabled} onClick={onClear}>取消带入来源，改为手填</button></p>}
  </div>;
}
