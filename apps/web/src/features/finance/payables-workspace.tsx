"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Banknote, Check, CircleAlert, FileCheck2, Link2, Pencil, Plus, ReceiptText, RefreshCw, Undo2 } from "lucide-react";
import type { z } from "zod";
import { Permission } from "@yummyai/authz/permissions";
import { FINANCE_CURRENCY_MINOR_DIGITS } from "@yummyai/contracts/finance/currency-snapshot";
import { financeCurrencyMinorDigits, formatFinanceMinorAmount } from "@yummyai/contracts/finance/monetary";
import {
  AllocateFinancePaymentInputSchema, FinanceAllocationReleaseViewSchema, FinancePayableBillViewSchema,
  FinancePayablePaymentViewSchema, FinancePayablesWorkspaceViewSchema, FinancePaymentAllocationBatchViewSchema,
  RecordFinanceBillInputSchema, RecordFinancePaymentInputSchema, ReleaseFinanceAllocationInputSchema,
  parseFinancePayableAmount,
  type FinancePayablesWorkspaceView, type RecordFinanceBillInput, type RecordFinancePaymentInput,
} from "@yummyai/contracts/finance/payables";
import { useErpAccess } from "../identity/erp-access";
import { Field, RecordDialog, RecordSelect } from "../manual-operations/record-form";
import { formDate, formText, localDateTime } from "../manual-operations/operation-types";
import { PrepareFinanceCommandSchema, type FinanceCommandScope } from "@yummyai/contracts/finance/finance-command";
import { FinanceCommandForm } from "./finance-command-workbench";
import { PayableAdjustmentsHistory, PayableBillAdjustmentForm, PayablePaymentAdjustmentForm,
  billLifecycleNames, paymentLifecycleNames, type PayableMutationFormProps } from "./payables-adjustments";
import "../manual-operations/manual-operations.css";
import "./payables-workspace.css";

type Intent = { kind: "bill" } | { kind: "payment" } | { kind: "allocate"; paymentId?: string; billId?: string }
  | { kind: "release"; allocationId: string } | { kind: "bill_adjustment"; billId: string }
  | { kind: "payment_adjustment"; paymentId: string };
type DialogContext = { intent: Intent; data: FinancePayablesWorkspaceView };
const billNames = { factory_invoice: "工厂账单", supplier_invoice: "供应商账单", procurement_invoice: "采购实际发票" };
const methodNames = { bank_transfer: "银行转账", card: "卡付款", cash: "现金", other: "其他" };
const allocationNames = { unallocated: "未核销", partially_allocated: "部分核销", fully_allocated: "已全额核销" };
const sourceNames = { current: "来源有效", source_adjusted: "来源已有生效调整 原应付待重新核对", source_unavailable: "来源暂不可核对", source_unreconciled: "采购差异待核对" };
const currencies = Object.keys(FINANCE_CURRENCY_MINOR_DIGITS).sort();

export function PayablesWorkspace({ initialData }: { initialData: FinancePayablesWorkspaceView }) {
  const access = useErpAccess(), canRead = access.can(Permission.FinanceRead);
  const [snapshot, setSnapshot] = useState<{ data: FinancePayablesWorkspaceView; authority: string | null } | null>(() => ({ data: initialData, authority: access.authority }));
  const [dialog, setDialog] = useState<DialogContext | null>(null), [reading, setReading] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const live = useRef(true), sequence = useRef(0), controller = useRef<AbortController | null>(null);
  const authority = useRef(access.authority), previousAuthority = useRef(access.authority);
  authority.current = access.authority;
  const data = canRead && snapshot?.authority === access.authority ? snapshot.data : null;
  const canWrite = Boolean(data?.permissions.canWrite && access.can(Permission.FinanceWrite));
  const canReview = Boolean(data?.permissions.canReview && access.can(Permission.FinanceReview));
  const denied = useCallback((message: string) => { sequence.current++; controller.current?.abort(); setSnapshot(null); setDialog(null); setNotice(""); setReading(false); setError(message); }, []);
  const reload = useCallback(async () => {
    if (!canRead) return;
    const token = ++sequence.current, captured = access.authority;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort; setReading(true);
    const valid = () => live.current && sequence.current === token && authority.current === captured;
    try {
      const result = await requestPayables("workspace", FinancePayablesWorkspaceViewSchema, { signal: abort.signal });
      if (!valid()) return;
      setSnapshot({ data: result, authority: captured }); setError("");
    } catch (failure) {
      if (!valid() || abort.signal.aborted) return;
      if (isDenied(failure)) denied(failure.message);
      else setError(publicError(failure));
    } finally { if (valid()) setReading(false); }
  }, [access.authority, canRead, denied]);
  useEffect(() => { live.current = true; return () => { live.current = false; sequence.current++; controller.current?.abort(); }; }, []);
  useLayoutEffect(() => {
    if (previousAuthority.current === access.authority && canRead) return;
    previousAuthority.current = access.authority;
    sequence.current++; controller.current?.abort(); setSnapshot(null); setDialog(null); setNotice(""); setReading(false); setError("");
    if (canRead) void reload();
  }, [access.authority, canRead, reload]);
  useEffect(() => {
    if (dialog && (dialog.intent.kind === "bill" || dialog.intent.kind === "payment" ? !canWrite : !canReview)) setDialog(null);
  }, [dialog, canWrite, canReview]);
  const open = (intent: Intent) => { if (data && !reading && !error) { setNotice(""); setDialog({ intent, data }); } };
  const changed = (message: string) => { setNotice(message); void reload(); };
  const blocked = reading || Boolean(error);
  return <div className="payables-workspace" aria-busy={reading}>
    <section className="payables-scope" aria-label="应付与付款核销范围"><FileCheck2 size={18} /><p>登记应付账单与已发生的付款证据 按实际付款核销账单<br /><strong>此处不发起转账 付款证据为人工登记 未经银行认证</strong></p><button type="button" disabled={reading || !canRead} onClick={() => void reload()}><RefreshCw size={14} />{reading ? "正在读取实际记录" : "刷新实际余额与历史"}</button></section>
    {!canRead && <p className="payables-message" role="status">当前没有财务读取权限 私有记录与填写已清除</p>}
    {error && <p className="payables-message is-error" role="alert">{error}{data ? " 以下保留上次读取记录 当前余额待重新核对" : ""}</p>}
    {notice && <p className="payables-message" role="status"><Check size={15} />{notice}</p>}
    {data && <>
      {data.truncated && <p className="payables-message is-warning" role="status"><CircleAlert size={15} />当前列表不完整 仅展示已读取记录 不代表全部账单、付款或核销历史 各笔余额由服务端按全部有效核销计算</p>}
      <p className="payables-help">{reading || error ? "上次读取余额 待刷新核对" : "当前账单及登记付款余额"} · 原金额始终保留 更正后按服务端净额核销 · 不跨币种相加 · 余额是核销账面记录 不是银行余额</p>
      <section className="payables-panel" aria-labelledby="payables-bills-title">
        <PanelHeading id="payables-bills-title" title="实际应付账单" icon={<ReceiptText size={17} />} count={data.bills.length} action={canWrite ? <button type="button" className="primary" disabled={blocked} onClick={() => open({ kind: "bill" })}><Plus size={14} />登记应付账单</button> : undefined} />
        {!canWrite && <p className="payables-help">当前账号可查看账单 不能登记应付或付款证据</p>}
        {!data.bills.length ? <Empty>当前已读取列表中没有应付账单 请依据真实工厂账单、供应商账单或采购实际发票登记</Empty> : <div className="payables-responsive"><table className="payables-table" aria-label="实际应付账单"><thead><tr><th>账单与来源</th><th>供应商</th><th>原金额 / 调整后净额</th><th>已核销 / 净额待核销</th><th>状态与日期</th><th>核对操作</th></tr></thead><tbody>{data.bills.map(bill => <tr key={bill.id} aria-label={`应付账单 ${bill.externalBillId}`}>
          <td data-label="账单与来源"><strong>{bill.externalBillId}</strong><small>{billNames[bill.kind]}</small>{bill.procurementInvoiceId && <small>实际采购发票 <code>{bill.procurementInvoiceId}</code></small>}</td>
          <td data-label="供应商">{supplierName(data, bill.supplierId)}</td>
          <td data-label="原金额 / 调整后净额"><span>原金额 <Money value={bill.amountMinor} currency={bill.currency} /></span><strong className="payables-net">净额 <Money value={bill.netAmountMinor} currency={bill.currency} /></strong><small>累计贷项 <Money value={bill.creditMinor} currency={bill.currency} /><br />累计补差 <Money value={bill.debitMinor} currency={bill.currency} /><br />累计作废 <Money value={bill.voidedMinor} currency={bill.currency} /></small></td>
          <td data-label="已核销 / 净额待核销"><Money value={bill.allocatedMinor} currency={bill.currency} /><small>净额待核销 <Money value={bill.outstandingMinor} currency={bill.currency} /></small></td>
          <td data-label="状态与日期"><strong className="payables-lifecycle">{billLifecycleNames[bill.lifecycle]}</strong><span className="payables-status">{allocationNames[bill.status]}</span><small className={bill.sourceStatus === "current" ? "" : "payables-warning"}>{sourceNames[bill.sourceStatus]}</small><small>开具 {dateTime(bill.issuedAt)}{bill.dueAt ? ` · 到期 ${dateTime(bill.dueAt)}` : " · 未登记到期日"}</small></td>
          <td data-label="核对操作">{canReview && <div className="payables-row-actions"><button type="button" disabled={blocked || bill.lifecycle === "voided" || bill.sourceStatus !== "current" || bill.outstandingMinor === 0} onClick={() => open({ kind: "allocate", billId: bill.id })}><Link2 size={14} />选择付款核销</button><button type="button" disabled={blocked || bill.lifecycle === "voided"} onClick={() => open({ kind: "bill_adjustment", billId: bill.id })}><Pencil size={14} />更正应付记录</button></div>}{bill.lifecycle === "voided" ? <small>已作废 停止更正与新核销 原凭据保留</small> : bill.sourceStatus !== "current" && <small>来源变化后暂停新核销 既有核销仍可在历史中撤销</small>}</td>
        </tr>)}</tbody></table></div>}
      </section>

      <section className="payables-panel" aria-labelledby="payables-payments-title">
        <PanelHeading id="payables-payments-title" title="已登记付款证据" icon={<Banknote size={17} />} count={data.payments.length} action={canWrite ? <button type="button" className="primary" disabled={blocked} onClick={() => open({ kind: "payment" })}><Plus size={14} />登记付款证据</button> : undefined} />
        {!data.payments.length ? <Empty>当前已读取列表中没有付款证据 仅登记已发生且经人工核对的付款 此处不会实际扣款</Empty> : <div className="payables-responsive"><table className="payables-table" aria-label="已登记付款证据"><thead><tr><th>付款标识与证据</th><th>供应商</th><th>原金额 / 调整后净额</th><th>已核销 / 未分配</th><th>付款方式与时间</th><th>核对操作</th></tr></thead><tbody>{data.payments.map(payment => <tr key={payment.id} aria-label={`付款证据 ${payment.externalPaymentId}`}>
          <td data-label="付款标识与证据"><strong>{payment.externalPaymentId}</strong><small>证据标识 <code>{payment.evidenceReference}</code></small><small>人工登记 未经银行认证</small></td>
          <td data-label="供应商">{supplierName(data, payment.supplierId)}</td>
          <td data-label="原金额 / 调整后净额"><span>原登记 <Money value={payment.amountMinor} currency={payment.currency} /></span><strong className="payables-net">净额 <Money value={payment.netAmountMinor} currency={payment.currency} /></strong><small>累计退款 <Money value={payment.refundedMinor} currency={payment.currency} /><br />累计作废 <Money value={payment.voidedMinor} currency={payment.currency} /></small></td>
          <td data-label="已核销 / 未分配"><Money value={payment.allocatedMinor} currency={payment.currency} /><small>未分配 <Money value={payment.unallocatedMinor} currency={payment.currency} /></small><small>{allocationNames[payment.status]}</small></td>
          <td data-label="付款方式与时间"><strong className="payables-lifecycle">{paymentLifecycleNames[payment.lifecycle]}</strong>{methodNames[payment.method]}<small>{dateTime(payment.paidAt)}</small></td>
          <td data-label="核对操作">{canReview && <div className="payables-row-actions"><button type="button" disabled={blocked || payment.lifecycle === "voided" || payment.unallocatedMinor === 0} onClick={() => open({ kind: "allocate", paymentId: payment.id })}><Link2 size={14} />分配到多个账单</button><button type="button" disabled={blocked || payment.lifecycle === "voided"} onClick={() => open({ kind: "payment_adjustment", paymentId: payment.id })}><Pencil size={14} />更正付款记录</button></div>}{payment.lifecycle === "voided" && <small>已作废 停止退款登记与新核销 原凭据保留</small>}</td>
        </tr>)}</tbody></table></div>}
        {!canReview && <p className="payables-help">当前账号没有财务核销权限 核销、撤销与更正入口已隐藏</p>}
      </section>

      <section className="payables-panel" aria-labelledby="payables-history-title">
        <PanelHeading id="payables-history-title" title="核销与撤销历史" icon={<FileCheck2 size={17} />} count={data.allocations.length} />
        {!data.allocations.length ? <Empty>当前已读取列表中没有核销记录 付款证据登记后仍需逐笔分配到同供应商、同币种的账单</Empty> : <ol className="payables-history">{data.allocations.map(allocation => <li key={allocation.id} aria-label={`核销记录 ${allocation.id}`}><div><strong>{paymentName(data, allocation.paymentId)} → {billName(data, allocation.billId)}</strong><p><Money value={allocation.amountMinor} currency={allocation.currency} /> · {allocation.released ? "已撤销 本笔不再占用余额" : "有效核销"}</p><small>批次 <code>{allocation.batchId}</code> · {dateTime(allocation.recordedAt)}</small></div>{canReview && !allocation.released && <button type="button" disabled={blocked} onClick={() => open({ kind: "release", allocationId: allocation.id })}><Undo2 size={14} />撤销本笔核销</button>}</li>)}</ol>}
        <details className="payables-releases"><summary>查看已读取的撤销凭据 {data.releases.length} 笔</summary>{!data.releases.length ? <p className="payables-help">当前已读取列表中没有撤销凭据</p> : <ol>{data.releases.map(release => <li key={release.id}><strong>撤销核销 <code>{release.allocationId}</code></strong><span>原因代码 {release.reasonCode} · {dateTime(release.recordedAt)}</span><small>撤销凭据 <code>{release.id}</code></small></li>)}</ol>}</details>
      </section>
      <PayableAdjustmentsHistory data={data} />
    </>}
    {dialog && data && (dialog.intent.kind === "bill" || dialog.intent.kind === "payment" ? canWrite : canReview) && <PayableDialog context={dialog} permitted={dialog.intent.kind === "bill" || dialog.intent.kind === "payment" ? canWrite : canReview} onClose={() => setDialog(null)} onSaved={changed} onDenied={denied} onReload={reload} />}
  </div>;
}

function PayableDialog({ context, permitted, onClose, onSaved, onDenied, onReload }: { context: DialogContext; permitted: boolean; onClose(): void; onSaved(message: string): void; onDenied(message: string): void; onReload(): Promise<void> }) {
  const [closing, setClosing] = useState(false), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const close = () => { if (closing) return; setClosing(true); timer.current = setTimeout(onClose, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160); };
  const props = { data: context.data, permitted: permitted && !closing, onClose: close, onSaved, onDenied, onReload };
  const titles = { bill: "登记应付账单", payment: "登记付款证据", allocate: "分配付款到多个账单", release: "撤销本笔核销", bill_adjustment: "登记应付更正", payment_adjustment: "登记付款更正" };
  return <RecordDialog title={titles[context.intent.kind]} protectEdits onClose={close}><div className={`payables-dialog-body${closing ? " is-closing" : ""}`}>
    {context.intent.kind === "bill" ? <BillForm {...props} /> : context.intent.kind === "payment" ? <PaymentForm {...props} /> : context.intent.kind === "allocate" ? <AllocationForm {...props} intent={context.intent} /> : context.intent.kind === "release" ? <ReleaseForm {...props} allocationId={context.intent.allocationId} /> : context.intent.kind === "bill_adjustment" ? <PayableBillAdjustmentForm {...props} billId={context.intent.billId} MutationForm={PayableMutationForm} /> : <PayablePaymentAdjustmentForm {...props} paymentId={context.intent.paymentId} MutationForm={PayableMutationForm} />}
  </div></RecordDialog>;
}

type FormProps = { data: FinancePayablesWorkspaceView; permitted: boolean; onClose(): void; onSaved(message: string): void; onDenied(message: string): void; onReload(): Promise<void> };

function BillForm(props: FormProps) {
  const [supplierId, setSupplierId] = useState(""), [kind, setKind] = useState<RecordFinanceBillInput["kind"]>("supplier_invoice");
  const [currency, setCurrency] = useState("CNY"), [amount, setAmount] = useState(""), [invoiceId, setInvoiceId] = useState(""), [change, setChange] = useState("");
  return <PayableMutationForm {...props} title="登记应付账单" path="bills" inputSchema={RecordFinanceBillInputSchema} resultSchema={FinancePayableBillViewSchema} submitLabel="登记应付账单" successMessage="应付账单已登记 未发起付款" build={form => ({ supplierId, kind, externalBillId: formText(form, "externalBillId"), currency, amountMinor: parseFinancePayableAmount(amount, currency), issuedAt: formDate(form, "issuedAt"), dueAt: formText(form, "dueAt") ? formDate(form, "dueAt") : null, procurementInvoiceId: kind === "procurement_invoice" ? invoiceId.trim() : null })} renderResult={bill => <><h3>应付账单已登记</h3><p>{bill.externalBillId} · {billNames[bill.kind]}</p><p><Money value={bill.amountMinor} currency={bill.currency} /> · {sourceNames[bill.sourceStatus]}</p><p>登记凭据 <code>{bill.id}</code></p><p>未发起付款 后续按实际付款证据核销</p></>}>
    <p className="record-help">按真实账单登记金额 采购类型必须关联已存在的实际发票 服务端将核对供应商、币种及原发票依据</p>
    {change && <p className="payables-message" role="status">{change}</p>}
    <div className="record-grid"><SupplierSelect data={props.data} value={supplierId} onChange={value => { setSupplierId(value); setInvoiceId(""); setAmount(""); setChange("供应商已变化 已清空金额和采购发票引用 请重新核对"); }} /><Field label="账单类型"><select value={kind} onChange={event => { setKind(event.target.value as RecordFinanceBillInput["kind"]); setInvoiceId(""); }}><option value="supplier_invoice">供应商账单</option><option value="factory_invoice">工厂账单</option><option value="procurement_invoice">采购实际发票</option></select></Field><Field label="账单编号" help="仅业务单号 可用字母、数字、点、斜线、下划线及连字符"><input name="externalBillId" required maxLength={160} autoComplete="off" /></Field><CurrencySelect label="账单币种" value={currency} onChange={value => { setCurrency(value); setAmount(""); setChange("币种已变化 已清空金额 请按新币种实际账单重新填写"); }} /><AmountField label="账单金额（主货币单位）" currency={currency} value={amount} onChange={setAmount} /><Field label="账单开具时间"><input name="issuedAt" type="datetime-local" required defaultValue={localDateTime()} /></Field><Field label="账单到期时间" help="可留空 不得早于开具时间"><input name="dueAt" type="datetime-local" /></Field></div>
    {kind === "procurement_invoice" && <Field label="实际采购发票 ID" help="填写ERP中已存在的实际采购发票标识 不是采购单号或私有提交键"><input required maxLength={36} value={invoiceId} onChange={event => setInvoiceId(event.target.value)} autoComplete="off" /></Field>}
  </PayableMutationForm>;
}

function PaymentForm(props: FormProps) {
  const [supplierId, setSupplierId] = useState(""), [currency, setCurrency] = useState("CNY"), [amount, setAmount] = useState("");
  const [method, setMethod] = useState<RecordFinancePaymentInput["method"]>("bank_transfer"), [reference, setReference] = useState(""), [change, setChange] = useState("");
  return <PayableMutationForm {...props} title="登记付款证据" path="payments" inputSchema={RecordFinancePaymentInputSchema} resultSchema={FinancePayablePaymentViewSchema} submitLabel="登记付款证据" successMessage="付款证据已登记 这是人工登记事实 不是转账成功通知" build={form => ({ supplierId, externalPaymentId: formText(form, "externalPaymentId"), currency, amountMinor: parseFinancePayableAmount(amount, currency), paidAt: formDate(form, "paidAt"), method, evidenceReference: reference.trim() })} renderResult={payment => <><h3>付款证据已登记</h3><p>{payment.externalPaymentId} · {methodNames[payment.method]}</p><p><Money value={payment.amountMinor} currency={payment.currency} /> · 未分配 <Money value={payment.unallocatedMinor} currency={payment.currency} /></p><p>证据标识 <code>{payment.evidenceReference}</code></p><p>登记凭据 <code>{payment.id}</code></p><p>人工登记 未经银行认证 未通过此页面发起转账</p></>}>
    <p className="record-help">仅登记已经发生且经人工核对的付款 付款方式是证据分类 不会调用银行、扣款或转账接口</p>
    {change && <p className="payables-message" role="status">{change}</p>}
    <div className="record-grid"><SupplierSelect data={props.data} value={supplierId} onChange={value => { setSupplierId(value); setAmount(""); setReference(""); setChange("供应商已变化 已清空金额与证据标识 请按实际付款重新核对"); }} /><Field label="付款记录编号" help="使用可复核且唯一的业务流水标识"><input name="externalPaymentId" required maxLength={160} autoComplete="off" /></Field><CurrencySelect label="付款币种" value={currency} onChange={value => { setCurrency(value); setAmount(""); setChange("币种已变化 已清空金额 请按实际付款币种重新填写"); }} /><AmountField label="付款金额（主货币单位）" currency={currency} value={amount} onChange={setAmount} /><Field label="实际付款时间"><input name="paidAt" type="datetime-local" required defaultValue={localDateTime()} /></Field><Field label="付款方式"><select value={method} onChange={event => setMethod(event.target.value as RecordFinancePaymentInput["method"])}>{Object.entries(methodNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field></div>
    <Field label="付款证据流水标识" help="仅填写安全业务流水标识 不填银行账号、个人姓名、手机号、密码或完整银行回单"><input required maxLength={160} autoComplete="off" value={reference} onChange={event => setReference(event.target.value)} /></Field>
  </PayableMutationForm>;
}

function AllocationForm({ intent, ...props }: FormProps & { intent: Extract<Intent, { kind: "allocate" }> }) {
  const bill = props.data.bills.find(row => row.id === intent.billId);
  const eligiblePayments = props.data.payments.filter(payment => payment.lifecycle !== "voided" && payment.unallocatedMinor > 0 && (!bill || payment.supplierId === bill.supplierId && payment.currency === bill.currency));
  const [paymentId, setPaymentId] = useState(intent.paymentId ?? ""), [drafts, setDrafts] = useState<Record<string, string>>({}), [change, setChange] = useState("");
  const payment = eligiblePayments.find(row => row.id === paymentId);
  const bills = payment ? props.data.bills.filter(row => row.lifecycle !== "voided" && row.supplierId === payment.supplierId && row.currency === payment.currency && row.sourceStatus === "current" && row.outstandingMinor > 0) : [];
  const buildAllocations = () => {
    if (!payment) throw new Error("请选择实际付款记录");
    const allocations = Object.entries(drafts).filter(([, value]) => value.trim()).map(([billId, value]) => {
      const target = bills.find(row => row.id === billId);
      if (!target) throw new Error("所选账单已不在本次有效核销范围 请重新核对");
      const amountMinor = parseFinancePayableAmount(value, payment.currency);
      if (amountMinor > target.outstandingMinor) throw new Error(`账单 ${target.externalBillId} 的核销金额超过净额待核销余额`);
      return { billId, amountMinor };
    });
    if (!allocations.length) throw new Error("请至少填写一个账单的本次核销金额");
    if (allocations.length > 100) throw new Error("每次最多核销100张账单 请按实际付款分批核对");
    const sum = allocations.reduce((total, row) => total + BigInt(row.amountMinor), 0n);
    if (sum > BigInt(payment.unallocatedMinor)) throw new Error("本次核销合计超过所选付款的未分配金额");
    return allocations;
  };
  let total: number | null = null, draftError = "";
  if (Object.values(drafts).some(value => value.trim())) {
    try { total = Number(buildAllocations().reduce((sum, row) => sum + BigInt(row.amountMinor), 0n)); }
    catch (failure) { draftError = formError(failure); }
  }
  return <PayableMutationForm {...props} commandTargetId={paymentId || null} title="分配付款到多个账单" path="allocations" inputSchema={AllocateFinancePaymentInputSchema} resultSchema={FinancePaymentAllocationBatchViewSchema} submitLabel="登记本次核销" successMessage="本次核销已登记 实际余额已请求重新读取" build={() => ({ paymentId, allocations: buildAllocations() })} renderResult={batch => <><h3>本次核销已登记</h3><p>核销批次 <code>{batch.id}</code></p><ol>{batch.allocations.map(row => <li key={row.id}>{billName(props.data, row.billId)} · <Money value={row.amountMinor} currency={row.currency} /><small>核销凭据 <code>{row.id}</code></small></li>)}</ol><p>这是账单与已登记付款的分配记录 未发起新转账</p></>}>
    <p className="record-help">先选择真实付款 再为同供应商、同币种的一个或多个账单填写金额 留空的账单不参与本次核销 提交时服务端重新核对完整有效余额</p>
    {props.data.truncated && <p className="payables-message is-warning">可选列表不完整 不在列表中的账单或付款未被当作不存在 请先核对实际记录</p>}
    <RecordSelect label="用于核销的付款记录" value={paymentId} onChange={value => { setPaymentId(value); setDrafts({}); setChange("付款记录已变化 已清空旧分配金额 请按所选付款重新核对"); }} options={eligiblePayments.map(row => ({ id: row.id, label: `${row.externalPaymentId} · ${supplierName(props.data, row.supplierId)} · 未分配 ${formatFinanceMinorAmount(row.unallocatedMinor, row.currency)}` }))} />
    {change && <p className="payables-message" role="status">{change}</p>}
    {payment && <><div className="payables-allocation-basis"><strong>{payment.externalPaymentId} · {supplierName(props.data, payment.supplierId)}</strong><span>原登记付款 <Money value={payment.amountMinor} currency={payment.currency} /></span><span>本次打开时付款净额 <Money value={payment.netAmountMinor} currency={payment.currency} /></span><span>本次打开时未分配 <Money value={payment.unallocatedMinor} currency={payment.currency} /></span><small>人工登记付款证据 未经银行认证</small></div>
      {!bills.length && <p className="payables-help">本次已读取列表中没有同供应商、同币种且来源有效的待核销账单</p>}
      <div className="payables-allocation-lines">{bills.map(target => <section key={target.id} className="payables-allocation-line" aria-label={`账单分配 ${target.externalBillId}`}><div><strong>{target.externalBillId}{target.id === intent.billId ? " · 本次选中账单" : ""}</strong><span>{billNames[target.kind]} · 净额待核销 <Money value={target.outstandingMinor} currency={target.currency} /></span></div><AmountField label={`本次核销金额 ${target.externalBillId}`} currency={target.currency} value={drafts[target.id] ?? ""} required={false} onChange={value => setDrafts(rows => ({ ...rows, [target.id]: value }))} /></section>)}</div>
      <p className="payables-allocation-total">本次核销合计 {total === null ? "填写有效金额后核对" : formatFinanceMinorAmount(total, payment.currency)}</p>{draftError && <p className="payables-message is-error" role="alert">{draftError}</p>}
    </>}
  </PayableMutationForm>;
}

function ReleaseForm({ allocationId, ...props }: FormProps & { allocationId: string }) {
  const allocation = props.data.allocations.find(row => row.id === allocationId);
  return <PayableMutationForm {...props} title="撤销本笔核销" path={`allocations/${allocationId}/releases`} inputSchema={ReleaseFinanceAllocationInputSchema} resultSchema={FinanceAllocationReleaseViewSchema} submitLabel="确认撤销本笔核销" successMessage="本笔核销已撤销 未执行退款或资金转移" build={form => { if (!allocation || allocation.released) throw new Error("该笔核销当前不可撤销 请重新读取历史记录"); return { reasonCode: formText(form, "reasonCode") }; }} renderResult={release => <><h3>本笔核销已撤销</h3><p>原核销 <code>{release.allocationId}</code></p><p>原因代码 {release.reasonCode}</p><p>撤销凭据 <code>{release.id}</code></p><p>只释放账单与付款之间的核销占用 未执行退款或资金转移</p></>}>
    {allocation && <div className="payables-allocation-basis"><strong>{paymentName(props.data, allocation.paymentId)} → {billName(props.data, allocation.billId)}</strong><span>整笔撤销 <Money value={allocation.amountMinor} currency={allocation.currency} /></span><small>原核销凭据 {allocation.id}</small></div>}
    <p className="record-help">撤销整笔分配 恢复这笔核销占用的账单待核销额与付款未分配额 原核销和撤销凭据均保留 这不是实际退款</p>
    <Field label="撤销原因代码"><select name="reasonCode" required defaultValue=""><option value="">请选择经核对的原因</option><option value="WRONG_BILL">账单选择错误 WRONG_BILL</option><option value="WRONG_PAYMENT">付款选择错误 WRONG_PAYMENT</option><option value="AMOUNT_CORRECTION">金额分配需更正 AMOUNT_CORRECTION</option><option value="SOURCE_RECHECK">账单来源需重新核对 SOURCE_RECHECK</option><option value="OTHER_CONFIRMED">其他已核对原因 OTHER_CONFIRMED</option></select></Field>
  </PayableMutationForm>;
}

function PayableMutationForm<TInput, TResult>({ title, path, inputSchema, successMessage, build, children, permitted, submitDisabled = false, onClose, onSaved, onDenied, commandTargetId }: PayableMutationFormProps<TInput, TResult>) {
  const release = /^allocations\/([0-9a-f-]{36})\/releases$/i.exec(path), bill = /^bills\/([0-9a-f-]{36})\/adjustments$/i.exec(path), payment = /^payments\/([0-9a-f-]{36})\/adjustments$/i.exec(path);
  const scope: FinanceCommandScope = path === "bills" ? { kind: "bill_record", targetId: null } : path === "payments" ? { kind: "payment_record", targetId: null }
    : path === "allocations" ? { kind: "payment_allocate", targetId: commandTargetId ?? null }
      : release ? { kind: "allocation_release", targetId: release[1]!.toLowerCase() } : bill ? { kind: "bill_adjustment_record", targetId: bill[1]!.toLowerCase() }
        : payment ? { kind: "payment_adjustment_record", targetId: payment[1]!.toLowerCase() } : (() => { throw new Error("此财务表单尚未绑定实际原提交类型"); })();
  return <FinanceCommandForm title={title} scope={scope} permitted={permitted} submitDisabled={submitDisabled} onClose={onClose} onDenied={onDenied}
    build={(form, key) => PrepareFinanceCommandSchema.parse({ ...scope, input: inputSchema.parse({ ...build(form), idempotencyKey: key }) })}
    onCompleted={detail => { if (detail.result) onSaved(successMessage); }}>{children}</FinanceCommandForm>;
}

class PayableRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
async function requestPayables<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api/finance/payables/${path}`, { ...init, method: init.method ?? "GET", credentials: "same-origin", redirect: "error", cache: "no-store", signal: init.signal ?? AbortSignal.timeout(25_000), headers: init.body ? { "content-type": "application/json" } : undefined }); }
  catch { throw new PayableRequestError(0, "连接中断 登记结果尚未确认 请核对实际记录后再处理原请求"); }
  if (!response.ok) {
    const messages: Record<number, string> = { 400: "填写格式无效 请核对真实单号、时间、币种与金额", 401: "ERP 登录已失效 私有记录与填写已清除", 403: "当前权限不足 私有填写已清除 请重新核对权限", 404: "原供应商、账单、付款或核销记录不可读取 请刷新实际记录", 409: "记录、来源或可用余额已变化 请重新读取实际记录后核对", 422: "当前填写不符合账单与付款核销条件 请核对原始依据" };
    throw new PayableRequestError(response.status, messages[response.status] ?? "服务响应异常 登记结果尚未确认 请核对实际记录后再处理原请求");
  }
  try { const result = schema.safeParse(await response.json()); if (result.success) return result.data; }
  catch { /* A successful write without a readable receipt is still uncertain. */ }
  throw new PayableRequestError(502, "返回凭据暂时无法核对 请保留原请求并重新读取实际记录");
}
function isDenied(failure: unknown): failure is PayableRequestError { return failure instanceof PayableRequestError && (failure.status === 401 || failure.status === 403); }
function publicError(failure: unknown) { return failure instanceof PayableRequestError ? failure.message : "暂时无法读取实际账单与核销记录 请刷新后核对"; }
function formError(failure: unknown) {
  if (failure instanceof RangeError) {
    if (failure.message === "finance_amount_precision") return "金额小数位超过该币种精度 不会自动四舍五入 请核对原文";
    if (failure.message === "finance_currency_precision_unknown") return "该币种最小单位精度待核对 暂不能登记";
    if (failure.message === "finance_money_overflow") return "金额须大于零且不超过可精确登记的范围 请核对原文";
    return "请填写有效的十进制金额 不使用千位分隔符、符号或科学计数法";
  }
  if (failure instanceof Error && !("issues" in failure)) return failure.message;
  return "请核对真实供应商、单据标识、开具与到期时间及金额 采购账单还需真实发票ID";
}
function SupplierSelect({ data, value, onChange }: { data: FinancePayablesWorkspaceView; value: string; onChange(value: string): void }) {
  return <RecordSelect label="供应商" value={value} onChange={onChange} options={data.suppliers.map(supplier => ({ id: supplier.id, label: `${supplier.name}${supplier.status === "suspended" ? "（已暂停）" : supplier.status === "archived" ? "（已归档）" : ""}` }))} />;
}
function CurrencySelect({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) {
  return <Field label={label}><select required value={value} onChange={event => onChange(event.target.value)}>{currencies.map(currency => <option key={currency}>{currency}</option>)}</select></Field>;
}
function AmountField({ label, currency, value, required = true, onChange }: { label: string; currency: string; value: string; required?: boolean; onChange(value: string): void }) {
  const digits = financeCurrencyMinorDigits(currency);
  return <Field label={label} help={`${currency} 主货币单位 · ${digits === null ? "精度待核对" : digits === 0 ? "仅接受整数" : `最多 ${digits} 位小数`} · 不自动四舍五入${required ? "" : " 留空不核销本单"}`}><input type="text" inputMode="decimal" required={required} maxLength={32} value={value} onChange={event => onChange(event.target.value)} autoComplete="off" /></Field>;
}
function PanelHeading({ id, title, icon, count, action }: { id: string; title: string; icon: ReactNode; count: number; action?: ReactNode }) {
  return <header className="payables-panel-heading"><div>{icon}<h2 id={id}>{title}</h2><span>已读取 {count} 笔</span></div>{action}</header>;
}
function Empty({ children }: { children: ReactNode }) { return <p className="payables-empty" role="status">{children}</p>; }
function Money({ value, currency }: { value: number; currency: string }) { return <span className="payables-money">{formatFinanceMinorAmount(value, currency)}</span>; }
function supplierName(data: FinancePayablesWorkspaceView, id: string) { return data.suppliers.find(supplier => supplier.id === id)?.name ?? `供应商 ${id}`; }
function billName(data: FinancePayablesWorkspaceView, id: string) { return data.bills.find(bill => bill.id === id)?.externalBillId ?? `账单 ${id}`; }
function paymentName(data: FinancePayablesWorkspaceView, id: string) { return data.payments.find(payment => payment.id === id)?.externalPaymentId ?? `付款 ${id}`; }
function dateTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
