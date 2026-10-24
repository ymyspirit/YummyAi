"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ReceiptText } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import type { InventoryPurchaseOrderView, ProcurementWorkspaceView } from "@yummyai/contracts/procurement";
import { PrepareProcurementCommandSchema, type PrepareProcurementCommand } from "@yummyai/contracts/procurement/procurement-command";
import { formatMinorAmount } from "@yummyai/contracts/common/money";
import { stockQuantityString } from "@yummyai/contracts/inventory/quantity";
import { procurementAmountMinor, sumProcurementMinor } from "@yummyai/contracts/procurement/measurement";
import { Field } from "../manual-operations/record-form";
import { formDate, formText, localDateTime, moneyMinor, unitNames } from "../manual-operations/operation-types";
import { useErpAccess } from "../identity/erp-access";
import { ProcurementCommandRequestError, procurementCommandDenied } from "../../lib/procurement-command-client";
import { ProcurementCycleDialog, type ProcurementExternalForm } from "./procurement-command-workbench";
import { ProcurementMeasure, procurementPrecisionMessage, readProcurementQuantity } from "./procurement-cycle-form";
import "./procurement-precision.css";

type InvoiceLineDraft = { lineKey: string; quantity: string; cost: string; basis: string };

/** The shared dialog owns preparation, recovery, execution and acknowledgement. */
export function ProcurementInvoiceForm({ data, order, onClose, onCompleted, onChanged }: {
  data: ProcurementWorkspaceView; order: InventoryPurchaseOrderView;
  onClose(): void; onCompleted(): void; onChanged(): void;
}) {
  const externalForm = useMemo<ProcurementExternalForm>(() => ({ kind: "invoice_record", targetId: order.id,
    render: props => <InvoiceEntryForm order={order} {...props} /> }), [order]);
  return <ProcurementCycleDialog data={data} externalForm={externalForm} onClose={onClose} onCompleted={onCompleted} onChanged={onChanged} />;
}

function InvoiceEntryForm({ order, disabled, onPrepare, onClose }: {
  order: InventoryPurchaseOrderView; disabled: boolean;
  onPrepare(input: PrepareProcurementCommand): Promise<void>; onClose(): void;
}) {
  const [originalOrder] = useState(order), [requestKey] = useState(() => crypto.randomUUID());
  const [currency, setCurrency] = useState(originalOrder.currency), [invoiceNumber, setInvoiceNumber] = useState("");
  const [issuedAt, setIssuedAt] = useState(() => localDateTime());
  const [lines, setLines] = useState<InvoiceLineDraft[]>(() => originalOrder.lines.map(line => ({ lineKey: line.lineKey, quantity: "",
    cost: formatMinorAmount(line.unitCostMinor, originalOrder.currency), basis: line.priceBasisQuantity === undefined ? "" : stockQuantityString(line.priceBasisQuantity) })));
  const [frozen, setFrozen] = useState<PrepareProcurementCommand | null>(null), [working, setWorking] = useState(false), [error, setError] = useState("");
  const active = useRef(true), busy = useRef(false), access = useErpAccess();
  const canWrite = access.can(Permission.ProcurementRead) && access.can(Permission.ProcurementWrite);
  const changed = order.id !== originalOrder.id || order.currentVersion !== originalOrder.currentVersion;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const update = (key: string, patch: Partial<InvoiceLineDraft>) => setLines(rows => rows.map(row => row.lineKey === key ? { ...row, ...patch } : row));
  const buildLines = () => lines.filter(row => row.quantity.trim()).map(row => {
    const ordered = originalOrder.lines.find(line => line.lineKey === row.lineKey)!;
    const invoicedQuantity = readProcurementQuantity(row.quantity, ordered.unit), unitCostMinor = moneyMinor(row.cost, currency);
    const priceBasisQuantity = row.basis ? readProcurementQuantity(row.basis, ordered.unit) : undefined;
    procurementAmountMinor(invoicedQuantity, unitCostMinor, priceBasisQuantity ?? 1);
    return { lineKey: row.lineKey, invoicedQuantity, unitCostMinor, ...(priceBasisQuantity === undefined ? {} : { priceBasisQuantity }) };
  });
  let total: number | null = null, precisionError = "";
  try { if (lines.some(line => line.quantity.trim())) total = sumProcurementMinor(buildLines().map(line => procurementAmountMinor(line.invoicedQuantity, line.unitCostMinor, line.priceBasisQuantity ?? 1))); }
  catch (failure) { precisionError = procurementPrecisionMessage(failure); }
  return <form className="record-form procurement-invoice-form procurement-cycle-form" aria-label="登记实际供应商发票" onSubmit={async event => {
    event.preventDefault(); if (busy.current || disabled || !canWrite || changed && !frozen) return;
    try {
      const form = new FormData(event.currentTarget);
      const original = frozen ?? PrepareProcurementCommandSchema.parse({ kind: "invoice_record", targetId: originalOrder.id,
        input: { expectedVersion: originalOrder.currentVersion, invoiceNumber: formText(form, "invoiceNumber"), currency,
          issuedAt: formDate(form, "issuedAt"), lines: buildLines(), idempotencyKey: requestKey } });
      busy.current = true; setWorking(true); setError("");
      try { await onPrepare(original); }
      catch (failure) { if (active.current && failure instanceof ProcurementCommandRequestError && (failure.status === 0 || failure.status >= 500)) setFrozen(original); throw failure; }
    } catch (failure) {
      if (active.current && !procurementCommandDenied(failure)) setError(failure instanceof ProcurementCommandRequestError ? failure.message : procurementPrecisionMessage(failure, "请填写实际发票编号、时间及至少一行有效数量和金额"));
    } finally { busy.current = false; if (active.current) setWorking(false); }
  }}>
    <h3>登记实际发票 {originalOrder.code}</h3>
    <p className="record-help">原采购 {originalOrder.code} · v{originalOrder.currentVersion} · {originalOrder.currency} {formatMinorAmount(originalOrder.totalMinor, originalOrder.currency)} 按本张实际发票填写 可分多张登记 留空的数量行不计入本张</p>
    <p className="record-help">先保存原填写 核对后登记实际发票 保存后可从本人采购原提交继续核对 未保存的填写仅在当前页保留</p>
    {changed && <p className="record-notice error" role="alert">采购版本已变化 {frozen ? "原填写保持原版本 请先读取原提交核对 不会改绑新版本" : "请关闭后重新核对当前采购版本"}</p>}
    {error && <p className="record-notice error" role="alert">{error}</p>}
    {frozen && <p className="record-notice" role="status">保存结果待核对 已固定原填写、原采购版本与原提交键 请先重新读取原提交 重试仍是同一笔 不要另建相同发票</p>}
    <fieldset className="record-fields" disabled={disabled || working || !canWrite} inert={Boolean(frozen) || changed} aria-disabled={Boolean(frozen) || changed}>
      <div className="record-grid"><Field label="实际发票编号"><input name="invoiceNumber" required maxLength={100} value={invoiceNumber} onChange={event => setInvoiceNumber(event.target.value)} /></Field><Field label="发票开具时间"><input name="issuedAt" required type="datetime-local" value={issuedAt} onChange={event => setIssuedAt(event.target.value)} /></Field><Field label="发票币种"><select value={currency} onChange={event => { setCurrency(event.target.value); setLines(rows => rows.map(row => ({ ...row, cost: "" }))); setError("发票币种已变化 已清空报价金额 请按实际发票重新填写"); }}>{[...new Set([currency, "CNY", "USD", "EUR", "GBP", "JPY", "KWD"])].map(value => <option key={value}>{value}</option>)}</select></Field></div>
      {lines.map((line, index) => { const ordered = originalOrder.lines.find(row => row.lineKey === line.lineKey)!; return <section className="record-line" key={line.lineKey} aria-label={`发票明细 ${index + 1}`}><header><strong>{line.lineKey}</strong><span>采购单位 {unitNames[ordered.unit]}</span></header><ProcurementMeasure quantity={ordered.quantity} unit={ordered.unit} stockBasis={ordered.stockBasis} /><div className="record-grid"><Field label="本张开票数量" help={`采购单位 ${unitNames[ordered.unit]} 留空不登记本行`}><input type="text" inputMode="decimal" maxLength={41} value={line.quantity} onChange={event => update(line.lineKey, { quantity: event.target.value })} /></Field><Field label={`发票报价金额（${currency}）`}><input type="text" inputMode="decimal" maxLength={40} value={line.cost} onChange={event => update(line.lineKey, { cost: event.target.value })} /></Field><Field label={`发票计价数量（${unitNames[ordered.unit]}）`} help="留空按1计算"><input type="text" inputMode="decimal" placeholder="1" maxLength={41} value={line.basis} onChange={event => update(line.lineKey, { basis: event.target.value })} /></Field></div></section>; })}
      <p className="record-totals">本张实际金额 {total === null ? "填写本张数量和金额后计算" : currency + " " + formatMinorAmount(total, currency)}</p>
      {precisionError && <p className="record-notice error" role="alert">{precisionError}</p>}
    </fieldset>
    <footer><button type="button" data-record-cancel disabled={disabled || working} onClick={onClose}>返回采购记录</button><button type="submit" className="primary" disabled={disabled || working || !canWrite || changed && !frozen}><ReceiptText size={15} />{working ? "正在保存原发票" : frozen ? "重试保存原发票" : "保存原发票并核对"}</button></footer>
  </form>;
}
