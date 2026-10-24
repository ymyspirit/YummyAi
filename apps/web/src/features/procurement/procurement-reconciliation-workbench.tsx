"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileCheck2, RefreshCw, ReceiptText } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Permission } from "@yummyai/authz/permissions";
import type { ProcurementWorkspaceView } from "@yummyai/contracts/procurement";
import { InvoiceReconciliationListSchema, InvoiceReconciliationQuerySchema, type InvoiceReconciliationList } from "@yummyai/contracts/procurement/invoice-reconciliation";
import { compareStockQuantity, formatStockQuantity } from "@yummyai/contracts/inventory/quantity";
import { useErpAccess } from "../identity/erp-access";
import { RecordDialog } from "../manual-operations/record-form";
import { unitNames } from "../manual-operations/operation-types";
import { procurementCommandDenied } from "../../lib/procurement-command-client";
import { ProcurementReconciliationBalanceSummary, ProcurementSupplierAdjustmentSummary, readInvoiceReconciliation,
  reconciliationActionNames, reconciliationBalanceNames, reconciliationMoney, useInvoiceReconciliationDetail } from "./procurement-command-workbench";
import { procurementTime } from "./procurement-cycle-form";
import { ProcurementSupplierAdjustmentDialog, type ReconciliationFormIntent } from "./procurement-supplier-adjustment-form";
import "./procurement-precision.css";

/** This queue reads actual invoices and pending documents, not another actor's private commands. */
export function ProcurementReconciliationWorkbench({ data }: { data: ProcurementWorkspaceView }) {
  const access = useErpAccess(), canRead = access.can(Permission.ProcurementRead), router = useRouter(), search = useSearchParams();
  const purchaseOrderId = search.get("invoiceOrder"), [pendingOnly, setPendingOnly] = useState(false), [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [items, setItems] = useState<InvoiceReconciliationList["items"]>([]), [cursor, setCursor] = useState<string | null>(null), [unavailable, setUnavailable] = useState(0);
  const [reading, setReading] = useState(false), [error, setError] = useState("");
  const sequence = useRef(0), live = useRef(true), controller = useRef<AbortController | null>(null), authority = useRef(access.authority); authority.current = access.authority;
  const validFilter = InvoiceReconciliationQuerySchema.safeParse({ ...(purchaseOrderId ? { purchaseOrderId } : {}), pendingOnly: pendingOnly ? "true" : "false" }).success;
  const reload = useCallback(async (before?: string) => {
    if (!canRead || !validFilter) return;
    const token = ++sequence.current, captured = access.authority; controller.current?.abort(); const abort = new AbortController(); controller.current = abort; setReading(true);
    const valid = () => live.current && token === sequence.current && authority.current === captured;
    try {
      const query = new URLSearchParams({ pendingOnly: pendingOnly ? "true" : "false" });
      if (purchaseOrderId) query.set("purchaseOrderId", purchaseOrderId); if (before) query.set("before", before);
      const result = await readInvoiceReconciliation(`?${query}`, InvoiceReconciliationListSchema, abort.signal);
      if (!valid()) return;
      setItems(previous => before ? [...new Map([...previous, ...result.items].map(item => [item.invoiceId, item])).values()] : result.items);
      setCursor(result.nextCursor); setUnavailable(previous => before ? previous + result.unavailableCount : result.unavailableCount); setError("");
    } catch (failure) {
      if (abort.signal.aborted || !valid()) return;
      if (procurementCommandDenied(failure)) { setItems([]); setCursor(null); setUnavailable(0); setInvoiceId(null); }
      setError(failure instanceof Error ? failure.message : "暂时无法读取发票差异事项");
    } finally { if (valid()) setReading(false); }
  }, [canRead, validFilter, access.authority, purchaseOrderId, pendingOnly]);
  useLayoutEffect(() => { sequence.current++; controller.current?.abort(); setItems([]); setCursor(null); setUnavailable(0); setInvoiceId(null); setReading(false); setError(""); }, [access.authority, canRead, purchaseOrderId, pendingOnly]);
  useEffect(() => { live.current = true; if (canRead && validFilter) void reload(); return () => { live.current = false; sequence.current++; controller.current?.abort(); }; }, [reload, canRead, validFilter]);
  useEffect(() => { const check = () => { if (document.visibilityState === "visible") void reload(); }; window.addEventListener("focus", check); document.addEventListener("visibilitychange", check); return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); }; }, [reload]);
  const clearFilter = () => { const query = new URLSearchParams(search.toString()); query.delete("invoiceOrder"); router.replace(`/procurement${query.size ? "?" + query : ""}#invoice-reconciliation-workbench`, { scroll: false }); };
  return <section className="procurement-reconciliation-workbench" id="invoice-reconciliation-workbench" aria-labelledby="invoice-reconciliation-heading" aria-busy={reading}>
    <header><div><FileCheck2 size={17} /><h2 id="invoice-reconciliation-heading">发票差异与供应商单据</h2><span>已读取 {items.length}{cursor ? "+" : ""} 张</span></div><button type="button" disabled={reading || !canRead || !validFilter} onClick={() => void reload()}><RefreshCw size={14} />{reading ? "正在读取" : "刷新实际记录"}</button></header>
    <p className="record-help">原发票状态、金额余额、数量与未知依据分别保留 登记后先待审核 批准才影响实际余额 付款另行处理</p>
    <div className="procurement-reconciliation-filters"><label><input type="checkbox" checked={pendingOnly} onChange={event => setPendingOnly(event.target.checked)} />仅看有待审核单据</label>{purchaseOrderId && <p>已按采购单筛选 <button type="button" onClick={clearFilter}>查看全部采购单</button></p>}</div>
    {!validFilter && <p className="record-notice error" role="alert">采购单筛选标识无效 请清除筛选后重新读取</p>}
    {!canRead && <p className="record-notice" role="status">当前没有采购读取权限</p>}{error && <p className="record-notice error" role="alert">{error}</p>}
    {canRead && validFilter && !items.length && !error && <p className="record-help" role="status">{reading ? "正在读取实际发票与审核待办" : pendingOnly ? "当前没有待审核的供应商单据" : "当前没有可读取的实际发票"}</p>}
    {!!items.length && <ol className="procurement-reconciliation-queue">{items.map(item => <li key={item.invoiceId} aria-label={`发票事项 ${item.invoiceNumber}`}><div><strong>{item.invoiceNumber} · {item.purchaseOrderCode}</strong><span>原发票{item.originalStatus === "matched" ? "已匹配" : "有差异"} · 当前{reconciliationBalanceNames[item.status]}</span><span>当前净额 {reconciliationMoney(item.netAmountMinor, item.currency)} · 待审核 {item.pendingCount} 笔{item.varianceMinor === null ? " · 金额差额待核对" : ""}</span></div><button type="button" disabled={reading || Boolean(error)} onClick={() => setInvoiceId(item.invoiceId)}>核对差异与单据</button></li>)}</ol>}
    {unavailable > 0 && <p className="record-notice">{unavailable} 张发票依据当前不可访问 未将其当作零差额或已完成</p>}
    {cursor && <button type="button" disabled={reading || !canRead} onClick={() => void reload(cursor)}>读取更早的发票事项</button>}
    {invoiceId && <ProcurementReconciliationDialog data={data} invoiceId={invoiceId} onClose={() => setInvoiceId(null)} onChanged={() => { void reload(); router.refresh(); }} />}
  </section>;
}

export function ProcurementReconciliationLauncher({ data, invoiceId }: { data: ProcurementWorkspaceView; invoiceId: string }) {
  const [open, setOpen] = useState(false), access = useErpAccess(), router = useRouter();
  useLayoutEffect(() => { setOpen(false); }, [access.authority]);
  return <><button type="button" className="procurement-reconciliation-open" disabled={!access.can(Permission.ProcurementRead)} onClick={() => setOpen(true)}><ReceiptText size={14} />核对差异与单据</button>
    {open && <ProcurementReconciliationDialog data={data} invoiceId={invoiceId} onClose={() => setOpen(false)} onChanged={() => router.refresh()} />}</>;
}

function ProcurementReconciliationDialog({ data, invoiceId, onClose, onChanged }: { data: ProcurementWorkspaceView; invoiceId: string; onClose(): void; onChanged(): void }) {
  const { detail, reading, error, denied, reload } = useInvoiceReconciliationDetail(invoiceId), access = useErpAccess();
  const [intent, setIntent] = useState<ReconciliationFormIntent | null>(null), [closing, setClosing] = useState(false), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => { setIntent(null); }, [access.authority]);
  useEffect(() => { if (denied) setIntent(null); }, [denied]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const leave = () => { if (closing) return; setClosing(true); timer.current = setTimeout(onClose, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160); };
  if (intent && detail && !denied) return <ProcurementSupplierAdjustmentDialog data={data} detail={detail} intent={intent} onClose={() => setIntent(null)} onChanged={() => { void reload(); onChanged(); }} />;
  const blocked = reading || closing || Boolean(error), canMatch = detail ? detail.balance.lines.some(line => line.unit && line.unallocatedQuantity !== null && compareStockQuantity(line.unallocatedQuantity, 0) > 0 && detail.receipts.some(receipt => receipt.lineKey === line.lineKey && receipt.unit === line.unit && receipt.availableQuantity !== null && compareStockQuantity(receipt.availableQuantity, 0) > 0)) : false;
  return <RecordDialog title="发票差异与供应商单据" onClose={leave}><div className={`procurement-reconciliation-detail${closing ? " is-closing" : ""}`} aria-busy={reading}>
    <header><h3>实际发票与处理依据</h3><button type="button" disabled={reading || closing || denied} onClick={() => void reload()}><RefreshCw size={14} />重新读取实际余额</button></header>
    {reading && <p className="record-help" role="status">正在读取实际发票及当前处理记录</p>}{error && <p className="record-notice error" role="alert">{error}</p>}{denied && <p className="record-help">私有记录已清除 请核对当前账号与权限</p>}
    {detail && !denied && <><h3>{detail.invoiceNumber} · {detail.purchaseOrderCode}</h3><dl><dt>原票状态</dt><dd>{detail.originalStatus === "matched" ? "原发票已匹配" : "原发票有差异"} 原记录保持</dd><dt>原采购版本</dt><dd>{detail.purchaseOrderVersionId ?? "原版本待核对"}</dd><dt>原提交凭据</dt><dd>{detail.originalProofId ?? "原提交依据待核对"}</dd></dl>
      <ProcurementReconciliationBalanceSummary balance={detail.balance} />
      {detail.blockReason && <p className="record-notice" role="status">{detail.blockReason}</p>}
      {!detail.canRecord && !detail.blockReason && <p className="record-help">当前账号不能登记供应商调整</p>}
      {!detail.canApprove && !detail.blockReason && <p className="record-help">当前账号不能审核供应商调整或匹配实际收货</p>}
      <div className="procurement-reconciliation-actions"><button type="button" disabled={blocked || !detail.canRecord} onClick={() => setIntent({ action: "adjustment_record" })}>登记供应商贷项或补差</button><button type="button" disabled={blocked || !detail.canApprove || !canMatch} onClick={() => setIntent({ action: "receipt_match" })}>匹配后续实际收货</button></div>
      <p className="record-help">金额补差数量固定为0 补开数量使用新实际发票 贷项数量先抵尚未匹配部分 全部冲销不等于原票匹配 供应商单据引用由登记人录入 未经外部验真</p>
      {detail.canApprove && !canMatch && <p className="record-help">当前没有同时满足待匹配数量、原单位和实际可用收货的匹配组合 数量依据未知时继续待核对</p>}
      {!detail.canApprove && detail.adjustments.some(row => row.status === "pending") && <p className="record-help">当前账号或原依据暂不允许审核 这些实际单据仍待审核</p>}
      <section className="procurement-reconciliation-documents" aria-label="实际供应商调整单据"><header><h3>实际供应商调整单据</h3><span>待审核 {detail.adjustments.filter(row => row.status === "pending").length} 笔</span></header>{!detail.adjustments.length && <p className="record-help">尚未登记实际调整单据 请依据供应商真实贷项或补差单填写</p>}{detail.adjustments.map(adjustment => <article key={adjustment.id} aria-label={`调整单据 ${adjustment.document.number}`}><ProcurementSupplierAdjustmentSummary adjustment={adjustment} />{adjustment.status === "pending" && <button type="button" disabled={blocked || !detail.canApprove} onClick={() => setIntent({ action: "adjustment_review", adjustmentId: adjustment.id })}>核对并审核这笔调整</button>}</article>)}</section>
      <details><summary>查看实际收货依据</summary>{!detail.receipts.length && <p className="record-help">当前没有可读取的原采购版本收货行</p>}<ol>{detail.receipts.map(receipt => <li key={receipt.receiptLineId}><strong>{receipt.lineKey}</strong><span>验收 {formatStockQuantity(receipt.acceptedQuantity)} {unitNames[receipt.unit]} · 可匹配 {receipt.availableQuantity === null ? "待核对" : formatStockQuantity(receipt.availableQuantity)} {unitNames[receipt.unit]}</span><span>原收货行 {receipt.receiptLineId}</span></li>)}</ol></details>
      <section className="procurement-reconciliation-history" aria-label="实际处理与审核历史"><h3>实际处理与审核历史</h3>{!detail.events.length && <p className="record-help">尚无后续处理凭据</p>}{detail.events.map(event => <details key={event.id}><summary>第 {event.sequence} 次 · {reconciliationActionNames[event.action]} · {procurementTime(event.createdAt)}</summary><p>实际凭据 {event.id} · 操作者 {event.createdBy}</p><p>处理依据 {event.input.reason}{event.input.action === "adjustment_review" ? ` · ${event.input.decision === "approved" ? "批准调整" : "拒绝调整"}` : ""}</p><ProcurementReconciliationBalanceSummary balance={event.balance} title="该次执行时余额" /></details>)}</section>
    </>}
    <footer><button type="button" onClick={leave} disabled={closing}>返回采购工作区</button></footer>
  </div></RecordDialog>;
}
