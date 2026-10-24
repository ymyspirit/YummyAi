"use client";

import { useEffect, useId, useRef, useState, type ComponentType } from "react";
import { ArrowLeft, ArrowRight, Plus, Trash2, Upload } from "lucide-react";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { FinanceFactInputSchema, FinanceFactTypeSchema, FinanceProfitCoverageDimensionSchema, FinanceStatementKindSchema,
  FinanceStatementProviderSchema, type FinanceFactInput, type FinanceFactType } from "@yummyai/contracts/finance";
import { FINANCE_CURRENCY_MINOR_DIGITS } from "@yummyai/contracts/finance/currency-snapshot";
import { financeCurrencyMinorDigits, formatFinanceMinorAmount } from "@yummyai/contracts/finance/monetary";
import { PrepareFinanceCommandSchema } from "@yummyai/contracts/finance/finance-command";
import { parseFinancePayableAmount } from "@yummyai/contracts/finance/payables";
import { Field } from "../manual-operations/record-form";
import { formDate, formText, localDateTime } from "../manual-operations/operation-types";
import { useOwnedViewTransition } from "../navigation/use-owned-view-transition";
import type { FinanceCommandFormProps } from "./finance-command-workbench";

export type FinanceRecordKind = "statement_record" | "fx_rate_record" | "metric_upsert" | "profit_calculate";
type RecordProps = { Form: ComponentType<FinanceCommandFormProps>; onClose(): void; onDenied?(message: string): void };
const factNames: Record<FinanceFactType, string> = { sale_revenue: "销售收入", shipping_revenue: "运费收入", marketplace_commission: "平台佣金", advertising_spend: "广告支出", fulfillment_fee: "履约费", storage_fee: "仓储费", refund: "退款", chargeback: "拒付", procurement_cost: "采购成本", production_cost: "生产成本", freight_cost: "运输成本", carrier_cost: "承运成本", tax: "税费", other_fee: "其他费用" };
const providerNames = { amazon: "Amazon", etsy: "Etsy", advertising: "广告服务", carrier: "承运商", supplier: "供应商", tax_authority: "税务来源", manual: "人工核对来源" };
const statementNames = { marketplace_settlement: "平台结算单", advertising_invoice: "广告费用单", fulfillment_invoice: "履约费用单", carrier_invoice: "承运商单据", supplier_invoice: "供应商费用单", tax_statement: "税务单据", operational_cost: "运营费用单", manual_adjustment: "人工纠正单" };
const dimensionNames = { aggregate: "汇总", order: "订单", order_line: "订单行", sku: "SKU", listing: "刊登" };
export function FinanceRecordForms({ kind, ...props }: RecordProps & { kind: FinanceRecordKind }) {
  return kind === "statement_record" ? <StatementForm {...props} /> : kind === "fx_rate_record" ? <FxForm {...props} /> : kind === "metric_upsert" ? <MetricForm {...props} /> : <ProfitForm {...props} />;
}
function positiveInteger(value: string, label: string) {
  if (!/^[1-9][0-9]*$/.test(value) || value.length > 16) throw new Error(`${label}须为可精确保存的正整数`);
  const integer = BigInt(value); if (integer > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label}超出可精确保存范围`);
  return Number(integer);
}
function minorInteger(value: string) {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 16) throw new Error("最小单位金额须为无前零的非负整数");
  const integer = BigInt(value); if (integer > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("原金额超出可精确保存范围");
  return Number(integer);
}
function statementAmount(value: string, currency: string, mode: "major" | "minor") {
  if (mode === "minor") return minorInteger(value.trim());
  const text = value.trim(), digits = financeCurrencyMinorDigits(currency);
  if (digits === null) throw new Error("此币种主单位精度未知 请选择原文整数最小单位 并明确核对来源");
  if (/^0(?:\.0+)?$/.test(text) && (text.split(".")[1]?.length ?? 0) <= digits) return 0;
  try { return parseFinancePayableAmount(text, currency); } catch { throw new Error("金额须符合原币种精度且不超出整数范围 不自动四舍五入"); }
}
function ids(value: string, required: boolean) {
  const values = value.split(/[\s,，]+/).filter(Boolean).map(value => EntityIdSchema.parse(value).toLowerCase());
  if ((required && !values.length) || values.length > 500 || new Set(values).size !== values.length) throw new Error("请选择不重复的真实凭据 ID 每类最多500笔");
  return values;
}

type LineDraft = { key: string; lineKey: string; sourceEntryId: string; factType: FinanceFactType; direction: "credit" | "debit"; amount: string; occurredAt: string; occurredAtIso?: string; externalReference: string; orderId: string; orderLineId: string; skuId: string; listingId: string; supplierId: string; correctionKind: "original" | "reversal" | "replacement"; correctsFactId: string };
const blankLine = (): LineDraft => ({ key: crypto.randomUUID(), lineKey: "", sourceEntryId: "", factType: "other_fee", direction: "debit", amount: "", occurredAt: localDateTime(), externalReference: "", orderId: "", orderLineId: "", skuId: "", listingId: "", supplierId: "", correctionKind: "original", correctsFactId: "" });
const tableColumns = ["lineKey", "sourceEntryId", "factType", "direction", "amountMinor", "currency", "occurredAt", "externalReference", "orderId", "orderLineId", "skuId", "listingId", "supplierId", "correctionKind", "correctsFactId"] as const;
/** Exact TSV table import; no amount, scope or source ID is inferred from row order. */
export function parseFinanceStatementTable(value: string): FinanceFactInput[] {
  if (new TextEncoder().encode(value).byteLength > 28 * 1024 * 1024) throw new Error("原表格超过28MiB 未裁剪或部分导入");
  const rows = value.replace(/^\uFEFF/, "").split(/\r?\n/); while (rows.at(-1) === "") rows.pop();
  if (rows[0] !== tableColumns.join("\t")) throw new Error("表头须与列说明完全一致 使用制表符分隔 不支持单元格内换行");
  if (rows.length < 2 || rows.length > 20_001) throw new Error("须完整提供1至20000笔原分录 未裁剪行");
  return rows.slice(1).map((row, index) => {
    const cells = row.split("\t"); if (cells.length !== tableColumns.length) throw new Error(`原表格第${index + 2}行列数不一致 未导入任何分录`);
    const source = Object.fromEntries(tableColumns.map((key, i) => [key, cells[i]!]));
    try { return FinanceFactInputSchema.parse({ lineKey: source.lineKey, sourceEntryId: source.sourceEntryId, factType: source.factType, direction: source.direction,
      amountMinor: minorInteger(source.amountMinor!), currency: source.currency, occurredAt: source.occurredAt, externalReference: source.externalReference || null,
      orderId: source.orderId || null, orderLineId: source.orderLineId || null, skuId: source.skuId || null, listingId: source.listingId || null, supplierId: source.supplierId || null,
      correctionKind: source.correctionKind, correctsFactId: source.correctsFactId || null }); }
    catch { throw new Error(`原表格第${index + 2}行未通过完整分录校验 未导入任何分录 请核对来源标识、类型、整数金额、时间及真实 ID`); }
  });
}
function StatementForm({ Form, onClose, onDenied }: RecordProps) {
  const [provider, setProvider] = useState<(typeof FinanceStatementProviderSchema.options)[number]>("manual"), [currency, setCurrency] = useState("CNY");
  const [sourceKind, setSourceKind] = useState<"marketplace_account" | "supplier" | "named_source">("named_source"), [sourceId, setSourceId] = useState(""), [sourceName, setSourceName] = useState("");
  const [lines, setLines] = useState<LineDraft[]>(() => [blankLine()]), [page, setPage] = useState(0), [mode, setMode] = useState<"major" | "minor">("major"), [notice, setNotice] = useState(""), [error, setError] = useState(""), [importing, setImporting] = useState(false);
  const transition = useOwnedViewTransition(), size = 25, pages = Math.max(1, Math.ceil(lines.length / size)), current = Math.min(page, pages - 1);
  const mounted = useRef(true), source = useRef(""), importOwner = useRef<symbol | null>(null); source.current = JSON.stringify([provider, currency, sourceKind, sourceId, sourceName, mode]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; transition.cancel(); }; }, [transition]);
  const update = (key: string, values: Partial<LineDraft>) => setLines(previous => previous.map(row => row.key === key ? { ...row, ...values, ...("occurredAt" in values ? { occurredAtIso: undefined } : {}) } : row));
  const resetSource = (next: typeof provider) => { setProvider(next); setSourceId(""); setSourceName(""); setLines([blankLine()]); setPage(0); setNotice("来源已变化 已清空旧来源引用及分录 请按同一真实来源重新填写"); };
  return <Form title="登记财务证据单" scope={{ kind: "statement_record", targetId: null }} onClose={onClose} onDenied={onDenied} submitDisabled={importing} build={(form, requestKey) => {
    const sourceIdentity = sourceKind === "marketplace_account" ? { schemaVersion: 2 as const, kind: sourceKind } : sourceKind === "supplier" ? { schemaVersion: 2 as const, kind: sourceKind, supplierId: sourceId.trim() } : { schemaVersion: 2 as const, kind: sourceKind, sourceName: sourceName.trim() };
    return PrepareFinanceCommandSchema.parse({ kind: "statement_record", targetId: null, input: { provider, statementKind: formText(form, "statementKind"), accountId: sourceKind === "marketplace_account" ? sourceId.trim() : null,
      sourceIdentity, externalStatementId: formText(form, "externalStatementId"), periodStart: formDate(form, "periodStart"), periodEnd: formDate(form, "periodEnd"), sourceCurrency: currency,
      observedAt: formDate(form, "observedAt"), idempotencyKey: requestKey, lines: lines.map(row => ({ lineKey: row.lineKey.trim(), sourceEntryId: row.sourceEntryId.trim(), factType: row.factType, direction: row.direction,
        amountMinor: statementAmount(row.amount, currency, mode), currency, occurredAt: row.occurredAtIso ?? new Date(row.occurredAt).toISOString(), externalReference: row.externalReference.trim() || null,
        orderId: row.orderId.trim() || null, orderLineId: row.orderLineId.trim() || null, skuId: row.skuId.trim() || null, listingId: row.listingId.trim() || null, supplierId: row.supplierId.trim() || null,
        correctionKind: row.correctionKind, correctsFactId: row.correctsFactId.trim() || null })) } });
  }}>
    <p className="finance-command-note">来源作用域及分录标识须来自实际来源 不用行号、金额或订单号冒充源条目标识 人工登记不表示外部平台或银行已验真</p>
    {notice && <p className="finance-command-notice" role="status">{notice}</p>}{error && <p className="finance-command-notice is-error" role="alert">{error}</p>}
    <div className="record-grid"><Field label="单据提供方"><select value={provider} onChange={event => resetSource(FinanceStatementProviderSchema.parse(event.target.value))}>{FinanceStatementProviderSchema.options.map(value => <option key={value} value={value}>{providerNames[value]}</option>)}</select></Field><Field label="财务单据类型"><select name="statementKind" defaultValue="operational_cost">{FinanceStatementKindSchema.options.map(value => <option key={value} value={value}>{statementNames[value]}</option>)}</select></Field><Field label="原外部单据编号"><input name="externalStatementId" required maxLength={300} autoComplete="off" /></Field><Currency label="单据来源币种" value={currency} onChange={value => { setCurrency(value); setLines(rows => rows.map(row => ({ ...row, amount: "" }))); setNotice("币种已变化 已清空全部旧金额 请按来源币种重新核对 不自动换算"); }} /><Field label="原期间开始"><input name="periodStart" type="datetime-local" step="0.001" required /></Field><Field label="原期间结束"><input name="periodEnd" type="datetime-local" step="0.001" required /></Field><Field label="实际观察时间"><input name="observedAt" type="datetime-local" step="0.001" required defaultValue={localDateTime()} /></Field><Field label="真实来源作用域"><select value={sourceKind} onChange={event => { setSourceKind(event.target.value as typeof sourceKind); setSourceId(""); setSourceName(""); setLines([blankLine()]); setPage(0); setNotice("来源作用域已变化 已清空来源及旧分录 请重新核对"); }}><option value="named_source">命名业务来源</option><option value="marketplace_account">真实店铺账号</option><option value="supplier">真实供应商</option></select></Field></div>
    {sourceKind === "named_source" ? <Field label="真实来源名称" help="稳定业务来源标识 不填写账号、密码或个人信息"><input required maxLength={160} value={sourceName} onChange={event => setSourceName(event.target.value)} autoComplete="off" /></Field> : <Field label={sourceKind === "supplier" ? "真实来源供应商 ID" : "真实店铺账号 ID"}><input required maxLength={36} value={sourceId} onChange={event => setSourceId(event.target.value)} autoComplete="off" /></Field>}
    <Field label="分录金额输入单位"><select value={mode} onChange={event => { setMode(event.target.value as typeof mode); setLines(rows => rows.map(row => ({ ...row, amount: "" }))); setNotice("金额输入单位已变化 已清空旧金额 不把主单位与最小单位混用"); }}><option value="major">主货币单位 精确按原币种转换</option><option value="minor">原文整数最小单位</option></select></Field>
    <details className="finance-command-import"><summary><Upload size={14} />从原表格完整导入分录</summary><p>支持 UTF-8 制表符表格 TSV 金额列为非负整数最小单位 所有列必须保留 空引用留空 不支持单元格内换行 不自动生成来源 ID</p><code>{tableColumns.join("\t")}</code><Field label="导入原分录表格 TSV"><input type="file" accept=".tsv,.txt,text/tab-separated-values,text/plain" onChange={async event => {
      const control = event.currentTarget, file = control.files?.[0], captured = source.current; if (!file) return;
      const lease = Symbol("statement-import"); importOwner.current = lease; setImporting(true);
      const valid = () => mounted.current && source.current === captured && importOwner.current === lease;
      try {
        if (file.size > 28 * 1024 * 1024) throw new Error("原表格超过28MiB 未裁剪导入");
        const imported = parseFinanceStatementTable(await file.text()); if (!valid()) return;
        if (imported.some(row => row.currency !== currency)) throw new Error("原表格币种与单据币种不一致 未替换任何分录");
        const drafts = imported.map(row => ({ ...row, key: crypto.randomUUID(), amount: String(row.amountMinor), sourceEntryId: row.sourceEntryId ?? "", occurredAt: localExactDateTime(row.occurredAt), occurredAtIso: row.occurredAt,
          externalReference: row.externalReference ?? "", orderId: row.orderId ?? "", orderLineId: row.orderLineId ?? "", skuId: row.skuId ?? "", listingId: row.listingId ?? "", supplierId: row.supplierId ?? "", correctsFactId: row.correctsFactId ?? "" }));
        if (valid()) { setLines(drafts); setMode("minor"); setPage(0); setNotice(`已完整导入${drafts.length}笔原分录 请核对单据头与全部来源 未执行登记`); setError(""); }
      } catch (failure) { if (valid()) setError(failure instanceof Error ? failure.message : "原表格无法完整校验 未替换分录"); } finally { control.value = ""; if (importOwner.current === lease) { importOwner.current = null; if (mounted.current) setImporting(false); } }
    }} /></Field></details>
    <section className="finance-command-line-editor" aria-label="原财务分录填写"><h4>原财务分录 · 共 {lines.length} 笔</h4><p>按页填写 全部原分录共同校验和保存 当前显示第 {current + 1} / {pages} 页</p>{lines.slice(current * size, (current + 1) * size).map((row, index) => <section key={row.key} className="finance-command-line" aria-label={`财务分录 ${current * size + index + 1}`}><header><h5>分录 {current * size + index + 1}</h5><button type="button" aria-label={`移除财务分录 ${current * size + index + 1}`} disabled={lines.length === 1} onClick={() => transition.change(() => setLines(items => items.filter(item => item.key !== row.key)))}><Trash2 size={14} />移除分录</button></header><div className="record-grid"><Field label="单内分录标识"><input value={row.lineKey} required maxLength={300} onChange={event => update(row.key, { lineKey: event.target.value })} autoComplete="off" /></Field><Field label="真实来源条目标识"><input value={row.sourceEntryId} required maxLength={300} onChange={event => update(row.key, { sourceEntryId: event.target.value })} autoComplete="off" /></Field><Field label="分录事实类型"><select value={row.factType} onChange={event => update(row.key, { factType: FinanceFactTypeSchema.parse(event.target.value) })}>{FinanceFactTypeSchema.options.map(value => <option key={value} value={value}>{factNames[value]}</option>)}</select></Field><Field label="记账方向"><select value={row.direction} onChange={event => update(row.key, { direction: event.target.value as "credit" | "debit" })}><option value="debit">借方 debit</option><option value="credit">贷方 credit</option></select></Field><Field label={mode === "major" ? `分录金额（${currency} 主单位）` : `分录金额（${currency} 整数最小单位）`}><input value={row.amount} required inputMode={mode === "major" ? "decimal" : "numeric"} maxLength={32} onChange={event => update(row.key, { amount: event.target.value })} autoComplete="off" /></Field><Field label="分录实际发生时间"><input type="datetime-local" step="0.001" value={row.occurredAt} required onChange={event => update(row.key, { occurredAt: event.target.value })} /></Field></div><details><summary>实际业务引用与纠正依据</summary><div className="record-grid">{(["externalReference", "orderId", "orderLineId", "skuId", "listingId", "supplierId"] as const).map(key => <Field key={key} label={({ externalReference: "外部业务引用", orderId: "真实订单 ID", orderLineId: "真实订单行 ID", skuId: "真实 SKU ID", listingId: "真实刊登 ID", supplierId: "分录真实供应商 ID" })[key]}><input value={row[key]} maxLength={key === "externalReference" ? 300 : 36} onChange={event => update(row.key, { [key]: event.target.value })} autoComplete="off" /></Field>)}<Field label="分录纠正类型"><select value={row.correctionKind} onChange={event => update(row.key, { correctionKind: event.target.value as LineDraft["correctionKind"], correctsFactId: "" })}><option value="original">原事实</option><option value="reversal">冲回原事实</option><option value="replacement">替代原事实</option></select></Field>{row.correctionKind !== "original" && <Field label="被纠正的真实事实 ID"><input required value={row.correctsFactId} maxLength={36} onChange={event => update(row.key, { correctsFactId: event.target.value })} autoComplete="off" /></Field>}</div></details></section>)}<footer><button type="button" disabled={current === 0} onClick={() => transition.change(() => setPage(current - 1))}><ArrowLeft size={13} />上页分录</button><button type="button" disabled={current + 1 >= pages} onClick={() => transition.change(() => setPage(current + 1))}>下页分录<ArrowRight size={13} /></button><button type="button" disabled={lines.length >= 20_000} onClick={() => transition.change(() => { setLines(items => [...items, blankLine()]); setPage(Math.floor(lines.length / size)); })}><Plus size={14} />添加真实分录</button></footer></section>
  </Form>;
}
function FxForm({ Form, onClose, onDenied }: RecordProps) {
  const [base, setBase] = useState("USD"), [quote, setQuote] = useState("CNY"), [rateUnit, setRateUnit] = useState("major_to_major");
  return <Form title="登记历史汇率" scope={{ kind: "fx_rate_record", targetId: null }} onClose={onClose} onDenied={onDenied} build={(form, key) => PrepareFinanceCommandSchema.parse({ kind: "fx_rate_record", targetId: null, input: { ...(rateUnit ? { rateUnit } : {}), source: formText(form, "source"), baseCurrency: base, quoteCurrency: quote, rateNumerator: positiveInteger(formText(form, "rateNumerator"), "汇率分子"), rateDenominator: positiveInteger(formText(form, "rateDenominator"), "汇率分母"), effectiveAt: formDate(form, "effectiveAt"), retrievedAt: formDate(form, "retrievedAt"), idempotencyKey: key } })}>
    <p className="finance-command-note">保留精确整数比率 不用浮点小数替代 原币种主单位和最小单位不可混用</p><div className="record-grid"><Field label="汇率来源代码"><input name="source" required maxLength={100} autoComplete="off" /></Field><Currency label="原始基准币种" value={base} onChange={setBase} /><Currency label="原始报价币种" value={quote} onChange={setQuote} /><Field label="汇率单位口径"><select value={rateUnit} onChange={event => setRateUnit(event.target.value)}><option value="major_to_major">主货币单位到主货币单位</option><option value="">原请求不填写 单位待核对</option></select></Field><Field label="精确汇率分子"><input name="rateNumerator" required inputMode="numeric" maxLength={16} autoComplete="off" /></Field><Field label="精确汇率分母"><input name="rateDenominator" required inputMode="numeric" maxLength={16} autoComplete="off" /></Field><Field label="汇率实际生效时间"><input name="effectiveAt" type="datetime-local" step="0.001" required /></Field><Field label="汇率实际取得时间"><input name="retrievedAt" type="datetime-local" step="0.001" required /></Field></div><p className="finance-command-note">填写含义 1 {base} 主单位按上述分子/分母兑换 {quote} 主单位 未填写单位时不会偷偷补为此口径</p>
  </Form>;
}
function MetricForm({ Form, onClose, onDenied }: RecordProps) {
  const [metricDraft, setMetricDraft] = useState(""), [mode, setMode] = useState("new"), [metricId, setMetricId] = useState<string | null | undefined>();
  const [currency, setCurrency] = useState("CNY"), [revenue, setRevenue] = useState<FinanceFactType[]>([]), [cost, setCost] = useState<FinanceFactType[]>([]), [required, setRequired] = useState<FinanceFactType[]>([]), [error, setError] = useState("");
  if (metricId === undefined) return <form className="record-form finance-command-form" aria-label="选择利润口径原提交范围" onSubmit={event => { event.preventDefault(); if (mode === "append" && !EntityIdSchema.safeParse(metricDraft.trim()).success) { setError("追加版本须填写真实利润口径 ID"); return; } setMetricId(mode === "append" ? metricDraft.trim().toLowerCase() : null); }}><Field label="利润口径版本操作"><select value={mode} onChange={event => { setMode(event.target.value); setMetricDraft(""); setError(""); }}><option value="new">新建利润口径</option><option value="append">追加已有口径版本</option></select></Field>{mode === "append" && <Field label="已有利润口径 ID"><input required value={metricDraft} maxLength={36} onChange={event => setMetricDraft(event.target.value)} autoComplete="off" /></Field>}{error && <p role="alert">{error}</p>}<footer><button type="button" data-record-cancel onClick={onClose}>返回实际记录</button><button type="submit">选择并读取口径原提交</button></footer></form>;
  return <Form title="建立利润口径版本" scope={{ kind: "metric_upsert", targetId: metricId }} onClose={onClose} onDenied={onDenied} build={(form, key) => PrepareFinanceCommandSchema.parse({ kind: "metric_upsert", targetId: metricId, input: { metricId, ...(metricId ? { expectedVersion: positiveInteger(formText(form, "expectedVersion"), "固定前版") } : {}), name: formText(form, "name"), reportingCurrency: currency, revenueFactTypes: revenue, costFactTypes: cost, requiredFactTypes: required, reasonCode: formText(form, "reasonCode"), idempotencyKey: key } })}>
    <p className="finance-command-note">本次固定口径 <code>{metricId ?? "明确新建"}</code> 追加版本须填写固定前版 原批准版本不覆盖 不自动取 latest</p><div className="record-grid">{metricId && <Field label="固定原口径版本"><input name="expectedVersion" required inputMode="numeric" maxLength={16} /></Field>}<Field label="利润口径名称"><input name="name" required maxLength={160} /></Field><Currency label="口径报告币种" value={currency} onChange={setCurrency} /><Field label="版本变更原因代码"><input name="reasonCode" required maxLength={100} autoComplete="off" /></Field></div><FactSelection label="收入事实类别" value={revenue} onChange={setRevenue} /><FactSelection label="成本事实类别" value={cost} onChange={setCost} /><FactSelection label="必需事实类别" value={required} onChange={setRequired} /><p className="finance-command-note">同一类别不能同时计为收入和成本 必需类别须已明确分类</p>
  </Form>;
}
function ProfitForm({ Form, onClose, onDenied }: RecordProps) {
  const [metricDraft, setMetricDraft] = useState(""), [metricId, setMetricId] = useState<string | null>(null), [coverage, setCoverage] = useState(""), [error, setError] = useState("");
  if (metricId === null) return <form className="record-form finance-command-form" aria-label="选择利润计算原提交范围" onSubmit={event => { event.preventDefault(); const parsed = EntityIdSchema.safeParse(metricDraft.trim()); if (!parsed.success) { setError("请填写真实利润口径 ID"); return; } setMetricId(parsed.data.toLowerCase()); }}><Field label="真实利润口径 ID"><input value={metricDraft} maxLength={36} required onChange={event => setMetricDraft(event.target.value)} autoComplete="off" /></Field>{error && <p role="alert">{error}</p>}<footer><button type="button" data-record-cancel onClick={onClose}>返回实际记录</button><button type="submit">选择并读取计算原提交</button></footer></form>;
  return <Form title="固定证据计算利润" scope={{ kind: "profit_calculate", targetId: metricId }} onClose={onClose} onDenied={onDenied} build={(form, key) => PrepareFinanceCommandSchema.parse({ kind: "profit_calculate", targetId: metricId, input: { metricId, expectedMetricVersion: positiveInteger(formText(form, "expectedMetricVersion"), "原口径版本"), statementIds: ids(formText(form, "statementIds"), true), fxRateIds: ids(formText(form, "fxRateIds"), false), ...(coverage ? { coverageDimension: coverage } : {}), idempotencyKey: key } })}>
    <p className="finance-command-note">固定原口径 <code>{metricId}</code> 只采用本次明确固定的真实单据、历史汇率和口径版本 不自动选最新记录 计算登记成功不等于证据完整</p><div className="record-grid"><Field label="固定利润口径版本"><input name="expectedMetricVersion" required inputMode="numeric" maxLength={16} /></Field><Field label="利润覆盖维度"><select value={coverage} onChange={event => setCoverage(event.target.value)}><option value="">原请求不填写 由原服务按订单覆盖</option>{FinanceProfitCoverageDimensionSchema.options.map(value => <option key={value} value={value}>{dimensionNames[value]}</option>)}</select></Field></div><Field label="固定财务证据单 ID" help="一行一个真实ID 最多500笔 不用单号或当前列表序号"><textarea name="statementIds" required rows={5} maxLength={20_000} autoComplete="off" /></Field><Field label="固定历史汇率 ID" help="一行一个真实ID 无需汇率时明确留空 不自动取今日汇率"><textarea name="fxRateIds" rows={4} maxLength={20_000} autoComplete="off" /></Field><p className="finance-command-note"><a href="/finance/ledger">到完整财务台账读取真实单据、口径版本与历史汇率</a></p>
  </Form>;
}
function Currency({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) { const id = useId(); return <div><Field label={label}><input value={value} list={id} required pattern="[A-Z]{3}" maxLength={3} onChange={event => onChange(event.target.value.toUpperCase())} autoComplete="off" /></Field><datalist id={id}>{Object.keys(FINANCE_CURRENCY_MINOR_DIGITS).sort().map(currency => <option key={currency} value={currency} />)}</datalist></div>; }
function localExactDateTime(value: string) { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, -1); }
function FactSelection({ label, value, onChange }: { label: string; value: FinanceFactType[]; onChange(value: FinanceFactType[]): void }) { return <div className="finance-command-fact-selection" role="group" aria-label={label}><h4>{label}</h4>{FinanceFactTypeSchema.options.map(type => <label key={type}><input type="checkbox" checked={value.includes(type)} onChange={event => onChange(event.target.checked ? [...value, type] : value.filter(item => item !== type))} />{factNames[type]}</label>)}</div>; }
export function FinanceDraftMoney({ value, currency }: { value: number; currency: string }) { return <span>{formatFinanceMinorAmount(value, currency)}</span>; }
