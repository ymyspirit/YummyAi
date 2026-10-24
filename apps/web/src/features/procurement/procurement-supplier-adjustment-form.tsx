"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import type { ProcurementWorkspaceView } from "@yummyai/contracts/procurement";
import type { InvoiceReconciliationDetail } from "@yummyai/contracts/procurement/invoice-reconciliation";
import { PrepareProcurementCommandSchema, type PrepareProcurementCommand } from "@yummyai/contracts/procurement/procurement-command";
import { NonnegativeStockQuantitySchema } from "@yummyai/contracts/inventory/quantity-schema";
import { compareStockQuantity, formatStockQuantity, stockQuantityMatchesUnit, type StockQuantity } from "@yummyai/contracts/inventory/quantity";
import { sumProcurementMinor } from "@yummyai/contracts/procurement/measurement";
import { formatMinorAmount } from "@yummyai/contracts/common/money";
import { Field } from "../manual-operations/record-form";
import { formDate, formText, localDateTime, moneyMinor, unitNames } from "../manual-operations/operation-types";
import { ProcurementCommandRequestError, procurementCommandDenied } from "../../lib/procurement-command-client";
import { ProcurementCycleDialog, ProcurementSupplierAdjustmentSummary, reconciliationActionNames, type ProcurementExternalForm } from "./procurement-command-workbench";
import { procurementPrecisionMessage, readProcurementQuantity } from "./procurement-cycle-form";

export type ReconciliationFormIntent = { action: "adjustment_record" } | { action: "adjustment_review"; adjustmentId: string } | { action: "receipt_match" };
type AdjustmentDraft = { invoiceLineId: string; selected: boolean; quantity: string; amount: string };
type MatchDraft = { key: string; invoiceLineId: string; receiptLineId: string; quantity: string };
const newMatch = (): MatchDraft => ({ key: crypto.randomUUID(), invoiceLineId: "", receiptLineId: "", quantity: "" });

export function ProcurementSupplierAdjustmentDialog({ data, detail, intent, onClose, onChanged }: {
  data: ProcurementWorkspaceView; detail: InvoiceReconciliationDetail; intent: ReconciliationFormIntent; onClose(): void; onChanged(): void;
}) {
  const externalForm = useMemo<ProcurementExternalForm>(() => ({ kind: "invoice_reconcile", targetId: detail.invoiceId,
    render: props => <SupplierAdjustmentForm detail={detail} intent={intent} {...props} /> }), [detail, intent]);
  return <ProcurementCycleDialog data={data} externalForm={externalForm} onClose={onClose} onChanged={onChanged} />;
}

function SupplierAdjustmentForm({ detail, intent, disabled, onPrepare, onClose }: {
  detail: InvoiceReconciliationDetail; intent: ReconciliationFormIntent; disabled: boolean;
  onPrepare(input: PrepareProcurementCommand): Promise<void>; onClose(): void;
}) {
  const [source] = useState(detail), [key] = useState(() => crypto.randomUUID());
  const [documentKind, setDocumentKind] = useState<"credit_note" | "debit_note">("credit_note"), [currency, setCurrency] = useState(source.balance.currency);
  const [number, setNumber] = useState(""), [issuedAt, setIssuedAt] = useState(() => localDateTime()), [reference, setReference] = useState(""), [reason, setReason] = useState("");
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [lines, setLines] = useState<AdjustmentDraft[]>(() => source.balance.lines.map(line => ({ invoiceLineId: line.invoiceLineId, selected: false, quantity: "0", amount: "" })));
  const [matches, setMatches] = useState<MatchDraft[]>(() => [newMatch()]);
  const [frozen, setFrozen] = useState<PrepareProcurementCommand | null>(null), [working, setWorking] = useState(false), [error, setError] = useState("");
  const active = useRef(true), busy = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const changed = detail.invoiceId !== source.invoiceId || detail.fingerprint !== source.fingerprint;
  const adjustmentId = intent.action === "adjustment_review" ? intent.adjustmentId : null;
  const adjustment = source.adjustments.find(row => row.id === adjustmentId);
  const allowed = intent.action === "adjustment_record" ? detail.canRecord : detail.canApprove && (intent.action !== "adjustment_review" || adjustment?.status === "pending");
  const patchLine = (id: string, patch: Partial<AdjustmentDraft>) => setLines(previous => previous.map(line => line.invoiceLineId === id ? { ...line, ...patch } : line));
  const patchMatch = (id: string, patch: Partial<MatchDraft>) => setMatches(previous => previous.map(line => line.key === id ? { ...line, ...patch } : line));
  let total: number | null = null;
  try { const selected = lines.filter(line => line.selected); if (selected.length) total = sumProcurementMinor(selected.map(line => moneyMinor(line.amount, currency))); } catch { /* The submit shows the exact field error. */ }
  const build = (form: FormData): PrepareProcurementCommand => {
    const common = { expectedFingerprint: source.fingerprint, idempotencyKey: key, reason: formText(form, "reason") };
    if (intent.action === "adjustment_review") return PrepareProcurementCommandSchema.parse({ kind: "invoice_reconcile", targetId: source.invoiceId,
      input: { ...common, action: "adjustment_review", adjustmentId: intent.adjustmentId, decision } });
    if (intent.action === "receipt_match") return PrepareProcurementCommandSchema.parse({ kind: "invoice_reconcile", targetId: source.invoiceId,
      input: { ...common, action: "receipt_match", lines: matches.map(row => {
        const invoice = source.balance.lines.find(line => line.invoiceLineId === row.invoiceLineId), receipt = source.receipts.find(line => line.receiptLineId === row.receiptLineId);
        if (!invoice?.unit || !receipt || receipt.lineKey !== invoice.lineKey || receipt.unit !== invoice.unit) throw new Error("请选择同一原发票明细和单位一致的实际收货行");
        const quantity = readProcurementQuantity(row.quantity, invoice.unit);
        if (invoice.unallocatedQuantity === null || receipt.availableQuantity === null) throw new Error("原数量分配依据待核对 暂不能匹配");
        if (compareStockQuantity(quantity, invoice.unallocatedQuantity) > 0 || compareStockQuantity(quantity, receipt.availableQuantity) > 0) throw new Error("本次匹配数量超过原票未匹配数量或实际收货可用数量");
        return { invoiceLineId: invoice.invoiceLineId, receiptLineId: receipt.receiptLineId, quantity, unit: invoice.unit };
      }) } });
    return PrepareProcurementCommandSchema.parse({ kind: "invoice_reconcile", targetId: source.invoiceId, input: { ...common, action: "adjustment_record",
      document: { kind: documentKind, number: formText(form, "documentNumber"), issuedAt: formDate(form, "issuedAt"), currency, evidenceReference: formText(form, "evidenceReference") },
      lines: lines.filter(row => row.selected).map(row => {
        const line = source.balance.lines.find(item => item.invoiceLineId === row.invoiceLineId);
        if (!line?.unit) throw new Error("原发票单位待核对 不能推测调整单位");
        let quantity: StockQuantity;
        try { quantity = NonnegativeStockQuantitySchema.parse(documentKind === "debit_note" ? "0" : row.quantity.trim()); }
        catch { throw new Error("调整数量须为非负数且最多9位小数 不使用科学计数法"); }
        if (!stockQuantityMatchesUnit(quantity, line.unit)) throw new Error("件、对和套的调整数量必须为整数");
        const amountMinor = moneyMinor(row.amount, currency);
        if (compareStockQuantity(quantity, 0) === 0 && amountMinor === 0) throw new Error("选中的调整行至少填写一项实际数量或金额");
        return { invoiceLineId: line.invoiceLineId, quantity, unit: line.unit, amountMinor };
      }) } });
  };
  return <form className="record-form procurement-cycle-form procurement-reconciliation-form" aria-label={reconciliationActionNames[intent.action]} onSubmit={async event => {
    event.preventDefault(); if (busy.current || disabled || !allowed || changed && !frozen) return;
    try {
      const original = frozen ?? build(new FormData(event.currentTarget));
      busy.current = true; setWorking(true); setError("");
      try { await onPrepare(original); }
      catch (failure) { if (active.current && failure instanceof ProcurementCommandRequestError && (failure.status === 0 || failure.status >= 500)) setFrozen(original); throw failure; }
    } catch (failure) { if (active.current && !procurementCommandDenied(failure)) setError(failure instanceof ProcurementCommandRequestError ? failure.message : procurementPrecisionMessage(failure, "请填写真实单据、处理依据及至少一行有效调整")); }
    finally { busy.current = false; if (active.current) setWorking(false); }
  }}><h3>{reconciliationActionNames[intent.action]}</h3><p>{source.invoiceNumber} · {source.purchaseOrderCode}</p>
    <p className="record-help">先保存原填写 核对后执行 保存后可从本人采购原提交继续恢复 关闭不会取消已保存的准备</p>
    {changed && <p className="record-notice error" role="alert">原发票实际依据已变化 原填写不会自动改绑 {frozen ? "请先重新读取原提交" : "请关闭后核对当前记录"}</p>}
    {!allowed && <p className="record-notice error" role="alert">{detail.blockReason ?? "当前权限或调整状态不允许此操作"}</p>}
    {error && <p className="record-notice error" role="alert">{error}</p>}
    {frozen && <p className="record-notice" role="status">保存结果待核对 已固定原填写、原依据与原提交键 请先重新读取原提交 重试仍是同一笔</p>}
    <fieldset className="record-fields" disabled={disabled || working} inert={Boolean(frozen) || changed || !allowed} aria-disabled={Boolean(frozen) || changed || !allowed}>
      {intent.action === "adjustment_record" && <><div className="record-grid"><Field label="供应商单据类型"><select value={documentKind} onChange={event => { const kind = event.target.value as typeof documentKind; setDocumentKind(kind); if (kind === "debit_note") { setLines(previous => previous.map(line => ({ ...line, quantity: "0" }))); setError("金额补差只登记金额 已清空调整数量 补开数量请登记新实际发票"); } }}><option value="credit_note">供应商贷项单</option><option value="debit_note">供应商金额补差单</option></select></Field><Field label="供应商单据编号"><input name="documentNumber" required maxLength={100} value={number} onChange={event => setNumber(event.target.value)} /></Field><Field label="单据开具时间"><input name="issuedAt" required type="datetime-local" value={issuedAt} onChange={event => setIssuedAt(event.target.value)} /></Field><Field label="调整单据币种"><select value={currency} onChange={event => { setCurrency(event.target.value); setLines(previous => previous.map(line => ({ ...line, amount: "" }))); setError("单据币种已变化 已清空调整金额 请按真实单据重新填写 不会自动换汇"); }}>{[...new Set([currency, source.balance.currency, "CNY", "USD", "EUR", "GBP", "JPY", "KWD"])].map(value => <option key={value}>{value}</option>)}</select></Field></div>
        <Field label="供应商凭证引用" help="填写实际单据的档案引用或文件编号 本人录入不等于外部验真"><textarea name="evidenceReference" required maxLength={2000} value={reference} onChange={event => setReference(event.target.value)} /></Field>
        {source.balance.lines.map((original, index) => { const row = lines.find(line => line.invoiceLineId === original.invoiceLineId)!; return <section className="record-line" key={row.invoiceLineId} aria-label={`调整明细 ${index + 1}`}><label className="procurement-reconciliation-check"><input type="checkbox" checked={row.selected} disabled={!original.unit} onChange={event => patchLine(row.invoiceLineId, { selected: event.target.checked })} />调整 {original.lineKey} · {original.unit ? unitNames[original.unit] : "原单位待核对"}</label><p className="record-help">原票净数量 {formatStockQuantity(original.netQuantity)} · 尚未匹配 {original.unallocatedQuantity === null ? "待核对" : formatStockQuantity(original.unallocatedQuantity)}</p>{row.selected && <div className="record-grid"><Field label="调整数量" help={documentKind === "debit_note" ? "金额补差数量固定为0 不重复占用收货" : "仅填真实贷项冲减数量 纯价差填0 先冲减未匹配部分"}><input type="text" inputMode="decimal" required maxLength={41} readOnly={documentKind === "debit_note"} value={row.quantity} onChange={event => patchLine(row.invoiceLineId, { quantity: event.target.value })} /></Field><Field label={`调整金额（${currency}）`} help="填写实际非负金额 增减由单据类型决定 不自动四舍五入"><input type="text" inputMode="decimal" required maxLength={40} value={row.amount} onChange={event => patchLine(row.invoiceLineId, { amount: event.target.value })} /></Field></div>}</section>; })}
        <p className="record-totals">本张调整金额 {total === null ? "选择明细后填写" : currency + " " + formatMinorAmount(total, currency)}</p><p className="record-help">登记后先成为待审核单据 批准后才计入实际余额 供应商单据引用尚未经外部验真</p>
      </>}
      {intent.action === "adjustment_review" && <>{adjustment && <ProcurementSupplierAdjustmentSummary adjustment={adjustment} />}<Field label="调整审核决定"><select value={decision} onChange={event => setDecision(event.target.value as typeof decision)}><option value="approved">批准这笔调整</option><option value="rejected">拒绝这笔调整</option></select></Field><p className="record-help">批准后才按此真实单据调整余额 拒绝保留原记录 确认原提交结果不会替代本次审核</p></>}
      {intent.action === "receipt_match" && <><p className="record-help">将原票尚未匹配数量关联到原采购版本的实际收货 原收货分配事实继续保留 库存数量保持原记录</p>{matches.map((row, index) => {
        const invoice = source.balance.lines.find(line => line.invoiceLineId === row.invoiceLineId), receipts = source.receipts.filter(line => invoice?.unit && line.lineKey === invoice.lineKey && line.unit === invoice.unit && line.availableQuantity !== null && compareStockQuantity(line.availableQuantity, 0) > 0);
        return <section className="record-line" key={row.key} aria-label={`收货匹配 ${index + 1}`}><header><strong>匹配明细 {index + 1}</strong><button type="button" disabled={matches.length === 1} aria-label={`移除收货匹配 ${index + 1}`} onClick={() => setMatches(previous => previous.filter(line => line.key !== row.key))}><Trash2 size={14} /></button></header><div className="record-grid"><Field label="匹配发票行"><select required value={row.invoiceLineId} onChange={event => patchMatch(row.key, { invoiceLineId: event.target.value, receiptLineId: "", quantity: "" })}><option value="">选择原发票明细</option>{source.balance.lines.filter(line => line.unit && line.unallocatedQuantity !== null && compareStockQuantity(line.unallocatedQuantity, 0) > 0).map(line => <option key={line.invoiceLineId} value={line.invoiceLineId}>{line.lineKey} · 未匹配 {formatStockQuantity(line.unallocatedQuantity!)} {line.unit ? unitNames[line.unit] : ""}</option>)}</select></Field><Field label="实际收货行"><select required value={row.receiptLineId} onChange={event => patchMatch(row.key, { receiptLineId: event.target.value, quantity: "" })}><option value="">选择实际可用收货</option>{receipts.map(line => <option key={line.receiptLineId} value={line.receiptLineId}>{line.lineKey} · 可用 {formatStockQuantity(line.availableQuantity!)} {unitNames[line.unit]} · {line.receiptLineId}</option>)}</select></Field><Field label="本次匹配数量" help={invoice?.unit ? `原采购单位 ${unitNames[invoice.unit]} 最多9位小数` : "先选择原发票行"}><input type="text" inputMode="decimal" required maxLength={41} value={row.quantity} onChange={event => patchMatch(row.key, { quantity: event.target.value })} /></Field></div></section>;
      })}<button type="button" disabled={matches.length >= 200} onClick={() => setMatches(previous => [...previous, newMatch()])}><Plus size={14} />增加收货匹配</button></>}
      <Field label="处理依据" help="说明真实单据、审核决定或收货匹配依据"><textarea name="reason" required maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} /></Field>
    </fieldset>
    <footer><button type="button" data-record-cancel disabled={disabled || working} onClick={onClose}>返回发票差异</button><button type="submit" className="primary" disabled={disabled || working || !allowed || changed && !frozen}><Check size={14} />{working ? "正在保存原填写" : frozen ? "重试保存原处理" : "保存原处理并核对"}</button></footer>
  </form>;
}
