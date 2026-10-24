"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import type { ProcurementWorkspaceView } from "@yummyai/contracts/procurement";
import { PrepareProcurementCommandSchema, type PrepareProcurementCommand, type ProcurementCommandKind } from "@yummyai/contracts/procurement/procurement-command";
import { Field, RecordSelect } from "../manual-operations/record-form";
import { MasterRecordDialog, mergeRecords, type MasterKind } from "../manual-operations/master-record-dialog";
import { useOwnedViewTransition } from "../navigation/use-owned-view-transition";
import { PositiveStockQuantitySchema } from "@yummyai/contracts/inventory/quantity-schema";
import { compareStockQuantity, formatStockQuantity, stockQuantityString, stockQuantityMatchesUnit, type StockQuantity } from "@yummyai/contracts/inventory/quantity";
import { formatMinorAmount } from "@yummyai/contracts/common/money";
import { pinProcurementStockBasis, procurementAmountMinor, sumProcurementMinor, type ProcurementUnit, type ProcurementStockBasis } from "@yummyai/contracts/procurement/measurement";
import { formDate, formText, localDateTime, moneyMinor, unitNames } from "../manual-operations/operation-types";
import { ProcurementCommandRequestError, procurementCommandDenied } from "../../lib/procurement-command-client";
import "./procurement-precision.css";

export const procurementActionNames: Record<ProcurementCommandKind, string> = {
  requisition_create: "新增采购申请", rfq_create: "创建询价", quote_record: "录入供应商报价", purchase_create: "新增采购单",
  supply_purchase_create: "按商品供货建采购单", purchase_revise: "修订采购草稿", purchase_review: "审核采购单", invoice_record: "登记实际发票", invoice_reconcile: "处理发票差异",
};
export const procurementCommandStatusNames = { prepared: "待核对执行", succeeded: "实际操作已完成", cancelled: "准备已取消", expired: "原填写已到期" };
export type ProcurementCycleDraft = { id: string; kind: Exclude<ProcurementCommandKind, "supply_purchase_create" | "invoice_record" | "invoice_reconcile">; targetId: string | null; quoteId?: string };
type DraftLine = { key: string; stockId: string; locationId: string; quantity: string; cost: string; unit: ProcurementUnit | ""; basis: string };
const newLine = (): DraftLine => ({ key: `L-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, stockId: "", locationId: "", quantity: "", cost: "", unit: "", basis: "" });
export function procurementPrecisionMessage(error: unknown, fallback = "请核对数量、单位、金额和计价数量") {
  if (error instanceof Error) {
    if (/[\u3400-\u9fff]/.test(error.message)) return error.message;
    const messages: Record<string, string> = {
      procurement_amount_precision_unavailable: "本行金额不足一个最小币种单位 请核对数量、报价金额和计价数量 系统不会自动四舍五入",
      procurement_money_out_of_range: "合计金额超出可保存范围 请核对数量和报价金额",
      procurement_unit_conversion_unavailable: "采购单位与库存单位不能换算 仅支持相同单位或克与千克",
      procurement_converted_quantity_invalid: "换算后的库存数量超出范围或不符合库存单位 请核对",
      procurement_quantity_invalid: "数量须为正数且最多9位小数 件、对和套须为整数",
    };
    if (messages[error.message]) return messages[error.message]!;
  }
  return fallback;
}
export function readProcurementQuantity(text: string, unit: ProcurementUnit): StockQuantity {
  let quantity: StockQuantity;
  try { quantity = PositiveStockQuantitySchema.parse(text.trim()); }
  catch { throw new Error("数量须为正数且不超过2147483647 最多9位小数 不使用科学计数法"); }
  if (!stockQuantityMatchesUnit(quantity, unit)) throw new Error("件、对和套的数量与计价数量必须为整数");
  return quantity;
}
export function ProcurementMeasure({ quantity, unit, stockBasis, quantityLabel = "采购" }: { quantity: StockQuantity; unit: ProcurementUnit; stockBasis?: ProcurementStockBasis | null; quantityLabel?: string }) {
  return <p className="procurement-measure-check"><span>{quantityLabel} {formatStockQuantity(quantity)} {unitNames[unit]}</span><span>{stockBasis ? `库存 ${formatStockQuantity(stockBasis.stockQuantity)} ${unitNames[stockBasis.stockUnit]} · 1 ${unitNames[unit]} = ${stockBasis.conversionNumerator}/${stockBasis.conversionDenominator} ${unitNames[stockBasis.stockUnit]}` : "原库存换算依据未留存 请核对"}</span></p>;
}

export function ProcurementCycleForm({ draft, data: sourceData, disabled, onPrepare, onClose }: {
  draft: ProcurementCycleDraft; data: ProcurementWorkspaceView; disabled: boolean;
  onPrepare(input: PrepareProcurementCommand, sources?: ProcurementWorkspaceView): Promise<void>; onClose(): void;
}) {
  const [extraSuppliers, setExtraSuppliers] = useState<ProcurementWorkspaceView["suppliers"]>([]), [extraStock, setExtraStock] = useState<ProcurementWorkspaceView["stockItems"]>([]), [extraLocations, setExtraLocations] = useState<ProcurementWorkspaceView["locations"]>([]);
  const [creating, setCreating] = useState<{ kind: MasterKind; lineKey?: string }>(), transition = useOwnedViewTransition();
  const data = useMemo(() => ({ ...sourceData, suppliers: mergeRecords(sourceData.suppliers, extraSuppliers), stockItems: mergeRecords(sourceData.stockItems, extraStock), locations: mergeRecords(sourceData.locations, extraLocations) }), [sourceData, extraSuppliers, extraStock, extraLocations]);
  const order = data.purchaseOrders.find(row => row.id === draft.targetId);
  const [requestKey] = useState(() => crypto.randomUUID()), [code] = useState(() => `${draft.kind === "requisition_create" ? "REQ" : "PO"}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`);
  const [targetId, setTargetId] = useState(draft.targetId ?? ""), [quoteId, setQuoteId] = useState(draft.quoteId ?? order?.quoteId ?? "");
  const [supplierId, setSupplierId] = useState(order?.supplierId ?? ""), [supplierIds, setSupplierIds] = useState<string[]>([]), [currency, setCurrency] = useState(order?.currency ?? "CNY");
  const [lines, setLines] = useState<DraftLine[]>(() => order ? order.lines.map(row => ({ key: row.lineKey, stockId: row.stockItemId, locationId: row.destinationLocationId, quantity: stockQuantityString(row.quantity), cost: formatMinorAmount(row.unitCostMinor, order.currency), unit: row.unit, basis: row.priceBasisQuantity === undefined ? "" : stockQuantityString(row.priceBasisQuantity) })) : [newLine()]);
  const [working, setWorking] = useState(false), [error, setError] = useState(""), [frozen, setFrozen] = useState<PrepareProcurementCommand | null>(null);
  const [removed, setRemoved] = useState(false), active = useRef(true), busy = useRef(false);
  const [quoteTerms, setQuoteTerms] = useState<Record<string, { cost: string; minimum: string; lead: string; basis: string }>>({});
  const [measureNotice, setMeasureNotice] = useState("");
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const rfq = data.rfqs.find(row => row.id === targetId), requisition = data.requisitions.find(row => row.id === (draft.kind === "rfq_create" ? targetId : rfq?.requisitionId));
  const quote = data.quotes.find(row => row.id === quoteId), quoteRfq = data.rfqs.find(row => row.id === quote?.rfqId), quoteRequest = data.requisitions.find(row => row.id === quoteRfq?.requisitionId);
  const activeSuppliers = data.suppliers.filter(row => row.status === "active");
  const activeStock = data.stockItems.filter(row => row.status !== "inactive"), activeLocations = data.locations.filter(row => row.status !== "inactive");
  const latestQuotes = data.quotes.filter(row => !data.quotes.some(other => other.rfqId === row.rfqId && other.supplierId === row.supplierId && other.version > row.version));
  const selectQuote = (id: string) => {
    setQuoteId(id);
    const selected = data.quotes.find(row => row.id === id), source = data.rfqs.find(row => row.id === selected?.rfqId), request = data.requisitions.find(row => row.id === source?.requisitionId);
    if (!selected) { setSupplierId(""); setLines([newLine()]); return; }
    setSupplierId(selected.supplierId); setCurrency(selected.currency);
    setLines(request?.lines.map(row => ({ key: row.lineKey, stockId: row.stockItemId, locationId: row.destinationLocationId,
      quantity: stockQuantityString(compareStockQuantity(row.quantity, selected.lines.find(item => item.lineKey === row.lineKey)?.minimumOrderQuantity ?? 1) >= 0 ? row.quantity : selected.lines.find(item => item.lineKey === row.lineKey)!.minimumOrderQuantity),
      unit: row.unit, basis: selected.lines.find(item => item.lineKey === row.lineKey)?.priceBasisQuantity === undefined ? "" : stockQuantityString(selected.lines.find(item => item.lineKey === row.lineKey)!.priceBasisQuantity!),
      cost: formatMinorAmount(selected.lines.find(item => item.lineKey === row.lineKey)?.unitCostMinor ?? 0, selected.currency) })) ?? []);
  };
  const initialQuote = useRef(draft.quoteId);
  useEffect(() => { if (initialQuote.current) { const id = initialQuote.current; initialQuote.current = undefined; selectQuote(id); } });
  useEffect(() => {
    let changed = false;
    if (targetId && (draft.kind === "rfq_create" ? !data.requisitions.some(row => row.id === targetId) : draft.kind === "quote_record" ? !data.rfqs.some(row => row.id === targetId) : ["purchase_revise", "purchase_review"].includes(draft.kind) && !data.purchaseOrders.some(row => row.id === targetId))) { setTargetId(""); changed = true; }
    if (quoteId && !data.quotes.some(row => row.id === quoteId)) { setQuoteId(""); changed = true; }
    if (supplierId && !data.suppliers.some(row => row.id === supplierId)) { setSupplierId(""); changed = true; }
    const allowed = supplierIds.filter(id => activeSuppliers.some(row => row.id === id));
    if (allowed.length !== supplierIds.length) { setSupplierIds(allowed); changed = true; }
    if (lines.some(row => row.stockId && !data.stockItems.some(item => item.id === row.stockId) || row.locationId && !data.locations.some(item => item.id === row.locationId))) {
      setLines(rows => rows.map(row => ({ ...row, stockId: data.stockItems.some(item => item.id === row.stockId) ? row.stockId : "", locationId: data.locations.some(item => item.id === row.locationId) ? row.locationId : "" }))); changed = true;
    }
    if (changed) setRemoved(true);
  }, [data, targetId, quoteId, supplierId, supplierIds, lines, activeSuppliers, draft.kind]);
  const invalidSource = draft.kind === "rfq_create" ? !requisition || requisition.status !== "draft" : draft.kind === "quote_record" ? !rfq || rfq.status !== "open" || !requisition || requisition.currentVersion !== rfq.requisitionVersion :
    ["purchase_revise", "purchase_review"].includes(draft.kind) ? !order || !["draft", "rejected"].includes(order.status) : Boolean(quoteId && (!quote || !quoteRfq || !quoteRequest || quoteRequest.currentVersion !== quoteRfq.requisitionVersion));
  const update = (key: string, patch: Partial<DraftLine>) => setLines(rows => rows.map(row => row.key === key ? { ...row, ...patch } : row));
  const selectStock = (key: string, id: string) => {
    const unit = data.stockItems.find(item => item.id === id)?.baseUnit ?? "";
    setLines(rows => rows.map(row => row.key !== key ? row : { ...row, stockId: id, unit, ...(row.unit && row.unit !== unit ? { quantity: "", cost: "", basis: "" } : {}) }));
    setMeasureNotice("已选择物料 请核对采购单位 换单位时原数量和报价金额会清空");
  };
  const changeCurrency = (next: string) => {
    if (next !== currency) { setLines(rows => rows.map(row => ({ ...row, cost: "" }))); setQuoteTerms(rows => Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, { ...row, cost: "" }]))); setMeasureNotice("币种已变化 已清空原报价金额 请按新币种重新核对"); }
    setCurrency(next);
  };
  const build = (form: FormData): unknown => {
    if (draft.kind === "requisition_create") return { kind: draft.kind, targetId: null, input: { code: formText(form, "code").toUpperCase(), reasonCode: formText(form, "reasonCode"), lines: buildLines(false), idempotencyKey: requestKey } };
    if (draft.kind === "rfq_create") return { kind: draft.kind, targetId, input: { expectedRequisitionVersion: requisition?.currentVersion, supplierIds, responseDueAt: formDate(form, "responseDueAt"), idempotencyKey: requestKey } };
    if (draft.kind === "quote_record") {
      const quotedLines = requisition?.lines.map(row => {
        const terms = quoteTerms[row.lineKey], minimumOrderQuantity = readProcurementQuantity(terms?.minimum ?? "1", row.unit);
        const unitCostMinor = moneyMinor(terms?.cost ?? "", currency), priceBasisQuantity = terms?.basis ? readProcurementQuantity(terms.basis, row.unit) : undefined;
        procurementAmountMinor(compareStockQuantity(row.quantity, minimumOrderQuantity) >= 0 ? row.quantity : minimumOrderQuantity, unitCostMinor, priceBasisQuantity ?? 1);
        return { lineKey: row.lineKey, unitCostMinor, minimumOrderQuantity, ...(priceBasisQuantity === undefined ? {} : { priceBasisQuantity }), leadTimeDays: Number(terms?.lead || "0") };
      });
      if (quotedLines) sumProcurementMinor(quotedLines.map(row => { const requestLine = requisition!.lines.find(line => line.lineKey === row.lineKey)!; return procurementAmountMinor(compareStockQuantity(requestLine.quantity, row.minimumOrderQuantity) >= 0 ? requestLine.quantity : row.minimumOrderQuantity, row.unitCostMinor, row.priceBasisQuantity ?? 1); }));
      return { kind: draft.kind, targetId, input: { supplierId, currency, validUntil: formDate(form, "validUntil"), lines: quotedLines, idempotencyKey: requestKey } };
    }
    if (draft.kind === "purchase_review") return { kind: draft.kind, targetId, input: { expectedVersion: order?.currentVersion, decision: formText(form, "decision"), reasonCode: formText(form, "reasonCode"), idempotencyKey: requestKey } };
    const input = { currency: quote?.currency ?? currency, expectedAt: formDate(form, "expectedAt"), lines: buildLines(true), idempotencyKey: requestKey };
    if (draft.kind === "purchase_revise") return { kind: draft.kind, targetId, input: { ...input, expectedVersion: order?.currentVersion } };
    return { kind: draft.kind, targetId: null, input: { ...input, code: formText(form, "code").toUpperCase(), supplierId: quote?.supplierId ?? supplierId, requisitionId: quoteId ? quoteRequest?.id ?? null : null, quoteId: quoteId || null } };
  };
  function buildLines(withPrice: boolean) {
    const result = lines.map(row => {
      const stock = data.stockItems.find(item => item.id === row.stockId);
      if (!stock || !row.unit) throw new Error("请先选择物料并核对采购单位");
      const quantity = readProcurementQuantity(row.quantity, row.unit), basis = row.basis ? readProcurementQuantity(row.basis, row.unit) : undefined;
      const line = { lineKey: row.key, stockItemId: row.stockId, destinationLocationId: row.locationId, quantity, unit: row.unit };
      pinProcurementStockBasis({ ...line, ...(basis === undefined ? {} : { priceBasisQuantity: basis }) }, stock.baseUnit);
      if (!withPrice) return line;
      const sourcePrice = quote?.lines.find(item => item.lineKey === row.key);
      if (sourcePrice && compareStockQuantity(quantity, sourcePrice.minimumOrderQuantity) < 0) throw new Error("采购数量低于原报价起订量 请核对采购单位和数量");
      const unitCostMinor = sourcePrice?.unitCostMinor ?? moneyMinor(row.cost, quote?.currency ?? currency);
      procurementAmountMinor(quantity, unitCostMinor, basis ?? 1);
      return { ...line, unitCostMinor, ...(basis === undefined ? {} : { priceBasisQuantity: basis }) };
    });
    if (withPrice) sumProcurementMinor(result.map(row => "unitCostMinor" in row ? procurementAmountMinor(row.quantity, row.unitCostMinor!, "priceBasisQuantity" in row ? row.priceBasisQuantity ?? 1 : 1) : 0));
    return result;
  }
  const quoted = Boolean(quoteId), purchase = draft.kind === "purchase_create" || draft.kind === "purchase_revise", request = draft.kind === "requisition_create";
  let total: number | null = null, totalError = "";
  try { if (purchase && lines.every(row => row.quantity && row.cost && row.unit)) total = sumProcurementMinor(lines.map(row => procurementAmountMinor(readProcurementQuantity(row.quantity, row.unit as ProcurementUnit), moneyMinor(row.cost, quote?.currency ?? currency), row.basis ? readProcurementQuantity(row.basis, row.unit as ProcurementUnit) : 1))); }
  catch (failure) { totalError = procurementPrecisionMessage(failure); }
  return <><form className="record-form procurement-cycle-form" aria-label={procurementActionNames[draft.kind]} onSubmit={async event => {
    event.preventDefault(); if (busy.current || disabled || invalidSource) return;
    try {
      const original = frozen ?? PrepareProcurementCommandSchema.parse(build(new FormData(event.currentTarget)));
      busy.current = true; setWorking(true); setError("");
      try { await onPrepare(original, data); }
      catch (failure) { if (failure instanceof ProcurementCommandRequestError && (failure.status === 0 || failure.status >= 500)) setFrozen(original); throw failure; }
    } catch (failure) { if (active.current && !procurementCommandDenied(failure)) setError(failure instanceof ProcurementCommandRequestError ? failure.message : procurementPrecisionMessage(failure, "请核对必填字段、数量、采购单位、日期和报价明细")); }
    finally { busy.current = false; if (active.current) setWorking(false); }
  }}>
    <h3>{procurementActionNames[draft.kind]}</h3>
    <p className="record-help">先保存本次原填写 核对后执行 {purchase ? "采购单保存为草稿 不会发送给供应商" : "不会联系供应商或自动下单"}</p>
    {error && <p className="record-notice error" role="alert">{error}</p>}
    {measureNotice && <p className="record-notice" role="status">{measureNotice}</p>}
    {removed && <p className="record-notice error" role="alert">部分原选项已不可读取 已清空对应选择 请重新核对</p>}
    {invalidSource && <p className="record-notice error" role="alert">原采购依据已变化或不可读取 请返回采购工作区重新读取后填写</p>}
    {frozen && <p className="record-notice" role="status">保存结果待核对 已固定本次原填写 请读取待核对记录 或重试同一笔原提交</p>}
    <fieldset className="record-fields" disabled={working || disabled} inert={Boolean(frozen)} aria-disabled={Boolean(frozen)}>
      {(request || draft.kind === "purchase_create") && <Field label={request ? "采购申请号" : "采购单号"}><input required name="code" defaultValue={code} maxLength={64} pattern={"[A-Za-z0-9][A-Za-z0-9._\\-]*"} /></Field>}
      {request && <Field label="采购原因"><select name="reasonCode"><option value="REPLENISHMENT">库存补货</option><option value="CUSTOM_ORDER">定制订单</option><option value="FBA_REPLENISHMENT">FBA 备货</option><option value="OTHER">其他采购需求</option></select></Field>}
      {draft.kind === "rfq_create" && <>
        <RecordSelect label="采购申请" value={targetId} onChange={id => { setTargetId(id); setSupplierIds([]); }} options={data.requisitions.filter(row => row.status === "draft").map(row => ({ id: row.id, label: `${row.code} · v${row.currentVersion}` }))} />
        {requisition && <p className="record-help">依据 {requisition.code} v{requisition.currentVersion} · {requisition.lines.length} 个物料行</p>}
        <div className="procurement-cycle-suppliers" role="group" aria-label="询价供应商"><strong>询价供应商</strong><p className="record-help">选择 1 至 20 个现有供应商 仅保存询价记录</p>{activeSuppliers.map(row => <label key={row.id}><input type="checkbox" checked={supplierIds.includes(row.id)} disabled={!supplierIds.includes(row.id) && supplierIds.length >= 20} onChange={event => setSupplierIds(ids => event.target.checked ? [...ids, row.id] : ids.filter(id => id !== row.id))} />{row.name} · {row.settlementCurrency}</label>)}{!activeSuppliers.length && <p className="record-help">没有可用供应商 请先维护供应商档案</p>}</div>
        <Field label="询价截止时间"><input required type="datetime-local" name="responseDueAt" /></Field>
      </>}
      {draft.kind === "quote_record" && <>
        <RecordSelect label="询价记录" value={targetId} onChange={id => { setTargetId(id); setSupplierId(""); setQuoteTerms({}); }} options={data.rfqs.filter(row => row.status === "open").map(row => ({ id: row.id, label: `${data.requisitions.find(item => item.id === row.requisitionId)?.code ?? "原申请当前不可读取"} · 询价 ${row.createdAt.slice(0, 10)}` }))} />
        <RecordSelect label="报价供应商" value={supplierId} onChange={id => { setSupplierId(id); changeCurrency(data.suppliers.find(row => row.id === id)?.settlementCurrency ?? "CNY"); }} options={activeSuppliers.filter(row => rfq?.supplierIds.includes(row.id)).map(row => ({ id: row.id, label: row.name }))} />
        <div className="record-grid"><Currency value={currency} onChange={changeCurrency} /><Field label="报价有效截止时间"><input required name="validUntil" type="datetime-local" /></Field></div>
        <p className="record-help">按实际供应商报价手工录入 每个原物料行分别填写单价、最低起订量和交期</p>
        {requisition?.lines.map((row, index) => { const terms = quoteTerms[row.lineKey] ?? { cost: "", minimum: "1", lead: "0", basis: "" }; const change = (patch: Partial<typeof terms>) => setQuoteTerms(values => ({ ...values, [row.lineKey]: { ...terms, ...patch } }));
          return <section className="record-line" key={row.lineKey} aria-label={`报价明细 ${index + 1}`}><header><strong>{data.stockItems.find(item => item.id === row.stockItemId)?.name ?? "原物料当前不可读取"}</strong><span>{row.lineKey}</span></header><p className="record-help">申请 {formatStockQuantity(row.quantity)} {unitNames[row.unit]} · 报价沿用原申请单位 · {data.locations.find(item => item.id === row.destinationLocationId)?.name ?? "原库位当前不可读取"}</p><div className="record-grid"><Field label={`报价单价（${currency}）`} help="此金额对应下方计价数量"><input required type="text" inputMode="decimal" autoComplete="off" maxLength={40} value={terms.cost} onChange={event => change({ cost: event.target.value })} /></Field><Field label={`计价数量（${unitNames[row.unit]}）`} help="留空按1计算 不会向原提交补写默认值"><input type="text" inputMode="decimal" maxLength={41} placeholder="1" value={terms.basis} onChange={event => change({ basis: event.target.value })} /></Field><Field label="最低起订量" help={`采购单位 ${unitNames[row.unit]}`}><input required type="text" inputMode="decimal" maxLength={41} value={terms.minimum} onChange={event => change({ minimum: event.target.value })} /></Field><Field label="交期天数"><input required type="number" min="0" max="3650" step="1" value={terms.lead} onChange={event => change({ lead: event.target.value })} /></Field></div></section>;
        })}
      </>}
      {draft.kind === "purchase_create" && <RecordSelect label="采购依据" required={false} emptyLabel="直接人工建单" value={quoteId} onChange={selectQuote} options={latestQuotes.map(row => ({ id: row.id, label: `${data.suppliers.find(item => item.id === row.supplierId)?.name ?? "供应商当前不可读取"} · 报价 v${row.version} · ${row.currency} ${formatMinorAmount(row.totalMinor, row.currency)}` }))} />}
      {purchase && <>
        {quoted ? <p className="record-notice">已绑定原询价与报价 v{quote?.version ?? "不可读取"} · 有效至 {quote ? procurementTime(quote.validUntil) : "不可读取"} 物料、库位、采购单位、币种与计价数量沿用原报价 执行时重新核对有效性</p> : draft.kind === "purchase_revise" ? <p className="record-help">供应商 {data.suppliers.find(row => row.id === order?.supplierId)?.name ?? "当前不可读取"} · 原采购 v{order?.currentVersion}</p> : <RecordSelect label="供应商" value={supplierId} onChange={id => { setSupplierId(id); changeCurrency(data.suppliers.find(row => row.id === id)?.settlementCurrency ?? currency); }} options={activeSuppliers.map(row => ({ id: row.id, label: `${row.name} · ${row.settlementCurrency}` }))} onCreate={() => setCreating({ kind: "supplier" })} />}
        <div className="record-grid"><Currency value={quote?.currency ?? currency} onChange={changeCurrency} disabled={quoted} /><Field label="预计到货时间"><input required name="expectedAt" type="datetime-local" defaultValue={order ? localDateTime(new Date(order.expectedAt)) : ""} /></Field></div>
      </>}
      {(purchase || request) && <>
        <p className="record-help">数量最多9位小数 件、对和套须为整数 仅支持同单位或克与千克换算</p>
        <div className="record-lines">{lines.map((row, index) => {
          const stock = data.stockItems.find(item => item.id === row.stockId), units = stock && ["gram", "kilogram"].includes(stock.baseUnit) ? ["gram", "kilogram"] as const : stock ? [stock.baseUnit] : [];
          let preview: ProcurementStockBasis | undefined;
          try { if (row.quantity && row.unit && stock) preview = pinProcurementStockBasis({ quantity: readProcurementQuantity(row.quantity, row.unit), unit: row.unit, ...(row.basis ? { priceBasisQuantity: readProcurementQuantity(row.basis, row.unit) } : {}) }, stock.baseUnit).stockBasis; } catch { /* Submission shows the shared precision error. */ }
          return <section className="record-line" key={row.key} aria-label={`采购明细 ${index + 1}`}><header><strong>采购明细 {index + 1}</strong>{!quoted && lines.length > 1 && <button type="button" aria-label={`移除采购明细 ${index + 1}`} onClick={() => transition.change(() => setLines(values => values.filter(item => item.key !== row.key)))}><Trash2 size={14} />移除</button>}</header>
          {quoted ? <p className="record-help">{stock?.name ?? "原物料当前不可读取"} · {data.locations.find(item => item.id === row.locationId)?.name ?? "原库位当前不可读取"}</p> : <div className="record-grid"><RecordSelect label="物料" value={row.stockId} onChange={id => selectStock(row.key, id)} options={activeStock.map(item => ({ id: item.id, label: `${item.name} · ${item.code}` }))} onCreate={() => setCreating({ kind: "stock", lineKey: row.key })} /><RecordSelect label="收货库位" value={row.locationId} onChange={id => update(row.key, { locationId: id })} options={activeLocations.map(item => ({ id: item.id, label: `${item.name} · ${item.code}` }))} onCreate={() => setCreating({ kind: "location", lineKey: row.key })} /></div>}
          <div className="record-grid"><Field label="采购单位"><select required disabled={quoted || !stock} value={row.unit} onChange={event => { update(row.key, { unit: event.target.value as ProcurementUnit, quantity: "", cost: "", basis: "" }); setMeasureNotice("采购单位已变化 已清空原数量和报价金额 请重新核对"); }}><option value="">请先选择物料</option>{[...new Set([...units, ...(row.unit ? [row.unit] : [])])].map(unit => <option value={unit} key={unit}>{unitNames[unit]}</option>)}</select></Field><Field label="采购数量" help={`${row.unit ? `采购单位 ${unitNames[row.unit]}` : "请先选择物料和采购单位"}${quoted ? ` · 最低起订 ${formatStockQuantity(quote?.lines.find(item => item.lineKey === row.key)?.minimumOrderQuantity ?? 1)}` : ""}`}><input required type="text" inputMode="decimal" autoComplete="off" maxLength={41} value={row.quantity} onChange={event => update(row.key, { quantity: event.target.value })} /></Field>{purchase && <><Field label={`单价（${quote?.currency ?? currency}）`} help="对应本行计价数量"><input required type="text" inputMode="decimal" maxLength={40} readOnly={quoted} value={row.cost} onChange={event => update(row.key, { cost: event.target.value })} /></Field><Field label={`计价数量（${row.unit ? unitNames[row.unit] : "单位待选"}）`} help="留空按1计算"><input type="text" inputMode="decimal" maxLength={41} readOnly={quoted} placeholder="1" value={row.basis} onChange={event => update(row.key, { basis: event.target.value })} /></Field></>}</div>{preview && row.unit && <ProcurementMeasure quantity={preview ? readProcurementQuantity(row.quantity, row.unit) : 0} unit={row.unit} stockBasis={preview} />}</section>;
        })}</div>
        {!quoted && <button disabled={lines.length >= 200} type="button" onClick={() => transition.change(() => setLines(values => [...values, newLine()]))}><Plus size={14} />添加采购明细</button>}
        {purchase && <p className="record-totals">合计 {total === null ? "填写数量、金额和计价数量后计算" : `${quote?.currency ?? currency} ${formatMinorAmount(total, quote?.currency ?? currency)}`}</p>}
        {totalError && <p className="record-notice error" role="alert">{totalError}</p>}
      </>}
      {draft.kind === "purchase_review" && order && <>
        <PurchaseBasis data={data} order={order} />
        <Field label="审核决定"><select name="decision"><option value="approved">批准采购</option><option value="rejected">驳回修改</option></select></Field>
        <Field label="审核依据"><select name="reasonCode"><option value="DETAILS_CONFIRMED">供应商、明细及金额已核对</option><option value="BUDGET_CONFIRMED">预算已确认</option><option value="DETAILS_INCORRECT">资料或数量需修改</option><option value="PRICE_UNCONFIRMED">价格尚未确认</option></select></Field>
      </>}
    </fieldset>
    <footer><button type="button" data-record-cancel disabled={working} onClick={onClose}>返回采购记录</button><button type="submit" className="primary" disabled={working || disabled || invalidSource}><Check size={14} />{working ? "正在保存原填写" : frozen ? "重试保存同一笔原提交" : "保存原填写并核对"}</button></footer>
  </form>{creating && <MasterRecordDialog kind={creating.kind} onClose={() => setCreating(undefined)} onSaved={saved => {
    if (creating.kind === "supplier") { setExtraSuppliers(values => [...values, saved as unknown as ProcurementWorkspaceView["suppliers"][number]]); setSupplierId(String(saved.id)); changeCurrency(String(saved.settlementCurrency)); }
    if (creating.kind === "stock") { const stock = saved as unknown as ProcurementWorkspaceView["stockItems"][number]; setExtraStock(values => [...values, stock]); setLines(rows => rows.map(row => row.key !== creating.lineKey ? row : { ...row, stockId: stock.id, unit: stock.baseUnit, ...(row.unit && row.unit !== stock.baseUnit ? { quantity: "", cost: "", basis: "" } : {}) })); }
    if (creating.kind === "location") { setExtraLocations(values => [...values, saved as unknown as ProcurementWorkspaceView["locations"][number]]); update(creating.lineKey!, { locationId: String(saved.id) }); }
    transition.change(() => setCreating(undefined));
  }} />}</>;
}

function Currency({ value, onChange, disabled }: { value: string; onChange(value: string): void; disabled?: boolean }) {
  return <Field label="采购币种"><select value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>{[...new Set([value, "CNY", "USD", "EUR", "GBP", "CAD", "AUD", "JPY", "KWD"])].map(item => <option key={item}>{item}</option>)}</select></Field>;
}
export const procurementTime = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
export function PurchaseBasis({ data, order }: { data: ProcurementWorkspaceView; order: ProcurementWorkspaceView["purchaseOrders"][number] }) {
  return <section className="procurement-cycle-basis" aria-label="待审核采购版本"><strong>{order.code} · v{order.currentVersion}</strong><p>{data.suppliers.find(row => row.id === order.supplierId)?.name ?? "供应商当前不可读取"} · {order.currency} {formatMinorAmount(order.totalMinor, order.currency)}</p><p>预计到货 {procurementTime(order.expectedAt)}</p><ol>{order.lines.map(row => <li key={row.lineKey}><strong>{data.stockItems.find(item => item.id === row.stockItemId)?.name ?? "原物料当前不可读取"}</strong><ProcurementMeasure quantity={row.quantity} unit={row.unit} stockBasis={row.stockBasis} /><span>报价 {order.currency} {formatMinorAmount(row.unitCostMinor, order.currency)} · {row.priceBasisQuantity === undefined ? "原计价数量未单列 请核对" : `每 ${formatStockQuantity(row.priceBasisQuantity)} ${unitNames[row.unit]}`} · {data.locations.find(item => item.id === row.destinationLocationId)?.name ?? "原库位当前不可读取"}</span></li>)}</ol></section>;
}
