"use client";

import type { InventoryPurchaseOrderView, ProcurementWorkspaceView } from "@yummyai/contracts/procurement";
import { Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { MasterRecordDialog, mergeRecords, type MasterKind } from "../manual-operations/master-record-dialog";
import { Field, RecordDialog, RecordForm, RecordSelect } from "../manual-operations/record-form";
import { formDate, formText, localDateTime, moneyMinor, unitNames } from "../manual-operations/operation-types";

export function ProcurementOperations({ data }: { data: ProcurementWorkspaceView }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const router = useRouter();
  return <>
    <div className="record-toolbar"><button className="primary" onClick={() => setOpen(true)}><Plus size={15} />新增采购单</button><Link href="/suppliers">供应商档案</Link><Link href="/inventory">仓库与物料</Link><p>保存为草稿，核对并审核后再登记收货。</p></div>
    {message && <p className="record-notice success" role="status">{message}</p>}
    {open && <PurchaseEditor data={data} onClose={() => { setOpen(false); router.refresh(); }} onSaved={(saved) => { setOpen(false); setMessage(`采购单 ${saved.code} 已保存为草稿。`); router.refresh(); }} />}
  </>;
}

export function PurchaseOrderActions({ data, order }: { data: ProcurementWorkspaceView; order: InventoryPurchaseOrderView }) {
  const [action, setAction] = useState<"edit" | "review" | "receive">();
  const [message, setMessage] = useState("");
  const router = useRouter();
  const editable = ["draft", "rejected"].includes(order.status);
  const receivable = ["approved", "partially_received", "reconciliation_required"].includes(order.status);
  const saved = () => { setMessage(action === "receive" ? "收货已入账" : "已保存"); setAction(undefined); router.refresh(); };
  return <>
    <div className="record-toolbar" style={{ margin: 0 }}>
      {editable && <><button onClick={() => setAction("edit")}>编辑草稿</button><button onClick={() => setAction("review")}>审核采购单</button></>}
      {receivable && <button onClick={() => setAction("receive")}>登记收货</button>}
      {!editable && !receivable && <span>已完成</span>}
    </div>
    {message && <small role="status">{message}</small>}
    {action === "edit" && <PurchaseEditor data={data} order={order} onClose={() => { setAction(undefined); router.refresh(); }} onSaved={saved} />}
    {action === "review" && <PurchaseReview data={data} order={order} onClose={() => setAction(undefined)} onSaved={saved} />}
    {action === "receive" && <PurchaseReceipt data={data} order={order} onClose={() => setAction(undefined)} onSaved={saved} />}
  </>;
}

interface DraftLine { key: string; stockId: string; locationId: string; quantity: string; cost: string }
function newLine(): DraftLine { return { key: `L-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, stockId: "", locationId: "", quantity: "", cost: "" }; }

function PurchaseEditor({ data, order, onClose, onSaved }: { data: ProcurementWorkspaceView; order?: InventoryPurchaseOrderView; onClose: () => void; onSaved: (record: Record<string, unknown>) => void }) {
  const [code] = useState(() => `PO-${crypto.randomUUID().slice(0, 8).toUpperCase()}`);
  const [supplierId, setSupplierId] = useState(order?.supplierId ?? "");
  const [currency, setCurrency] = useState(order?.currency ?? "CNY");
  const [lines, setLines] = useState<DraftLine[]>(() => order ? order.lines.map((line) => ({ key: line.lineKey, stockId: line.stockItemId, locationId: line.destinationLocationId, quantity: String(line.quantity), cost: (line.unitCostMinor / 100).toFixed(2) })) : [newLine()]);
  const [extraSuppliers, setExtraSuppliers] = useState<ProcurementWorkspaceView["suppliers"]>([]);
  const [extraStock, setExtraStock] = useState<ProcurementWorkspaceView["stockItems"]>([]);
  const [extraLocations, setExtraLocations] = useState<ProcurementWorkspaceView["locations"]>([]);
  const [create, setCreate] = useState<{ kind: MasterKind; lineKey?: string }>();
  const suppliers = mergeRecords(data.suppliers, extraSuppliers).filter((item) => item.status === "active" || item.id === supplierId);
  const stock = mergeRecords(data.stockItems, extraStock).filter((item) => item.status !== "inactive" || lines.some((line) => line.stockId === item.id));
  const locations = mergeRecords(data.locations, extraLocations).filter((item) => item.status !== "inactive" || lines.some((line) => line.locationId === item.id));
  const update = (key: string, patch: Partial<DraftLine>) => setLines((current) => current.map((line) => line.key === key ? { ...line, ...patch } : line));
  let total: number | null = 0;
  try { for (const line of lines) { if (!line.quantity || !Number.isInteger(Number(line.quantity)) || Number(line.quantity) <= 0) throw new Error(); total += Number(line.quantity) * moneyMinor(line.cost); } } catch { total = null; }
  return <>
    <RecordDialog title={order ? `编辑采购单 ${order.code}` : "新增采购单"} onClose={onClose}>
      <RecordForm operation={order ? "purchase.revise" : "purchase.create"} id={order?.id} onCancel={onClose} onSaved={onSaved} submitLabel="保存采购草稿"
        description={order ? "保存会建立新的采购版本，需要重新审核后才能收货。" : "填写供应商、物料和到货时间。缺少的档案可在这里新增，当前输入会保留。"}
        build={(form) => ({
          ...(order ? { expectedVersion: order.currentVersion } : { code: formText(form, "code").toUpperCase(), supplierId, requisitionId: null, quoteId: null }),
          currency, expectedAt: formDate(form, "expectedAt"), lines: lines.map((line) => ({ lineKey: line.key, stockItemId: line.stockId, destinationLocationId: line.locationId, quantity: Number(line.quantity), unit: stock.find((item) => item.id === line.stockId)?.baseUnit, unitCostMinor: moneyMinor(line.cost) })),
        })}>
        {!order && <Field label="采购单号" help="已自动生成，也可填写现有采购编号。"><input name="code" required maxLength={64} defaultValue={code} /></Field>}
        {order ? <p className="record-help">供应商：{suppliers.find((supplier) => supplier.id === order.supplierId)?.name ?? "无法读取"}</p> : <RecordSelect label="供应商" value={supplierId} onChange={(id) => { setSupplierId(id); setCurrency(suppliers.find((supplier) => supplier.id === id)?.settlementCurrency ?? currency); }} options={suppliers.map((supplier) => ({ id: supplier.id, label: `${supplier.name} · ${supplier.settlementCurrency}` }))} onCreate={() => setCreate({ kind: "supplier" })} />}
        <div className="record-grid"><Field label="采购币种"><select value={currency} onChange={(event) => setCurrency(event.target.value)}>{[...new Set([currency, "CNY", "USD", "EUR", "GBP", "CAD", "AUD"])].map((value) => <option key={value}>{value}</option>)}</select></Field>
          <Field label="预计到货时间"><input name="expectedAt" type="datetime-local" required defaultValue={order ? localDateTime(new Date(order.expectedAt)) : ""} /></Field></div>
        <div className="record-lines">{lines.map((line, index) => <section className="record-line" key={line.key} aria-label={`采购明细 ${index + 1}`}>
          <header><strong>采购明细 {index + 1}</strong>{lines.length > 1 && <button aria-label={`移除明细 ${index + 1}`} onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))} type="button"><Trash2 size={14} />移除</button>}</header>
          <div className="record-grid"><RecordSelect label="物料" value={line.stockId} onChange={(stockId) => update(line.key, { stockId })} options={stock.map((item) => ({ id: item.id, label: `${item.name} · ${item.code}` }))} onCreate={() => setCreate({ kind: "stock", lineKey: line.key })} />
            <RecordSelect label="收货库位" value={line.locationId} onChange={(locationId) => update(line.key, { locationId })} options={locations.map((item) => ({ id: item.id, label: `${item.name} · ${item.code}` }))} onCreate={() => setCreate({ kind: "location", lineKey: line.key })} /></div>
          <div className="record-grid"><Field label="采购数量" help={`单位：${unitNames[stock.find((item) => item.id === line.stockId)?.baseUnit ?? "each"]}`}><input type="number" min="1" step="1" required value={line.quantity} onChange={(event) => update(line.key, { quantity: event.target.value })} /></Field>
            <Field label={`单价（${currency}）`}><input inputMode="decimal" required pattern="[0-9]+(\.[0-9]{1,2})?" value={line.cost} onChange={(event) => update(line.key, { cost: event.target.value })} /></Field></div>
        </section>)}</div>
        <button disabled={lines.length >= 200} onClick={() => setLines((current) => [...current, newLine()])} type="button"><Plus size={14} />添加采购明细</button>
        <p className="record-totals">合计：{total === null ? "填写数量和单价后计算" : `${currency} ${(total / 100).toFixed(2)}`}</p>
      </RecordForm>
    </RecordDialog>
    {create && <MasterRecordDialog kind={create.kind} onClose={() => setCreate(undefined)} onSaved={(saved) => {
      if (create.kind === "supplier") { setExtraSuppliers((current) => [...current, saved as unknown as ProcurementWorkspaceView["suppliers"][number]]); setSupplierId(String(saved.id)); setCurrency(String(saved.settlementCurrency)); }
      if (create.kind === "stock") { setExtraStock((current) => [...current, saved as unknown as ProcurementWorkspaceView["stockItems"][number]]); update(create.lineKey!, { stockId: String(saved.id) }); }
      if (create.kind === "location") { setExtraLocations((current) => [...current, saved as unknown as ProcurementWorkspaceView["locations"][number]]); update(create.lineKey!, { locationId: String(saved.id) }); }
      setCreate(undefined);
    }} />}
  </>;
}

function PurchaseReview({ data, order, onClose, onSaved }: { data: ProcurementWorkspaceView; order: InventoryPurchaseOrderView; onClose: () => void; onSaved: () => void }) {
  return <RecordDialog title={`审核采购单 ${order.code}`} onClose={onClose}><RecordForm operation="purchase.review" id={order.id} onCancel={onClose} onSaved={onSaved} submitLabel="保存审核决定"
    description="核对采购版本、供应商、明细和金额。批准后允许登记收货。"
    build={(form) => ({ expectedVersion: order.currentVersion, decision: formText(form, "decision"), reasonCode: formText(form, "reasonCode") })}>
    <PurchaseSummary data={data} order={order} />
    <Field label="审核决定"><select name="decision"><option value="approved">批准采购</option><option value="rejected">驳回修改</option></select></Field>
    <Field label="审核依据"><select name="reasonCode"><option value="DETAILS_CONFIRMED">供应商、明细及金额已核对</option><option value="BUDGET_CONFIRMED">预算已确认</option><option value="DETAILS_INCORRECT">资料或数量需修改</option><option value="PRICE_UNCONFIRMED">价格尚未确认</option></select></Field>
  </RecordForm></RecordDialog>;
}

function PurchaseReceipt({ data, order, onClose, onSaved }: { data: ProcurementWorkspaceView; order: InventoryPurchaseOrderView; onClose: () => void; onSaved: () => void }) {
  const [receivedAt] = useState(() => localDateTime());
  const [lotPrefix] = useState(() => `LOT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`);
  const receipts = data.receipts.filter((receipt) => receipt.purchaseOrderId === order.id);
  return <RecordDialog title={`登记收货 ${order.code}`} onClose={onClose}><RecordForm operation="purchase.receive" id={order.id} onCancel={onClose} onSaved={onSaved} submitLabel="确认收货并入库"
    description="按实际验收结果填写。本次实收数量会写入对应物料、库位和批次；采购金额不随收货改写。"
    build={(form) => {
      const lines = order.lines.map((line, index) => {
        const received = Number(formText(form, `received-${index}`) || "0");
        const rejected = Number(formText(form, `rejected-${index}`) || "0");
        return { lineKey: line.lineKey, receivedQuantity: received, rejectedQuantity: rejected, rejectionReasonCode: rejected > 0 ? formText(form, `reason-${index}`) || null : null, lotCode: received > 0 ? formText(form, `lot-${index}`).toUpperCase() : null, expiresAt: null };
      }).filter((line) => line.receivedQuantity !== 0 || line.rejectedQuantity !== 0);
      if (!lines.length) throw new Error("请至少填写一行实收或拒收数量。");
      return { expectedVersion: order.currentVersion, receivedAt: formDate(form, "receivedAt"), externalReference: formText(form, "reference") || null, lines };
    }}>
    <div className="record-grid"><Field label="收货时间"><input type="datetime-local" required name="receivedAt" defaultValue={receivedAt} /></Field><Field label="送货单号（可选）"><input name="reference" maxLength={200} /></Field></div>
    {order.lines.map((line, index) => {
      const previous = receipts.flatMap((receipt) => receipt.lines).filter((row) => row.lineKey === line.lineKey);
      const received = previous.reduce((sum, row) => sum + row.receivedQuantity, 0);
      const rejected = previous.reduce((sum, row) => sum + row.rejectedQuantity, 0);
      return <section className="record-line" key={line.lineKey} aria-label={`收货明细 ${index + 1}`}><header><strong>{data.stockItems.find((item) => item.id === line.stockItemId)?.name ?? line.lineKey}</strong></header>
        <p className="record-help">采购 {line.quantity} {unitNames[line.unit]} · 累计实收 {received} · 累计拒收 {rejected} · 待核对 {Math.max(0, line.quantity - received - rejected)} · {data.locations.find((item) => item.id === line.destinationLocationId)?.name}</p>
        <div className="record-grid"><Field label="本次实收数量"><input name={`received-${index}`} type="number" min="0" step="1" defaultValue="0" /></Field><Field label="本次拒收数量"><input name={`rejected-${index}`} type="number" min="0" step="1" defaultValue="0" /></Field>
          <Field label="批次编码" help="实收时必填；每次收货使用新的批次。"><input name={`lot-${index}`} maxLength={64} defaultValue={`${lotPrefix}-${index + 1}`} /></Field><Field label="拒收原因"><select name={`reason-${index}`} defaultValue=""><option value="">无拒收</option><option value="QUALITY_FAILED">质量不合格</option><option value="WRONG_ITEM">物料不符</option><option value="DAMAGED">破损</option></select></Field></div>
      </section>;
    })}
  </RecordForm></RecordDialog>;
}

function PurchaseSummary({ data, order }: { data: ProcurementWorkspaceView; order: InventoryPurchaseOrderView }) {
  return <div><p className="record-help">{data.suppliers.find((supplier) => supplier.id === order.supplierId)?.name} · 版本 {order.currentVersion} · 预计到货 {new Date(order.expectedAt).toLocaleString("zh-CN")}</p><ul>{order.lines.map((line) => <li key={line.lineKey}>{data.stockItems.find((item) => item.id === line.stockItemId)?.name ?? line.lineKey} · {line.quantity} {unitNames[line.unit]} × {(line.unitCostMinor / 100).toFixed(2)} {order.currency}</li>)}</ul><p className="record-totals">合计 {order.currency} {(order.totalMinor / 100).toFixed(2)}</p></div>;
}
