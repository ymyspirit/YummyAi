"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CircleAlert, FileCheck2, History, Link2 } from "lucide-react";
import type { z } from "zod";
import { financeCurrencyMinorDigits, formatFinanceMinorAmount } from "@yummyai/contracts/finance/monetary";
import { parseFinancePayableAmount, type FinancePayablesWorkspaceView } from "@yummyai/contracts/finance/payables";
import {
  FinanceBillAdjustmentViewSchema, FinancePaymentAdjustmentViewSchema,
  RecordFinanceBillAdjustmentInputSchema, RecordFinancePaymentAdjustmentInputSchema,
  type FinanceBillAdjustmentView, type FinanceBillBalance, type FinancePaymentAdjustmentView,
  type FinancePaymentBalance, type RecordFinanceBillAdjustmentInput, type RecordFinancePaymentAdjustmentInput,
} from "@yummyai/contracts/finance/payables-adjustments";
import { Field } from "../manual-operations/record-form";
import { formDate, formText, localDateTime } from "../manual-operations/operation-types";
import "./payables-adjustments.css";

export type PayableMutationFormProps<TInput, TResult> = {
  title: string; path: string; inputSchema: z.ZodType<TInput>; resultSchema: z.ZodType<TResult>;
  commandTargetId?: string | null;
  submitLabel: string; successMessage: string; build(form: FormData): object;
  renderResult(result: TResult): ReactNode; children: ReactNode; permitted: boolean; submitDisabled?: boolean;
  onClose(): void; onSaved(message: string): void; onDenied(message: string): void; onReload(): Promise<void>;
};
type MutationComponent = <TInput, TResult>(props: PayableMutationFormProps<TInput, TResult>) => ReactNode;
type AdjustmentFormProps = {
  data: FinancePayablesWorkspaceView; permitted: boolean; MutationForm: MutationComponent;
  onClose(): void; onSaved(message: string): void; onDenied(message: string): void; onReload(): Promise<void>;
};
type Bill = FinancePayablesWorkspaceView["bills"][number];
type Payment = FinancePayablesWorkspaceView["payments"][number];

export const billLifecycleNames = { active: "有效应付", fully_credited: "已全额贷记", voided: "应付记录已作废" };
export const paymentLifecycleNames = { active: "有效付款登记", fully_refunded: "已全额登记退款", voided: "付款登记已作废" };
const billEventNames = { credit: "应付贷项", debit: "应付补差", source_acknowledgement: "采购来源确认 无金额变化", void: "应付作废" };
const paymentEventNames = { refund: "已发生退款证据", void: "付款登记作废" };

export function PayableBillAdjustmentForm({ billId, MutationForm, ...props }: AdjustmentFormProps & { billId: string }) {
  const bill = props.data.bills.find(row => row.id === billId);
  const procurement = bill?.kind === "procurement_invoice";
  const typeMotion = useAdjustmentTypeTransition<RecordFinanceBillAdjustmentInput["kind"]>(procurement ? "procurement_sync" : "credit");
  const kind = typeMotion.kind, fieldKind = typeMotion.displayedKind;
  const [amount, setAmount] = useState(""), [candidateId, setCandidateId] = useState(""), [change, setChange] = useState("");
  const candidates = props.data.procurementAdjustments.filter(row => row.billId === billId && row.mappedEventId === null);
  const candidate = candidates.find(row => row.procurementAdjustmentId === candidateId);
  const actionReason = bill ? billActionReason(bill, kind, candidates.length) : "原应付记录未在本次读取范围内 请返回刷新后核对";
  const candidateReason = bill && kind === "procurement_sync" && candidate?.kind === "credit" && candidate.amountMinor > bill.outstandingMinor
    ? `所选采购贷项 ${formatFinanceMinorAmount(candidate.amountMinor, bill.currency)} 超过本次读取的净额待核销余额 ${formatFinanceMinorAmount(bill.outstandingMinor, bill.currency)} 请先在核销历史中撤销相关核销 再同步真实批准记录 并按调整后的净额重新分配`
    : "";
  const reason = actionReason || candidateReason;
  const build = (form: FormData) => {
    if (typeMotion.isChanging()) throw new Error("更正类型正在切换 请在填写区域就绪后重新核对");
    if (!bill) throw new Error("原应付记录当前不可读取 请返回刷新后核对");
    if (reason) throw new Error(reason);
    const basis = { expectedNetAmountMinor: bill.netAmountMinor };
    if (kind === "procurement_sync") {
      if (!candidate) throw new Error("请选择本账单真实已批准且尚未同步的采购调整");
      return { ...basis, kind, procurementAdjustmentId: candidate.procurementAdjustmentId, procurementReviewId: candidate.procurementReviewId };
    }
    const evidence = { evidenceReference: formText(form, "evidenceReference"), occurredAt: formDate(form, "occurredAt"), reasonCode: formText(form, "reasonCode") };
    if (kind === "void") return { ...basis, ...evidence, kind };
    if (procurement) throw new Error("采购账单只能同步真实已批准采购调整 不能手工改写贷项或补差");
    const amountMinor = parseFinancePayableAmount(amount, bill.currency);
    if (kind === "credit" && amountMinor > bill.outstandingMinor) throw new Error("贷项金额超过本次读取的净额待核销余额 请先撤销相关核销再核对");
    if (kind === "credit" && BigInt(bill.creditMinor) + BigInt(amountMinor) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("累计贷项金额超过可精确登记范围 请核对真实单据");
    if (kind === "debit" && BigInt(bill.debitMinor) + BigInt(amountMinor) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("累计补差金额超过可精确登记范围 请核对真实单据");
    if (kind === "debit" && BigInt(bill.netAmountMinor) + BigInt(amountMinor) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("补差后的应付净额超过可精确登记范围 请核对真实单据");
    return { ...basis, ...evidence, kind, amountMinor, externalDocumentId: formText(form, "externalDocumentId") };
  };
  return <MutationForm {...props} title="登记应付更正" path={`bills/${billId}/adjustments`} inputSchema={RecordFinanceBillAdjustmentInputSchema} resultSchema={FinanceBillAdjustmentViewSchema} submitLabel={kind === "procurement_sync" ? "同步已批准采购调整" : kind === "void" ? "确认登记应付作废" : "登记应付更正"} submitDisabled={typeMotion.changing || Boolean(reason) || kind === "procurement_sync" && !candidate} successMessage="应付更正已登记 已请求重新读取实际净额与核销记录 未发起付款" build={build} renderResult={event => <><h3>应付更正已登记</h3><p>{bill?.externalBillId ?? event.billId} · {billEventNames[event.kind]}</p><BillAdjustmentEvidence event={event} /><ExecutionBalance balance={event.balanceAfter} currency={event.currency} recordedAt={event.recordedAt} /><p>原账单与原采购凭据保留 未修改库存 未发起付款</p></>}>
    <p className="record-help">只登记已经发生且经人工核对的更正 不改写原账单金额 不发起转账 原请求使用本次打开时的净额作为并发核对依据</p>
    {bill && <BillOpeningBasis bill={bill} data={props.data} />}
    <Field label="应付更正类型"><select value={kind} onChange={event => { typeMotion.select(event.target.value as RecordFinanceBillAdjustmentInput["kind"]); setAmount(""); setCandidateId(""); setChange("更正类型已变化 已清空本次金额、证据填写与采购选择 请重新核对单据"); }}>{procurement ? <option value="procurement_sync">同步已批准采购调整</option> : <><option value="credit">贷项 减少应付净额</option><option value="debit">补差 增加应付净额</option></>}<option value="void">作废应付记录</option></select></Field>
    {change && <p className="payables-message" role="status">{change}</p>}
    {reason && <p className="payables-message is-warning" role="status"><CircleAlert size={15} />{reason}</p>}
    <AdjustmentTypeFields key={typeMotion.generation} label="本次应付更正字段" phase={typeMotion.phase}>
    {fieldKind === "procurement_sync" ? <>
      <p className="record-help">只选择服务端读取的真实批准记录 金额、币种、实际发生时间与审核凭据均沿用原采购依据 不手工补造</p>
      <Field label="已批准采购调整" help="仅列出本账单已读取且尚未同步的批准记录 零金额来源调整仍需明确确认"><select required disabled={typeMotion.changing} value={candidateId} onChange={event => setCandidateId(event.target.value)}><option value="">请选择已批准采购调整</option>{candidates.map(row => <option key={row.procurementAdjustmentId} value={row.procurementAdjustmentId}>{row.externalDocumentId} · {row.kind === "credit" ? "贷项" : "补差"} · {formatFinanceMinorAmount(row.amountMinor, bill?.currency ?? "")} · {row.procurementAdjustmentId}</option>)}</select></Field>
      {candidate && <dl className="payables-adjustment-basis" aria-label="所选采购调整依据"><Pair label="原供应商单据">{candidate.externalDocumentId}</Pair><Pair label="实际批准金额"><Money value={candidate.amountMinor} currency={bill?.currency ?? ""} />{candidate.amountMinor === 0 && <small>仅确认采购来源或数量依据 不新增应付金额</small>}</Pair><Pair label="原证据标识"><code>{candidate.evidenceReference}</code></Pair><Pair label="实际发生时间">{dateTime(candidate.occurredAt)}</Pair><Pair label="采购调整凭据"><code>{candidate.procurementAdjustmentId}</code></Pair><Pair label="实际批准凭据"><code>{candidate.procurementReviewId}</code></Pair></dl>}
      {props.data.truncated && <p className="payables-message is-warning">已读取候选不完整 不在本页的批准记录未被当作不存在 请先核对完整采购来源</p>}
      <ProcurementSourceDiagnostics data={props.data} billId={billId} />
    </> : <div className="payables-adjustment-fields">
      {fieldKind !== "void" && <AdjustmentAmount label={fieldKind === "credit" ? "贷项金额（主货币单位）" : "补差金额（主货币单位）"} value={amount} currency={bill?.currency ?? ""} onChange={setAmount} disabled={typeMotion.changing} />}
      <ManualEvidence documentRequired={fieldKind !== "void"} disabled={typeMotion.changing} />
      {fieldKind === "credit" && bill && <p className="record-help">本次读取的可贷记上限为净额待核销余额 <Money value={bill.outstandingMinor} currency={bill.currency} /> 已核销部分须先在原核销历史中撤销</p>}
      {fieldKind === "void" && <p className="payables-message is-warning">作废只终止这笔账面应付记录 不代表供应商已退款或银行交易撤回 采购账单必须已完成来源核对且净额为零</p>}
    </div>}
    </AdjustmentTypeFields>
  </MutationForm>;
}

export function PayablePaymentAdjustmentForm({ paymentId, MutationForm, ...props }: AdjustmentFormProps & { paymentId: string }) {
  const payment = props.data.payments.find(row => row.id === paymentId);
  const typeMotion = useAdjustmentTypeTransition<RecordFinancePaymentAdjustmentInput["kind"]>("refund");
  const kind = typeMotion.kind, fieldKind = typeMotion.displayedKind;
  const [amount, setAmount] = useState(""), [change, setChange] = useState("");
  const reason = payment ? paymentActionReason(payment, kind) : "原付款证据未在本次读取范围内 请返回刷新后核对";
  return <MutationForm {...props} title="登记付款更正" path={`payments/${paymentId}/adjustments`} inputSchema={RecordFinancePaymentAdjustmentInputSchema} resultSchema={FinancePaymentAdjustmentViewSchema} submitLabel={kind === "refund" ? "登记已发生退款证据" : "确认登记付款作废"} submitDisabled={typeMotion.changing || Boolean(reason)} successMessage="付款更正已登记 已请求重新读取实际净额与核销记录 未执行银行退款" build={form => {
    if (typeMotion.isChanging()) throw new Error("更正类型正在切换 请在填写区域就绪后重新核对");
    if (!payment) throw new Error("原付款证据当前不可读取 请返回刷新后核对");
    if (reason) throw new Error(reason);
    const basis = { expectedNetAmountMinor: payment.netAmountMinor, evidenceReference: formText(form, "evidenceReference"), occurredAt: formDate(form, "occurredAt"), reasonCode: formText(form, "reasonCode") };
    if (kind === "void") return { ...basis, kind };
    const amountMinor = parseFinancePayableAmount(amount, payment.currency);
    if (amountMinor > payment.unallocatedMinor) throw new Error("退款金额超过本次读取的付款未分配余额 请先撤销相关核销再核对");
    return { ...basis, kind, amountMinor, externalDocumentId: formText(form, "externalDocumentId") };
  }} renderResult={event => <><h3>付款更正已登记</h3><p>{payment?.externalPaymentId ?? event.paymentId} · {paymentEventNames[event.kind]}</p><PaymentAdjustmentEvidence event={event} /><ExecutionBalance balance={event.balanceAfter} currency={event.currency} recordedAt={event.recordedAt} /><p>这是经人工登记的证据 未经银行认证 此页面未发起退款、扣款或转账</p></>}>
    <p className="record-help">退款仅登记已经发生的实际退款证据 作废仅终止错误付款登记 不操作银行账户 不更改原始付款金额</p>
    {payment && <dl className="payables-adjustment-basis" aria-label="付款更正原依据"><Pair label="原付款记录">{payment.externalPaymentId}</Pair><Pair label="供应商">{supplierName(props.data, payment.supplierId)}</Pair><Pair label="原登记金额"><Money value={payment.amountMinor} currency={payment.currency} /></Pair><Pair label="本次打开时净额"><Money value={payment.netAmountMinor} currency={payment.currency} /></Pair><Pair label="本次打开时已核销"><Money value={payment.allocatedMinor} currency={payment.currency} /></Pair><Pair label="本次打开时未分配"><Money value={payment.unallocatedMinor} currency={payment.currency} /></Pair><Pair label="已登记退款"><Money value={payment.refundedMinor} currency={payment.currency} /></Pair><Pair label="登记生命周期">{paymentLifecycleNames[payment.lifecycle]}</Pair><Pair label="原证据标识"><code>{payment.evidenceReference}</code></Pair></dl>}
    <Field label="付款更正类型"><select value={kind} onChange={event => { typeMotion.select(event.target.value as RecordFinancePaymentAdjustmentInput["kind"]); setAmount(""); setChange("更正类型已变化 已清空本次退款金额与证据填写 请重新核对证据"); }}><option value="refund">登记已发生退款</option><option value="void">作废付款登记</option></select></Field>
    {change && <p className="payables-message" role="status">{change}</p>}
    {reason && <p className="payables-message is-warning" role="status"><CircleAlert size={15} />{reason}</p>}
    <AdjustmentTypeFields key={typeMotion.generation} label="本次付款更正字段" phase={typeMotion.phase}>
    <div className="payables-adjustment-fields">{fieldKind === "refund" && <AdjustmentAmount label="已发生退款金额（主货币单位）" currency={payment?.currency ?? ""} value={amount} onChange={setAmount} disabled={typeMotion.changing} />}<ManualEvidence documentRequired={fieldKind === "refund"} disabled={typeMotion.changing} /></div>
    {fieldKind === "refund" && payment && <p className="record-help">本次读取的可登记退款上限为未分配余额 <Money value={payment.unallocatedMinor} currency={payment.currency} /> 已核销部分须先撤销对应核销</p>}
    {fieldKind === "void" && <p className="payables-message is-warning">付款登记仅在没有有效核销且没有已登记退款时允许作废 原付款证据与作废凭据始终保留</p>}
    </AdjustmentTypeFields>
  </MutationForm>;
}

export function PayableAdjustmentsHistory({ data }: { data: FinancePayablesWorkspaceView }) {
  return <section className="payables-panel payables-adjustments" aria-labelledby="payables-adjustments-title">
    <header className="payables-panel-heading"><div><History size={17} /><h2 id="payables-adjustments-title">应付更正与付款更正历史</h2><span>已读取 {data.billAdjustments.length + data.paymentAdjustments.length} 笔</span></div></header>
    <p className="payables-help">凭据与原金额保留 下列余额是该次执行时快照 当前净额请核对上方刷新后的账单与付款表 不按截断历史推算余额</p>
    {!data.billAdjustments.length && !data.paymentAdjustments.length && <p className="payables-empty" role="status">当前已读取列表中没有应付更正或付款更正凭据 不代表外部账单或银行已验真</p>}
    <div className="payables-adjustment-groups">
      {data.billAdjustments.length > 0 && <div><h3>应付更正凭据</h3><ol className="payables-adjustment-history">{data.billAdjustments.map(event => <li key={event.id} aria-label={`应付更正凭据 ${event.id}`}><div className="payables-adjustment-heading"><FileCheck2 size={15} /><strong>{data.bills.find(row => row.id === event.billId)?.externalBillId ?? `账单 ${event.billId}`} · {billEventNames[event.kind]}</strong><Money value={event.amountMinor} currency={event.currency} /></div><BillAdjustmentEvidence event={event} /><details className="payables-adjustment-details"><summary>查看该次执行时余额</summary><ExecutionBalance balance={event.balanceAfter} currency={event.currency} recordedAt={event.recordedAt} /></details></li>)}</ol></div>}
      {data.paymentAdjustments.length > 0 && <div><h3>付款更正凭据</h3><ol className="payables-adjustment-history">{data.paymentAdjustments.map(event => <li key={event.id} aria-label={`付款更正凭据 ${event.id}`}><div className="payables-adjustment-heading"><FileCheck2 size={15} /><strong>{data.payments.find(row => row.id === event.paymentId)?.externalPaymentId ?? `付款 ${event.paymentId}`} · {paymentEventNames[event.kind]}</strong><Money value={event.amountMinor} currency={event.currency} /></div><PaymentAdjustmentEvidence event={event} /><details className="payables-adjustment-details"><summary>查看该次执行时余额</summary><ExecutionBalance balance={event.balanceAfter} currency={event.currency} recordedAt={event.recordedAt} /></details></li>)}</ol></div>}
    </div>
    <ProcurementSourceDiagnostics data={data} />
    {data.procurementAdjustments.some(row => row.mappedEventId !== null) && <details className="payables-adjustment-details payables-source-mappings"><summary>查看已读取的采购同步关联</summary><ol>{data.procurementAdjustments.filter(row => row.mappedEventId !== null).map(row => <li key={`${row.billId}-${row.procurementAdjustmentId}`}><strong>{data.bills.find(bill => bill.id === row.billId)?.externalBillId ?? `账单 ${row.billId}`} · {row.externalDocumentId}</strong><span>已关联应付更正 <code>{row.mappedEventId}</code></span><span>采购调整 <code>{row.procurementAdjustmentId}</code></span><span>实际批准 <code>{row.procurementReviewId}</code></span></li>)}</ol></details>}
  </section>;
}

function billActionReason(bill: Bill, kind: RecordFinanceBillAdjustmentInput["kind"], candidateCount: number) {
  if (bill.lifecycle === "voided") return "应付记录已作废 后续更正与新核销已停止 原凭据仍可查阅";
  if (kind === "procurement_sync") return bill.kind !== "procurement_invoice" ? "只有真实采购账单可以同步采购批准记录" : candidateCount === 0 ? "本次已读取列表中没有可同步的批准记录 请核对采购调整及读取范围" : "";
  if (bill.kind === "procurement_invoice" && kind !== "void") return "采购账单只允许同步真实批准的采购调整";
  if (kind === "credit" && bill.outstandingMinor === 0) return "净额已无待核销余额 如需贷记已核销部分 请先撤销对应核销";
  if (kind === "void") {
    if (bill.allocatedMinor > 0) return "应付仍有有效核销 请先撤销对应核销后再核对作废条件";
    if (bill.kind === "procurement_invoice" && (bill.netAmountMinor !== 0 || bill.sourceStatus !== "current")) return "采购账单须净额为零且来源核对有效后才能作废 请先处理真实采购差异并同步批准记录";
  }
  return "";
}
function paymentActionReason(payment: Payment, kind: RecordFinancePaymentAdjustmentInput["kind"]) {
  if (payment.lifecycle === "voided") return "付款登记已作废 后续退款登记与新核销已停止 原凭据仍可查阅";
  if (kind === "refund" && payment.unallocatedMinor === 0) return payment.allocatedMinor > 0 ? "当前没有未分配余额 如需登记已核销部分的退款 请先撤销对应核销" : "该笔付款已全额登记退款 不可重复登记退款";
  if (kind === "void" && payment.refundedMinor > 0) return "付款已有退款凭据 不允许再作废原付款登记";
  if (kind === "void" && payment.allocatedMinor > 0) return "付款仍有有效核销 请先撤销对应核销后再核对作废条件";
  return "";
}
function BillOpeningBasis({ bill, data }: { bill: Bill; data: FinancePayablesWorkspaceView }) {
  return <dl className="payables-adjustment-basis" aria-label="应付更正原依据"><Pair label="原应付账单">{bill.externalBillId}</Pair><Pair label="供应商">{supplierName(data, bill.supplierId)}</Pair><Pair label="原账单金额"><Money value={bill.amountMinor} currency={bill.currency} /></Pair><Pair label="本次打开时净额"><Money value={bill.netAmountMinor} currency={bill.currency} /></Pair><Pair label="本次打开时已核销"><Money value={bill.allocatedMinor} currency={bill.currency} /></Pair><Pair label="本次打开时待核销"><Money value={bill.outstandingMinor} currency={bill.currency} /></Pair><Pair label="记录生命周期">{billLifecycleNames[bill.lifecycle]}</Pair>{bill.procurementInvoiceId && <Pair label="原采购实际发票"><code>{bill.procurementInvoiceId}</code></Pair>}{bill.procurementProofId && <Pair label="原采购发票凭据"><code>{bill.procurementProofId}</code></Pair>}</dl>;
}
function ManualEvidence({ documentRequired, disabled = false }: { documentRequired: boolean; disabled?: boolean }) {
  return <div className="record-grid">{documentRequired && <Field label="外部更正单据编号" help="填写真实贷项、补差或退款单据的业务编号 不代表平台已向外部验真"><input name="externalDocumentId" required disabled={disabled} maxLength={160} autoComplete="off" /></Field>}<Field label="证据流水标识" help="仅填可复核的安全业务标识 不填银行账号、个人信息、密码或完整银行回单"><input name="evidenceReference" required disabled={disabled} maxLength={2000} autoComplete="off" /></Field><Field label="实际发生时间"><input name="occurredAt" type="datetime-local" required disabled={disabled} defaultValue={localDateTime()} /></Field><Field label="原因代码" help="使用大写字母、数字、点、下划线或连字符"><input name="reasonCode" required disabled={disabled} maxLength={100} pattern={"[A-Z0-9][A-Z0-9._\\-]*"} autoComplete="off" /></Field></div>;
}
function AdjustmentAmount({ label, currency, value, onChange, disabled = false }: { label: string; currency: string; value: string; onChange(value: string): void; disabled?: boolean }) {
  const digits = financeCurrencyMinorDigits(currency);
  return <Field label={label} help={`${currency} 主货币单位 · ${digits === null ? "精度待核对" : digits === 0 ? "仅接受整数" : `最多 ${digits} 位小数`} · 不自动四舍五入`}><input type="text" inputMode="decimal" required disabled={disabled} maxLength={32} value={value} onChange={event => onChange(event.target.value)} autoComplete="off" /></Field>;
}
type AdjustmentTypePhase = "idle" | "exiting" | "entering";
function AdjustmentTypeFields({ label, phase, children }: { label: string; phase: AdjustmentTypePhase; children: ReactNode }) {
  const changing = phase !== "idle";
  return <fieldset className={`payables-type-fields is-${phase}`} aria-label={label} aria-busy={changing} aria-disabled={changing} inert={changing}>{children}</fieldset>;
}
function useAdjustmentTypeTransition<TKind extends string>(initialKind: TKind) {
  const [kind, setKind] = useState(initialKind);
  const [view, setView] = useState<{ kind: TKind; generation: number; phase: AdjustmentTypePhase }>({ kind: initialKind, generation: 0, phase: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null), epoch = useRef(0), moving = useRef(false), selected = useRef(initialKind);
  const clearTimer = useCallback(() => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const settleReducedMotion = () => {
      if (!media.matches || !moving.current) return;
      clearTimer(); moving.current = false;
      setView({ kind: selected.current, generation: ++epoch.current, phase: "idle" });
    };
    media.addEventListener("change", settleReducedMotion);
    return () => { epoch.current++; moving.current = false; clearTimer(); media.removeEventListener("change", settleReducedMotion); };
  }, [clearTimer]);
  const select = (nextKind: TKind) => {
    clearTimer(); const generation = ++epoch.current;
    selected.current = nextKind; setKind(nextKind);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      moving.current = false; setView({ kind: nextKind, generation, phase: "idle" }); return;
    }
    moving.current = true; setView(current => ({ ...current, phase: "exiting" }));
    timer.current = setTimeout(() => {
      if (epoch.current !== generation) return;
      setView({ kind: nextKind, generation, phase: "entering" });
      timer.current = setTimeout(() => {
        if (epoch.current !== generation) return;
        timer.current = null; moving.current = false;
        setView(current => ({ ...current, phase: "idle" }));
      }, 160);
    }, 160);
  };
  return { kind, displayedKind: view.kind, generation: view.generation, phase: view.phase, changing: view.phase !== "idle", isChanging: () => moving.current, select };
}
function BillAdjustmentEvidence({ event }: { event: FinanceBillAdjustmentView }) {
  return <dl className="payables-adjustment-evidence"><Pair label="更正凭据"><code>{event.id}</code></Pair><Pair label="原应付记录"><code>{event.billId}</code></Pair><Pair label="本笔更正金额"><Money value={event.amountMinor} currency={event.currency} /></Pair>{event.externalDocumentId && <Pair label="外部单据编号">{event.externalDocumentId}<small>人工登记的单据引用 未经外部验真</small></Pair>}<EvidenceFields event={event} />{event.procurementAdjustmentId && <Pair label="采购调整凭据"><Link2 size={13} /><code>{event.procurementAdjustmentId}</code></Pair>}{event.procurementReviewId && <Pair label="实际批准凭据"><code>{event.procurementReviewId}</code></Pair>}</dl>;
}
function PaymentAdjustmentEvidence({ event }: { event: FinancePaymentAdjustmentView }) {
  return <dl className="payables-adjustment-evidence"><Pair label="更正凭据"><code>{event.id}</code></Pair><Pair label="原付款记录"><code>{event.paymentId}</code></Pair><Pair label="本笔更正金额"><Money value={event.amountMinor} currency={event.currency} /></Pair>{event.externalDocumentId && <Pair label="实际退款单据编号">{event.externalDocumentId}</Pair>}<EvidenceFields event={event} /><Pair label="证据状态">人工登记 未经银行认证</Pair></dl>;
}
function EvidenceFields({ event }: { event: { evidenceReference: string; reasonCode: string; occurredAt: string; recordedAt: string } }) {
  return <><Pair label="证据流水标识"><code>{event.evidenceReference}</code></Pair><Pair label="原因代码">{event.reasonCode}</Pair><Pair label="实际发生时间">{dateTime(event.occurredAt)}</Pair><Pair label="登记时间">{dateTime(event.recordedAt)}</Pair></>;
}
function ExecutionBalance({ balance, currency, recordedAt }: { balance: FinanceBillBalance | FinancePaymentBalance; currency: string; recordedAt: string }) {
  const bill = "outstandingMinor" in balance;
  return <div className="payables-execution-balance" aria-label="该次执行时余额"><strong>该次执行时余额</strong><p>{dateTime(recordedAt)} 的执行快照 后续核销或更正可能已变化 不是当前余额</p><dl><Pair label={bill ? "原账单金额" : "原付款金额"}><Money value={balance.amountMinor} currency={currency} /></Pair>{bill ? <><Pair label="累计贷项"><Money value={balance.creditMinor} currency={currency} /></Pair><Pair label="累计补差"><Money value={balance.debitMinor} currency={currency} /></Pair></> : <Pair label="累计退款"><Money value={balance.refundedMinor} currency={currency} /></Pair>}<Pair label="累计作废额"><Money value={balance.voidedMinor} currency={currency} /></Pair><Pair label="执行后净额"><Money value={balance.netAmountMinor} currency={currency} /></Pair><Pair label="执行时已核销"><Money value={balance.allocatedMinor} currency={currency} /></Pair><Pair label={bill ? "执行时待核销" : "执行时未分配"}><Money value={bill ? balance.outstandingMinor : balance.unallocatedMinor} currency={currency} /></Pair><Pair label="执行后生命周期">{bill ? billLifecycleNames[balance.lifecycle] : paymentLifecycleNames[balance.lifecycle]}</Pair></dl></div>;
}
function ProcurementSourceDiagnostics({ data, billId }: { data: FinancePayablesWorkspaceView; billId?: string }) {
  const diagnostics = data.procurementAdjustmentDiagnostics.filter(row => !billId || row.billId === billId);
  if (!diagnostics.length) return null;
  return <div className="payables-message is-warning payables-procurement-diagnostics" role="status"><CircleAlert size={15} /><strong>来源格式无法精确同步 请核对原采购凭据</strong><p>原格式未被清洗或替换 下列凭据未转成可选同步记录 不推测金额或实际发生时间</p><ol>{diagnostics.map(row => <li key={`${row.billId}-${row.procurementAdjustmentId}-${row.procurementReviewId}`}><span>应付记录 <code>{row.billId}</code></span><span>采购调整 <code>{row.procurementAdjustmentId}</code></span><span>实际批准 <code>{row.procurementReviewId}</code></span></li>)}</ol></div>;
}
function Pair({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
function Money({ value, currency }: { value: number; currency: string }) { return <span className="payables-money">{formatFinanceMinorAmount(value, currency)}</span>; }
function supplierName(data: FinancePayablesWorkspaceView, id: string) { return data.suppliers.find(row => row.id === id)?.name ?? `供应商 ${id}`; }
function dateTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)); }
