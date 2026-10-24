"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ClipboardList, RefreshCw, RotateCcw } from "lucide-react";
import type { z } from "zod";
import { Permission } from "@yummyai/authz/permissions";
import type { ProcurementInvoiceView, ProcurementWorkspaceView } from "@yummyai/contracts/procurement";
import { ProcurementCommandListSchema, ProcurementCommandViewSchema, type ProcurementCommandView,
  type PrepareProcurementCommand, type ProcurementReviewBasis } from "@yummyai/contracts/procurement/procurement-command";
import { formatMinorAmount } from "@yummyai/contracts/common/money";
import { formatStockQuantity } from "@yummyai/contracts/inventory/quantity";
import { procurementAmountMinor, sumProcurementMinor } from "@yummyai/contracts/procurement/measurement";
import { InvoiceReconciliationDetailSchema, type InvoiceReconciliationBalance, type InvoiceReconciliationDetail,
  type InvoiceReconciliationInput, type SupplierAdjustmentView } from "@yummyai/contracts/procurement/invoice-reconciliation";
import { useRouter } from "next/navigation";
import { useErpAccess } from "../identity/erp-access";
import { useOwnedViewTransition } from "../navigation/use-owned-view-transition";
import { RecordDialog } from "../manual-operations/record-form";
import { AgentOperationHandoff } from "../ai-tasks/agent-operation-handoff";
import { unitNames } from "../manual-operations/operation-types";
import { procurementCommandRequest, procurementCommandDenied, ProcurementCommandRequestError } from "../../lib/procurement-command-client";
import { ProcurementCycleForm, ProcurementMeasure, procurementActionNames, procurementCommandStatusNames, procurementTime, type ProcurementCycleDraft } from "./procurement-cycle-form";
import { createProcurementWriteActivity, procurementCommandReadPath } from "./procurement-command-lifecycle";

export function ProcurementCycleLauncher({ data, kind, targetId = null, quoteId, children, primary = false }: {
  data: ProcurementWorkspaceView; kind: ProcurementCycleDraft["kind"]; targetId?: string | null; quoteId?: string; children: React.ReactNode; primary?: boolean;
}) {
  const access = useErpAccess(), router = useRouter(), [draft, setDraft] = useState<ProcurementCycleDraft | null>(null);
  const canWrite = access.can(Permission.ProcurementRead) && access.can(kind === "purchase_review" ? Permission.ProcurementApprove : Permission.ProcurementWrite);
  return <><button type="button" className={primary ? "primary" : undefined} disabled={!canWrite} onClick={() => setDraft({ id: crypto.randomUUID(), kind, targetId, quoteId })}>{children}</button>
    {draft && <ProcurementCycleDialog data={data} initialDraft={draft} onClose={() => setDraft(null)} onChanged={() => router.refresh()} />}</>;
}

/** Global recovery is independent of the workspace's current 100 business rows. */
export function ProcurementCommandWorkbench({ data }: { data: ProcurementWorkspaceView }) {
  const access = useErpAccess(), router = useRouter(), [commandId, setCommandId] = useState<string | null>(null);
  const identity = useMemo(() => ({ authority: access.authority, localDevelopment: access.localDevelopment }), [access.authority, access.localDevelopment]);
  const [items, setItems] = useState<ProcurementCommandView[]>([]), [cursor, setCursor] = useState<string | null>(null), [reading, setReading] = useState(false), [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(0), sequence = useRef(0), live = useRef(true), controller = useRef<AbortController | null>(null);
  const canRead = access.can(Permission.ProcurementRead);
  const reload = useCallback(async (before?: string) => {
    const token = ++sequence.current; controller.current?.abort(); const abort = new AbortController(); controller.current = abort; setReading(true);
    try {
      const result = await procurementCommandRequest(`commands${before ? "?before=" + before : ""}`, ProcurementCommandListSchema, identity, undefined, abort.signal);
      if (!live.current || token !== sequence.current) return;
      setItems(previous => before ? [...new Map([...previous, ...result.items].map(row => [row.id, row])).values()] : result.items); setCursor(result.nextCursor);
      setUnavailable(previous => before ? previous + result.unavailableCount : result.unavailableCount); setError("");
    } catch (failure) {
      if (abort.signal.aborted || !live.current || token !== sequence.current) return;
      if (procurementCommandDenied(failure)) { setItems([]); setCursor(null); setUnavailable(0); setCommandId(null); }
      setError(failure instanceof Error ? failure.message : "暂时无法读取采购原提交");
    } finally { if (live.current && token === sequence.current) setReading(false); }
  }, [identity]);
  useLayoutEffect(() => { sequence.current++; controller.current?.abort(); setItems([]); setCursor(null); setUnavailable(0); setCommandId(null); setError(""); setReading(false); }, [identity, canRead]);
  useEffect(() => { live.current = true; if (canRead) void reload(); return () => { live.current = false; sequence.current++; controller.current?.abort(); }; }, [reload, canRead]);
  useEffect(() => { const check = () => { if (document.visibilityState === "visible" && canRead) void reload(); }; window.addEventListener("focus", check); document.addEventListener("visibilitychange", check); return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); }; }, [reload, canRead]);
  return <section className="procurement-cycle procurement-cycle-recovery" aria-label="待核对的采购提交"><ProcurementCycleStyles />
    <header><div><ClipboardList size={16} /><h2>待核对的采购提交</h2><span>{items.length}{cursor ? "+" : ""}</span></div><button type="button" disabled={reading || !canRead} onClick={() => void reload()}><RefreshCw size={14} />{reading ? "正在读取" : "重新读取原提交"}</button></header>
    <p className="record-help">本人尚未确认的原填写和实际结果 跨页面、刷新或重新登录后可继续核对</p>
    {error && <p className="record-notice error" role="alert">{error}</p>}
    {!canRead && <p className="record-help">当前没有采购读取权限</p>}
    {canRead && !items.length && !error && <p className="record-help" role="status">{reading ? "正在读取本人待确认记录" : "当前没有待核对的采购提交"}</p>}
    {!!items.length && <ul>{items.map(row => <li key={row.id}><div><strong>{procurementActionNames[row.kind]} · {row.targetLabel}</strong><span>{procurementCommandStatusNames[row.status]} · {procurementTime(row.createdAt)}</span></div><button type="button" disabled={reading} onClick={() => setCommandId(row.id)}>恢复原提交</button></li>)}</ul>}
    {unavailable > 0 && <p className="record-notice">{unavailable} 笔原提交的业务依据当前不可访问 未显示私有填写 请核对当前权限</p>}
    {cursor && <button type="button" disabled={reading} onClick={() => void reload(cursor)}>读取更早的原提交</button>}
    {commandId && <ProcurementCycleDialog data={data} commandId={commandId} onClose={() => setCommandId(null)} onChanged={() => { void reload(); router.refresh(); }} />}
  </section>;
}

export type ProcurementExternalForm = { kind: "supply_purchase_create" | "invoice_record" | "invoice_reconcile"; targetId: string; render(props: { disabled: boolean; onPrepare(input: PrepareProcurementCommand): Promise<void>; onClose(): void }): React.ReactNode };
export function ProcurementCycleDialog({ data, initialDraft, commandId, externalForm, onCompleted, onClose, onChanged }: {
  data: ProcurementWorkspaceView; initialDraft?: ProcurementCycleDraft; commandId?: string; externalForm?: ProcurementExternalForm;
  onCompleted?(record: Record<string, unknown>): void; onClose(): void; onChanged(): void;
}) {
  const access = useErpAccess(), identity = useMemo(() => ({ authority: access.authority, localDevelopment: access.localDevelopment }), [access.authority, access.localDevelopment]);
  const [draft, setDraft] = useState<ProcurementCycleDraft | null>(null), [command, setCommand] = useState<ProcurementCommandView | null>(null), [showExternal, setShowExternal] = useState(false);
  const [items, setItems] = useState<ProcurementCommandView[]>([]), [cursor, setCursor] = useState<string | null>(null), [unavailable, setUnavailable] = useState(0);
  const [reading, setReading] = useState(false), [working, setWorking] = useState(false), [error, setError] = useState(""), [denied, setDenied] = useState(false), [uncertain, setUncertain] = useState(false), [closing, setClosing] = useState(false);
  const transition = useOwnedViewTransition(), epoch = useRef(0), readToken = useRef(0), live = useRef(true), initialized = useRef(false);
  const [activity] = useState(createProcurementWriteActivity);
  const opening = useRef({ initialDraft, externalForm }); opening.current = { initialDraft, externalForm };
  const openingKey = initialDraft?.id ?? (externalForm ? `${externalForm.kind}:${externalForm.targetId}` : "recovery");
  const currentCommand = useRef(command), attempted = useRef<PrepareProcurementCommand | null>(null), readAbort = useRef<AbortController | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeAuthority = useRef(identity.authority), closingRef = useRef(closing); activeAuthority.current = identity.authority; currentCommand.current = command; closingRef.current = closing;
  const valid = (captured: number, authority: string | null) => live.current && epoch.current === captured && activeAuthority.current === authority;
  const revoke = useCallback(() => {
    epoch.current++; readToken.current++; readAbort.current?.abort(); transition.cancel(); activity.revoke(); attempted.current = null; initialized.current = false;
    setDraft(null); setShowExternal(false); setCommand(null); setItems([]); setCursor(null); setUnavailable(0); setReading(false); setWorking(false); setUncertain(false); setDenied(true);
    setError("当前访问权限或会话已变化 已清除本页私有填写 请重新读取");
  }, [transition, activity]);
  const reload = useCallback(async (before?: string) => {
    if (activity.busy || closingRef.current) return;
    const captured = epoch.current, authority = identity.authority, token = ++readToken.current;
    readAbort.current?.abort(); const abort = new AbortController(); readAbort.current = abort; setReading(true);
    try {
      const { initialDraft, externalForm } = opening.current;
      const scope = currentCommand.current ?? attempted.current ?? initialDraft ?? externalForm ?? null;
      const result = await procurementCommandRequest(procurementCommandReadPath(scope, before), ProcurementCommandListSchema, identity, undefined, abort.signal);
      if (!valid(captured, authority) || token !== readToken.current) return;
      setItems(previous => before ? [...new Map([...previous, ...result.items].map(row => [row.id, row])).values()] : result.items); setCursor(result.nextCursor);
      setUnavailable(previous => before ? previous + result.unavailableCount : result.unavailableCount); setError(""); setDenied(false);
      const selectedId = currentCommand.current?.id ?? (!initialized.current ? commandId : undefined);
      if (selectedId) {
        const actual = await procurementCommandRequest(`commands/${selectedId}`, ProcurementCommandViewSchema, identity, undefined, abort.signal);
        if (!valid(captured, authority) || token !== readToken.current) return;
        transition.change(() => { setCommand(actual); setDraft(null); setShowExternal(false); setUncertain(false); }); initialized.current = true;
      } else if (attempted.current) {
        const original = attempted.current, recovered = result.items.find(row => row.kind === original.kind && row.targetId === original.targetId && row.original?.input.idempotencyKey === original.input.idempotencyKey);
        if (recovered) transition.change(() => { setCommand(recovered); setDraft(null); setShowExternal(false); setUncertain(false); });
      } else if (!initialized.current) {
        const existing = scope && result.items.find(row => row.kind === scope.kind && row.targetId === scope.targetId);
        if (scope && !existing && result.unavailableCount > 0) throw new ProcurementCommandRequestError(409, "此操作已有原提交的业务依据当前不可访问 请先核对权限与原结果");
        initialized.current = true;
        transition.change(() => { setCommand(existing ?? null); setDraft(existing ? null : initialDraft ?? null); setShowExternal(Boolean(externalForm && !existing)); });
      }
    } catch (failure) {
      if (abort.signal.aborted || !valid(captured, authority) || token !== readToken.current) return;
      if (procurementCommandDenied(failure)) revoke(); else setError(failure instanceof Error ? failure.message : "暂时无法读取采购记录");
    } finally { if (valid(captured, authority) && token === readToken.current) setReading(false); }
  }, [identity, commandId, openingKey, transition, revoke, activity]);
  useLayoutEffect(() => { revoke(); setDenied(false); setError(""); }, [identity, revoke]);
  useEffect(() => { live.current = true; if (access.can(Permission.ProcurementRead)) void reload(); else revoke(); return () => { live.current = false; epoch.current++; readToken.current++; readAbort.current?.abort(); if (timer.current) clearTimeout(timer.current); }; }, [reload, access.authority, access.localDevelopment, revoke]);
  useEffect(() => { const check = () => { if (document.visibilityState === "visible") void reload(); }; window.addEventListener("focus", check); document.addEventListener("visibilitychange", check); return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); }; }, [reload]);
  const closeAndRefresh = (completed?: Record<string, unknown>) => {
    setClosing(true); readAbort.current?.abort(); readToken.current++; transition.cancel();
    timer.current = setTimeout(() => {
      if (completed) onCompleted?.(completed);
      onClose(); onChanged();
    }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160);
  };
  const leave = () => { if (!activity.busy && !working && !closing) closeAndRefresh(); };
  async function prepare(original: PrepareProcurementCommand) {
    if (activity.busy || reading || closing || denied) throw new ProcurementCommandRequestError(423, "请先完成当前采购记录的读取或核对");
    const captured = epoch.current, authority = identity.authority, lease = activity.begin();
    if (!lease) throw new ProcurementCommandRequestError(423, "请等待当前原提交完成核对");
    attempted.current = original; setWorking(true); setError("");
    try {
      const result = await procurementCommandRequest("commands", ProcurementCommandViewSchema, identity, original);
      if (valid(captured, authority)) transition.change(() => { setCommand(result); setDraft(null); setShowExternal(false); setUncertain(false); setItems(rows => [result, ...rows.filter(row => row.id !== result.id)]); });
    } catch (failure) { if (valid(captured, authority)) { if (procurementCommandDenied(failure)) revoke(); else setError(failure instanceof Error ? failure.message : "本次保存结果待核对"); } throw failure; }
    finally { activity.settle(lease); if (live.current && !activity.busy) setWorking(false); }
  }
  async function apply(action: "execute" | "cancel" | "acknowledge") {
    if (!command || activity.busy || reading || closing || denied || uncertain) return;
    const captured = epoch.current, authority = identity.authority, original = command, lease = activity.begin();
    if (!lease) return;
    setWorking(true); setError("");
    try {
      const result = await procurementCommandRequest(`commands/${original.id}/${action}`, ProcurementCommandViewSchema, identity, {});
      if (!valid(captured, authority)) return;
      transition.change(() => { setCommand(action === "acknowledge" ? null : result); setUncertain(false); setItems(rows => result.acknowledged ? rows.filter(row => row.id !== result.id) : [result, ...rows.filter(row => row.id !== result.id)]); });
      currentCommand.current = action === "acknowledge" ? null : result; attempted.current = null;
      // Source rows may disappear after an RFQ or approval. Keep their dialog
      // owner mounted until the operator acknowledges the saved result or closes.
      if (action === "acknowledge") closeAndRefresh(result.result ? { id: result.result.id,
        code: original.original && "code" in original.original.input ? original.original.input.code : original.targetLabel } : undefined);
    } catch (failure) {
      if (!valid(captured, authority)) return;
      if (procurementCommandDenied(failure)) revoke(); else { setUncertain(true); setError(failure instanceof Error ? failure.message : "本次执行结果待核对 请读取原提交"); }
    } finally { activity.settle(lease); if (live.current && !activity.busy) setWorking(false); }
  }
  const select = async (id: string) => {
    if (activity.busy || reading || closing) return;
    const captured = epoch.current, authority = identity.authority, token = ++readToken.current; setReading(true); setError("");
    readAbort.current?.abort(); const abort = new AbortController(); readAbort.current = abort;
    try {
      const result = await procurementCommandRequest(`commands/${id}`, ProcurementCommandViewSchema, identity, undefined, abort.signal);
      if (valid(captured, authority) && token === readToken.current) transition.change(() => { setCommand(result); setDraft(null); setShowExternal(false); setUncertain(false); });
    } catch (failure) { if (!abort.signal.aborted && valid(captured, authority) && token === readToken.current) { if (procurementCommandDenied(failure)) revoke(); else setError(failure instanceof Error ? failure.message : "暂时无法读取原提交"); } }
    finally { if (valid(captured, authority) && token === readToken.current) setReading(false); }
  };
  return <RecordDialog title="采购原填写与执行" onClose={leave} protectEdits={Boolean(draft) || showExternal}><ProcurementCycleStyles />
    <div className={`procurement-cycle procurement-cycle-dialog${closing ? " is-closing" : ""}`} aria-busy={reading || working}>
      <div className="procurement-cycle-toolbar"><strong>采购申请 → 询价 → 报价 → 采购版本 → 实际发票</strong><button type="button" disabled={working || reading || closing} onClick={() => void reload()}><RefreshCw size={14} />{reading ? "正在读取" : "重新读取原提交"}</button></div>
      {error && <p className="record-notice error" role="alert">{error}</p>}
      {denied && <p className="record-help">私有填写已清除 请核对当前账号与权限</p>}
      {!denied && <>
        {!command && !draft && !showExternal && !error && <p className="record-help" role="status">{reading ? "正在读取本人采购原提交" : "已确认原结果 可返回采购工作区"}</p>}
        {command && <ProcurementCommandReview command={command} blocked={reading || working || closing || uncertain || Boolean(error)} onApply={apply} onAccessDenied={revoke} onBack={() => transition.change(() => { setCommand(null); currentCommand.current = null; })} />}
        {draft && !command && <ProcurementCycleForm key={draft.id} draft={draft} data={data} disabled={reading || working || closing} onPrepare={prepare} onClose={leave} />}
        {showExternal && !command && externalForm?.render({ disabled: reading || working || closing, onPrepare: prepare, onClose: leave })}
        <section className="procurement-cycle-pending" aria-label="本人采购原提交"><h3>本人采购原提交</h3>{!items.length && <p className="record-help">当前没有待确认记录</p>}<ul>{items.map(row => <li key={row.id}><div><strong>{procurementActionNames[row.kind]} · {row.targetLabel}</strong><span>{procurementCommandStatusNames[row.status]} · {procurementTime(row.createdAt)}</span></div><button type="button" disabled={reading || working || closing || Boolean(draft) || showExternal} onClick={() => void select(row.id)}>恢复原提交</button></li>)}</ul>{cursor && <button type="button" disabled={reading || working || closing} onClick={() => void reload(cursor)}>读取更早的原提交</button>}{unavailable > 0 && <p className="record-help">{unavailable} 笔原提交的采购依据当前不可访问</p>}</section>
      </>}
    </div>
  </RecordDialog>;
}

function ProcurementCommandReview({ command, blocked, onApply, onBack, onAccessDenied }: { command: ProcurementCommandView; blocked: boolean; onApply(action: "execute" | "cancel" | "acknowledge"): Promise<void>; onBack(): void; onAccessDenied(): void }) {
  const [confirmed, setConfirmed] = useState(false);
  const reconciliationScope = command.id + ":" + (command.original?.kind === "invoice_reconcile" ? command.original.input.expectedFingerprint : command.status);
  const [reconciliationBasis, setReconciliationBasis] = useState({ scope: "", ready: false });
  const setReconciliationReady = useCallback((ready: boolean) => setReconciliationBasis({ scope: reconciliationScope, ready }), [reconciliationScope]);
  const waitingForBasis = command.kind === "invoice_reconcile" && command.status === "prepared" && (reconciliationBasis.scope !== reconciliationScope || !reconciliationBasis.ready);
  useEffect(() => { setConfirmed(false); }, [command.id, command.status, command.blockReason, blocked, waitingForBasis]);
  const reasons = { basis_changed: "原采购版本、报价或业务依据已变化 原填写保持 请取消这笔准备并重新核对填写", permission_denied: "当前权限不足以执行原提交 请核对当前权限", input_unavailable: "原填写暂时不可用 已停止执行 请重新读取或取消准备", expired: "原填写已到期 已停止执行 实际业务结果继续保留" };
  return <section className="procurement-cycle-command" aria-label="核对采购原提交"><header><h3>{procurementActionNames[command.kind]}</h3><strong>{procurementCommandStatusNames[command.status]}</strong></header>
    <p>{command.targetLabel}{command.targetDetail && ` · ${command.targetDetail}`}</p><p className="record-help">原提交 {procurementTime(command.createdAt)} · 填写副本保留至 {procurementTime(command.expiresAt)}</p>
    {command.original ? <ProcurementOriginalSummary original={command.original} basis={command.reviewBasis} /> : <p className="record-help">原填写副本已清除或当前不可读取 实际结果引用继续保留</p>}
    {command.blockReason && <p className="record-notice error" role="alert">{reasons[command.blockReason]}</p>}
    {command.kind === "invoice_record" && command.result && (command.invoiceResult ? <ProcurementInvoiceResultSummary invoice={command.invoiceResult} /> : <p className="record-notice" role="status">实际发票已登记 详细核对结果当前不可读取 请重新读取原提交</p>)}
    {command.kind === "invoice_reconcile" && command.targetId && <>
      {command.reconciliationResult && <section className="procurement-reconciliation-event" aria-label="实际发票处理结果"><h3>{reconciliationActionNames[command.reconciliationResult.action]}已留痕</h3><p>处理凭据 {command.reconciliationResult.id} · 序号 {command.reconciliationResult.sequence} · {procurementTime(command.reconciliationResult.createdAt)}</p><ProcurementReconciliationInputSummary input={command.reconciliationResult.input} /><ProcurementReconciliationBalanceSummary balance={command.reconciliationResult.balance} title="执行时余额" /><p className="record-help">此处是本次执行时的结果 后续处理后的余额以当前实际记录为准 确认结果只清除本人填写副本</p></section>}
      <ReconciliationCommandCurrent key={`${command.id}:${command.status}:${command.reconciliationResult?.id ?? "unavailable"}`} invoiceId={command.targetId} input={command.status === "prepared" && command.original?.kind === "invoice_reconcile" ? command.original.input : undefined} onReady={setReconciliationReady} onAccessDenied={onAccessDenied} />
    </>}
    {command.result && <p className="record-notice success" role="status">实际操作已完成{command.result.version ? ` · 结果 v${command.result.version}` : ""} 读取原提交不会再次创建采购记录 请确认结果后清除填写副本</p>}
    {command.status === "prepared" && command.original && <AgentOperationHandoff reference={{ domain: "procurement", commandId: command.id, accountId: null }} disabled={blocked || waitingForBasis} onDenied={onAccessDenied} />}
    {command.canExecute && <label className="procurement-cycle-confirm"><input type="checkbox" checked={confirmed} disabled={blocked || waitingForBasis} onChange={event => setConfirmed(event.target.checked)} />我已核对原填写与本次采购依据</label>}
    <footer><button type="button" disabled={blocked} onClick={onBack}>返回原提交列表</button>{command.canCancel && <button type="button" disabled={blocked} onClick={() => void onApply("cancel")}><RotateCcw size={14} />取消这笔准备</button>}{command.canExecute && <button type="button" className="primary" disabled={blocked || waitingForBasis || !confirmed} onClick={() => void onApply("execute")}><Check size={14} />确认执行原提交</button>}{command.status !== "prepared" && !command.acknowledged && <button type="button" className="primary" disabled={blocked} onClick={() => void onApply("acknowledge")}>确认结果并清除填写副本</button>}</footer>
  </section>;
}

export const reconciliationActionNames = { adjustment_record: "登记供应商调整单据", adjustment_review: "审核供应商调整", receipt_match: "匹配实际收货" };
export const reconciliationBalanceNames = { matched: "调整后已匹配", reconciliation_required: "差异待核对", fully_credited: "本票已全部冲销", unknown: "原依据待核对" };
export const supplierAdjustmentStatusNames = { pending: "待审核", approved: "已批准", rejected: "已拒绝" };
export function reconciliationMoney(minor: number | null, currency: string | null) {
  return minor === null || !currency ? "待核对" : currency + " " + formatMinorAmount(minor, currency);
}

/** Read-only BFF calls share the personal session, without sending tenant or actor input. */
export async function readInvoiceReconciliation<T extends z.ZodType>(path: string, schema: T, signal?: AbortSignal): Promise<z.output<T>> {
  let response: Response;
  try { response = await fetch(`/api/procurement-invoice-reconciliations${path}`, { method: "GET", cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000) }); }
  catch (failure) { if (signal?.aborted) throw failure; throw new ProcurementCommandRequestError(0, "暂时无法读取发票差异 请重新读取"); }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ProcurementCommandRequestError(response.status, typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : "当前无法读取发票差异", typeof body?.code === "string" ? body.code : null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ProcurementCommandRequestError(502, "发票差异回执不完整 已停止使用 请重新读取");
  return parsed.data;
}

export function useInvoiceReconciliationDetail(invoiceId: string) {
  const access = useErpAccess(), canRead = access.can(Permission.ProcurementRead);
  const [state, setState] = useState<{ detail: InvoiceReconciliationDetail | null; reading: boolean; error: string; denied: boolean }>({ detail: null, reading: true, error: "", denied: false });
  const sequence = useRef(0), live = useRef(true), controller = useRef<AbortController | null>(null), authority = useRef(access.authority); authority.current = access.authority;
  const reload = useCallback(async () => {
    if (!canRead) return;
    const token = ++sequence.current, captured = access.authority; controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setState(previous => ({ ...previous, reading: true }));
    const valid = () => live.current && token === sequence.current && authority.current === captured;
    try {
      const detail = await readInvoiceReconciliation(`/${invoiceId}`, InvoiceReconciliationDetailSchema, abort.signal);
      if (detail.invoiceId !== invoiceId) throw new ProcurementCommandRequestError(502, "发票差异与原发票不一致 请重新读取");
      if (valid()) setState({ detail, reading: false, error: "", denied: false });
    } catch (failure) {
      if (!abort.signal.aborted && valid()) setState(previous => ({ detail: procurementCommandDenied(failure) ? null : previous.detail, reading: false,
        error: failure instanceof Error ? failure.message : "暂时无法读取发票差异", denied: procurementCommandDenied(failure) }));
    } finally { if (valid()) setState(previous => ({ ...previous, reading: false })); }
  }, [invoiceId, access.authority, canRead]);
  useLayoutEffect(() => { sequence.current++; controller.current?.abort(); setState({ detail: null, reading: canRead, error: canRead ? "" : "当前没有采购读取权限 已清除本页记录", denied: !canRead }); }, [invoiceId, access.authority, canRead]);
  useEffect(() => { live.current = true; if (canRead) void reload(); return () => { live.current = false; sequence.current++; controller.current?.abort(); }; }, [reload, canRead]);
  useEffect(() => { const check = () => { if (document.visibilityState === "visible") void reload(); }; window.addEventListener("focus", check); document.addEventListener("visibilitychange", check); return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); }; }, [reload]);
  return { ...state, reload };
}

export function ProcurementReconciliationBalanceSummary({ balance, title = "当前实际余额" }: { balance: InvoiceReconciliationBalance; title?: string }) {
  const reasons = { legacy_basis_missing: "旧票缺少完整原依据", currency_mismatch: "发票币种与原采购币种不同 未自动换汇", price_basis_unrepresentable: "原计价依据无法按最小币种单位精确表示" };
  return <section className="procurement-reconciliation-balance" aria-label={title}><header><h3>{title}</h3><strong>{reconciliationBalanceNames[balance.status]}</strong></header>
    <p>调整后净额 {reconciliationMoney(balance.netAmountMinor, balance.currency)} · 金额差额 {reconciliationMoney(balance.varianceMinor, balance.comparisonCurrency)}</p>
    {!!balance.unknownReasons.length && <ul className="record-notice">{balance.unknownReasons.map(reason => <li key={reason}>{reasons[reason]}</li>)}</ul>}
    <ol>{balance.lines.map(line => <li key={line.invoiceLineId}><strong>{line.lineKey}</strong>
      <span>原开票 {formatStockQuantity(line.originalQuantity)} · 贷项冲减 {formatStockQuantity(line.creditedQuantity)} · 净开票 {formatStockQuantity(line.netQuantity)} {line.unit ? unitNames[line.unit] : "原单位待核对"}</span>
      <span>已匹配收货 {line.allocatedQuantity === null ? "待核对" : formatStockQuantity(line.allocatedQuantity)} · 尚未匹配 {line.unallocatedQuantity === null ? "待核对" : formatStockQuantity(line.unallocatedQuantity)} {line.unit ? unitNames[line.unit] : "单位待核对"}</span>
      <span>原金额 {reconciliationMoney(line.originalAmountMinor, balance.currency)} · 已批贷项 {reconciliationMoney(line.creditAmountMinor, balance.currency)} · 已批补差 {reconciliationMoney(line.debitAmountMinor, balance.currency)}</span>
      <span>行净额 {reconciliationMoney(line.netAmountMinor, balance.currency)} · 对照金额 {reconciliationMoney(line.expectedAmountMinor, balance.comparisonCurrency)} · 行差额 {reconciliationMoney(line.varianceMinor, balance.comparisonCurrency)}</span>
    </li>)}</ol><p className="record-help">金额、数量与未知依据分别核对 贷项数量先冲减尚未匹配部分 本票全部冲销与匹配成功分别保留 原发票状态和库存不随此处处理改写</p>
  </section>;
}

export function ProcurementSupplierAdjustmentSummary({ adjustment }: { adjustment: SupplierAdjustmentView }) {
  return <div className="procurement-adjustment-summary"><dl><dt>供应商单据</dt><dd>{adjustment.document.kind === "credit_note" ? "贷项单" : "金额补差单"} {adjustment.document.number} · {supplierAdjustmentStatusNames[adjustment.status]}</dd><dt>开具时间</dt><dd>{procurementTime(adjustment.document.issuedAt)}</dd><dt>凭证引用</dt><dd>{adjustment.document.evidenceReference}</dd><dt>登记依据</dt><dd>{adjustment.reason}</dd><dt>登记人</dt><dd>{adjustment.createdBy} · {procurementTime(adjustment.createdAt)}</dd></dl>
    <ol>{adjustment.lines.map(line => <li key={line.invoiceLineId}><strong>原发票行 {line.invoiceLineId}</strong><span>调整数量 {formatStockQuantity(line.quantity)} {unitNames[line.unit]} · 调整金额 {reconciliationMoney(line.amountMinor, adjustment.document.currency)}</span></li>)}</ol>
    {adjustment.reviewedAt && <p>审核 {supplierAdjustmentStatusNames[adjustment.status]} · {adjustment.reviewedBy} · {procurementTime(adjustment.reviewedAt)} · {adjustment.reviewReason}</p>}
    <p className="record-help">单据编号与凭证引用由登记人录入 尚未经外部验真 待审核单据不计入实际余额 批准只记本地审核依据</p>
  </div>;
}

function ProcurementReconciliationInputSummary({ input }: { input: InvoiceReconciliationInput }) {
  const documentCurrency = input.action === "adjustment_record" ? input.document.currency : null;
  return <div className="procurement-cycle-original"><dl><dt>本次处理</dt><dd>{reconciliationActionNames[input.action]}</dd><dt>原处理依据</dt><dd>{input.expectedFingerprint}</dd><dt>处理说明</dt><dd>{input.reason}</dd>
    {input.action === "adjustment_record" && <><dt>供应商单据</dt><dd>{input.document.kind === "credit_note" ? "贷项单" : "金额补差单"} {input.document.number}</dd><dt>开具时间</dt><dd>{procurementTime(input.document.issuedAt)}</dd><dt>单据币种</dt><dd>{input.document.currency}</dd><dt>凭证引用</dt><dd>{input.document.evidenceReference}</dd></>}
    {input.action === "adjustment_review" && <><dt>原调整记录</dt><dd>{input.adjustmentId}</dd><dt>审核决定</dt><dd>{input.decision === "approved" ? "批准这笔调整" : "拒绝这笔调整"}</dd></>}
  </dl>
    {input.action === "adjustment_record" && <ol>{input.lines.map(line => <li key={line.invoiceLineId}><strong>原发票行 {line.invoiceLineId}</strong><span>调整数量 {formatStockQuantity(line.quantity)} {unitNames[line.unit]} · 调整金额 {reconciliationMoney(line.amountMinor, documentCurrency)}</span></li>)}</ol>}
    {input.action === "receipt_match" && <ol>{input.lines.map(line => <li key={`${line.invoiceLineId}:${line.receiptLineId}`}><strong>原发票行 {line.invoiceLineId}</strong><span>原收货行 {line.receiptLineId} · 本次匹配 {formatStockQuantity(line.quantity)} {unitNames[line.unit]}</span></li>)}</ol>}
    <p className="record-help">供应商单据引用尚未经外部验真 登记、批准与确认原提交结果各自留痕 不代表付款或库存变更</p>
  </div>;
}

function ReconciliationCommandCurrent({ invoiceId, input, onReady, onAccessDenied }: { invoiceId: string; input?: InvoiceReconciliationInput; onReady(ready: boolean): void; onAccessDenied(): void }) {
  const { detail, reading, error, denied, reload } = useInvoiceReconciliationDetail(invoiceId);
  const adjustmentId = input?.action === "adjustment_review" ? input.adjustmentId : null;
  const adjustment = detail?.adjustments.find(row => row.id === adjustmentId);
  const sameBasis = !input || detail?.fingerprint === input.expectedFingerprint;
  const permitted = !input || (input.action === "adjustment_record" ? detail?.canRecord : detail?.canApprove && (input.action !== "adjustment_review" || adjustment?.status === "pending"));
  const ready = Boolean(detail && !reading && !error && sameBasis && permitted);
  useEffect(() => { onReady(ready); }, [ready, onReady]);
  useEffect(() => { if (denied) onAccessDenied(); }, [denied, onAccessDenied]);
  return <section className="procurement-reconciliation-current" aria-label="当前实际发票记录" aria-busy={reading}><header><h3>{reading ? "正在更新实际发票记录" : error ? "实际发票记录待重新核对" : "当前实际发票记录"}</h3><button type="button" disabled={reading} onClick={() => void reload()}><RefreshCw size={14} />重新读取实际余额</button></header>
    {reading && <p className="record-help" role="status">正在核对当前实际依据</p>}{error && <p className="record-notice error" role="alert">{error}</p>}
    {detail && <><p>{detail.invoiceNumber} · {detail.purchaseOrderCode} · 原发票{detail.originalStatus === "matched" ? "已匹配" : "有差异"}</p>
      {!sameBasis && <p className="record-notice error" role="alert">原提交后的实际依据已变化 已停止执行 原填写不会自动改绑 请取消这笔准备后重新核对</p>}
      {input && !permitted && <p className="record-notice error" role="alert">{detail.blockReason ?? "当前权限或实际调整状态不允许执行这笔原提交"}</p>}
      {adjustment && <section aria-label="本次审核的实际调整单据"><ProcurementSupplierAdjustmentSummary adjustment={adjustment} /></section>}
      <ProcurementReconciliationBalanceSummary balance={detail.balance} title={reading || error ? "上次读取余额 待重新核对" : "当前实际余额"} />
    </>}
  </section>;
}

function ProcurementInvoiceResultSummary({ invoice }: { invoice: ProcurementInvoiceView }) {
  const allocation = invoice.allocationStatus === "complete" ? "本张开票数量已全部分配" : invoice.allocationStatus === "legacy_unknown" ? "旧分配依据待核对" : invoice.allocationStatus === "reconciliation_required" ? "分配差异待核对" : "数量分配依据待核对";
  const variance = (minor: number | null) => minor === null || !invoice.comparisonCurrency ? "金额差额待核对" : "金额差额 " + invoice.comparisonCurrency + " " + formatMinorAmount(minor, invoice.comparisonCurrency);
  return <section className="record-notice procurement-invoice-result" role="status" aria-label="实际发票登记结果">
    <strong>{invoice.status === "matched" ? "实际发票已登记并匹配" : "实际发票已登记 差异待核对"}</strong>
    <p>{invoice.invoiceNumber} · {invoice.currency} {formatMinorAmount(invoice.totalMinor, invoice.currency)}</p>
    <p>发票开具 {procurementTime(invoice.issuedAt)} · 实际记录 {invoice.id}</p>
    <p>数量分配 {allocation} · {variance(invoice.varianceMinor)}</p>
    {invoice.lines?.length ? <ol>{invoice.lines.map(line => <li key={line.lineKey}><strong>{line.lineKey}</strong>
      <span>实际开票 {formatStockQuantity(line.invoicedQuantity)} {line.unit ? unitNames[line.unit] : "原采购单位待核对"} · 已分配 {line.allocatedQuantity === null ? "待核对" : formatStockQuantity(line.allocatedQuantity) + " " + (line.unit ? unitNames[line.unit] : "单位待核对")}</span>
      <span>发票报价 {invoice.currency} {formatMinorAmount(line.unitCostMinor, invoice.currency)} / {line.priceBasisQuantity === null ? "原计价数量待核对" : formatStockQuantity(line.priceBasisQuantity) + " " + (line.unit ? unitNames[line.unit] : "单位待核对")}</span>
      <span>{variance(line.varianceMinor)}</span>
    </li>)}</ol> : <p>本张明细与分配依据当前不可读取 请重新读取原提交</p>}
    <p>数量全部分配不代表金额匹配 价格与币种以实际核对结果为准</p>
  </section>;
}

function ProcurementReviewBasisDetails({ basis, quantityLabel, priceLabel = "原报价" }: { basis?: ProcurementReviewBasis | null; quantityLabel?: string; priceLabel?: string }) {
  if (!basis) return <p className="record-help">原单位、库存换算和计价依据当前不可读取 请先核对原版本 当前资料不会替代原依据</p>;
  return <section className="procurement-cycle-basis" aria-label="原单位与计价依据">
    {basis.sourceVersionId && <p className="record-help">原依据版本 {basis.sourceVersionId}</p>}
    <ol>{basis.lines.map(row => <li key={row.lineKey}><strong>{row.lineKey}</strong>
      <ProcurementMeasure quantity={row.quantity} unit={row.unit} stockBasis={row.stockBasis} quantityLabel={quantityLabel} />
      <span>{row.unitCostMinor !== null && basis.currency ? priceLabel + " " + basis.currency + " " + formatMinorAmount(row.unitCostMinor, basis.currency) : "原报价金额或币种待核对"} · {row.priceBasisQuantity === null ? "原计价数量未单列 请核对" : "每 " + formatStockQuantity(row.priceBasisQuantity) + " " + unitNames[row.unit]}</span>
      {row.lineTotalMinor !== null && basis.currency && <span>原行金额 {basis.currency} {formatMinorAmount(row.lineTotalMinor, basis.currency)}</span>}
    </li>)}</ol>
  </section>;
}
export function ProcurementOriginalSummary({ original, basis }: { original: PrepareProcurementCommand; basis?: ProcurementReviewBasis | null }) {
  if (original.kind === "invoice_reconcile") return <ProcurementReconciliationInputSummary input={original.input} />;
  if (original.kind === "invoice_record") {
    const input = original.input;
    let total: number | null = null;
    try { total = sumProcurementMinor(input.lines.map(row => procurementAmountMinor(row.invoicedQuantity, row.unitCostMinor, row.priceBasisQuantity ?? 1))); } catch { /* Legacy precision cannot be inferred or rounded. */ }
    return <div className="procurement-cycle-original"><dl><dt>原采购版本</dt><dd>v{input.expectedVersion}</dd><dt>实际发票编号</dt><dd>{input.invoiceNumber}</dd><dt>发票开具时间</dt><dd>{procurementTime(input.issuedAt)}</dd><dt>原发票币种</dt><dd>{input.currency}</dd><dt>本张实际金额</dt><dd>{total === null ? "原金额精度待核对" : input.currency + " " + formatMinorAmount(total, input.currency)}</dd></dl>
      <ol>{input.lines.map(row => {
        const pinned = basis?.lines.find(line => line.lineKey === row.lineKey), unit = pinned?.unit;
        return <li key={row.lineKey}><strong>{row.lineKey}</strong><span>本张开票 {formatStockQuantity(row.invoicedQuantity)} {unit ? unitNames[unit] : "原采购单位待核对"}</span>
          <span>原发票报价 {input.currency} {formatMinorAmount(row.unitCostMinor, input.currency)} · {row.priceBasisQuantity === undefined ? "原计价数量未单列 按1计算" : "每 " + formatStockQuantity(row.priceBasisQuantity) + " " + (unit ? unitNames[unit] : "原采购单位待核对")}</span>
        </li>;
      })}</ol><ProcurementReviewBasisDetails basis={basis} quantityLabel="本张开票" priceLabel="原发票报价" />
    </div>;
  }
  if (original.kind === "rfq_create") return <div className="procurement-cycle-original"><dl><dt>原申请版本</dt><dd>v{original.input.expectedRequisitionVersion}</dd><dt>询价截止</dt><dd>{procurementTime(original.input.responseDueAt)}</dd><dt>原供应商标识</dt><dd>{original.input.supplierIds.join("、")}</dd></dl><ProcurementReviewBasisDetails basis={basis} /></div>;
  if (original.kind === "quote_record") return <div className="procurement-cycle-original"><dl><dt>原报价供应商标识</dt><dd>{original.input.supplierId}</dd><dt>原报价币种</dt><dd>{original.input.currency}</dd><dt>报价有效至</dt><dd>{procurementTime(original.input.validUntil)}</dd></dl>
    <ol>{original.input.lines.map(row => {
      const pinned = basis?.lines.find(line => line.lineKey === row.lineKey), unit = pinned?.unit;
      const priceBasis = row.priceBasisQuantity ?? pinned?.priceBasisQuantity;
      return <li key={row.lineKey}><strong>{row.lineKey}</strong><span>原报价 {original.input.currency} {formatMinorAmount(row.unitCostMinor, original.input.currency)} · {priceBasis == null || !unit ? "原计价数量或单位待核对" : "每 " + formatStockQuantity(priceBasis) + " " + unitNames[unit]}</span><span>最低起订 {formatStockQuantity(row.minimumOrderQuantity)} {unit ? unitNames[unit] : "采购单位待核对"} · 交期 {row.leadTimeDays} 天</span></li>;
    })}</ol><ProcurementReviewBasisDetails basis={basis} /></div>;
  if (original.kind === "purchase_review") return <div className="procurement-cycle-original"><dl><dt>原采购版本</dt><dd>v{original.input.expectedVersion}</dd><dt>原审核决定</dt><dd>{original.input.decision === "approved" ? "批准采购" : "驳回修改"}</dd><dt>原审核依据</dt><dd>{reviewReasonLabel(original.input.reasonCode)}</dd></dl><ProcurementReviewBasisDetails basis={basis} /></div>;
  if (original.kind === "supply_purchase_create") {
    const unit = basis?.lines.length === 1 ? basis.lines[0]!.unit : null;
    return <div className="procurement-cycle-original"><dl><dt>采购单号</dt><dd>{original.input.code}</dd><dt>原供货版本</dt><dd>v{original.input.expectedVersion}</dd><dt>采购用途</dt><dd>{original.input.purpose === "custom_order" ? "定制订单" : "FBA 备货"}</dd><dt>原采购数量</dt><dd>{formatStockQuantity(original.input.quantity)} {unit ? unitNames[unit] : "采购单位待核对"}</dd><dt>原收货库位标识</dt><dd>{original.input.destinationLocationId}</dd><dt>预计到货</dt><dd>{procurementTime(original.input.expectedAt)}</dd></dl><ProcurementReviewBasisDetails basis={basis} /></div>;
  }
  const input = original.input;
  return <div className="procurement-cycle-original"><dl>{original.kind === "requisition_create" ? <><dt>采购申请号</dt><dd>{original.input.code}</dd><dt>原采购原因</dt><dd>{requisitionReasonLabel(original.input.reasonCode)}</dd></> : <>{original.kind === "purchase_create" ? <><dt>采购单号</dt><dd>{original.input.code}</dd><dt>原供应商标识</dt><dd>{original.input.supplierId}</dd><dt>原采购依据</dt><dd>{original.input.quoteId ? "已绑定供应商原报价与原申请" : "直接人工建单"}</dd></> : <><dt>原采购版本</dt><dd>v{original.input.expectedVersion}</dd></>}<dt>原采购币种</dt><dd>{original.input.currency}</dd><dt>预计到货</dt><dd>{procurementTime(original.input.expectedAt)}</dd></>}</dl>
    <ol>{input.lines.map(row => {
      const pinned = basis?.lines.find(line => line.lineKey === row.lineKey);
      return <li key={row.lineKey}><strong>{row.lineKey} · 物料 {row.stockItemId}</strong><span>原采购 {formatStockQuantity(row.quantity)} {unitNames[row.unit]} · 原库位 {row.destinationLocationId}</span>
        <ProcurementMeasure quantity={row.quantity} unit={row.unit} stockBasis={pinned?.stockBasis} />
        {"unitCostMinor" in row && "currency" in input && <span>原报价 {input.currency} {formatMinorAmount(row.unitCostMinor, input.currency)} · {row.priceBasisQuantity === undefined ? "原计价数量未单列 请核对" : "每 " + formatStockQuantity(row.priceBasisQuantity) + " " + unitNames[row.unit]}</span>}
      </li>;
    })}</ol></div>;
}
function reviewReasonLabel(value: string) { return ({ DETAILS_CONFIRMED: "供应商、明细及金额已核对", BUDGET_CONFIRMED: "预算已确认", DETAILS_INCORRECT: "资料或数量需修改", PRICE_UNCONFIRMED: "价格尚未确认" } as Record<string, string>)[value] ?? value; }
function requisitionReasonLabel(value: string) { return ({ REPLENISHMENT: "库存补货", CUSTOM_ORDER: "定制订单", FBA_REPLENISHMENT: "FBA 备货", OTHER: "其他采购需求" } as Record<string, string>)[value] ?? value; }

function ProcurementCycleStyles() {
  return <style>{`
    .procurement-cycle { min-width:0; color:var(--ink,#172033); animation:procurement-cycle-enter 180ms ease both; transition:opacity 160ms ease,transform 160ms ease; }
    .procurement-cycle.is-closing { opacity:0; transform:translateY(5px) scale(.994); pointer-events:none; }
    .procurement-cycle-dialog { padding:18px 22px 24px; }
    .procurement-cycle :is(p,span,strong,dd,li,h2,h3) { min-width:0; overflow-wrap:anywhere; }
    .procurement-cycle :is(button,input,select,textarea) { transition:color 150ms ease,border-color 150ms ease,background 150ms ease,opacity 150ms ease,box-shadow 150ms ease,transform 150ms ease; }
    .procurement-cycle button { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:34px; padding:6px 10px; border:1px solid var(--line,#e0e5ed); border-radius:6px; color:inherit; background:#fff; cursor:pointer; font:inherit; font-size:12px; }
    .procurement-cycle button:enabled:hover { transform:scale(1.018); border-color:#a6b7d2; background:#f6f9fe; }
    .procurement-cycle button:enabled:active { transform:scale(.978); }
    .procurement-cycle button:disabled { opacity:.48; cursor:default; }
    .procurement-cycle button:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }
    .procurement-cycle button.primary { background:#1d4ed8; color:#fff; border-color:#1d4ed8; }
    .procurement-cycle button.primary:enabled:hover { background:#1e40af; }
    .procurement-cycle-recovery { border-block:1px solid var(--line,#e0e5ed); padding:14px 0; margin:12px 0 20px; }
    .procurement-cycle-recovery>header,.procurement-cycle-recovery>header>div,.procurement-cycle-toolbar,.procurement-cycle-command>header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; }
    .procurement-cycle-recovery>header>div { justify-content:flex-start; }
    .procurement-cycle h2,.procurement-cycle h3 { margin:0; font-size:13px; font-weight:650; }
    .procurement-cycle-recovery>header span,.procurement-cycle li span,.procurement-cycle-command>header>strong { color:var(--muted,#697487); font-size:12px; }
    .procurement-cycle ul { padding:0; margin:10px 0; list-style:none; }
    .procurement-cycle li { padding:8px 0; animation:procurement-cycle-enter 160ms ease both; }
    .procurement-cycle-recovery li,.procurement-cycle-pending li { display:flex; align-items:center; justify-content:space-between; gap:14px; }
    .procurement-cycle-recovery li>div,.procurement-cycle-pending li>div { display:grid; min-width:0; gap:4px; }
    .procurement-cycle li strong { font-size:12px; }
    .procurement-cycle-pending { border-top:1px solid var(--line,#e0e5ed); margin-top:18px; padding-top:16px; }
    .procurement-cycle-form,.procurement-cycle-command { margin-top:16px; animation:procurement-cycle-enter 180ms ease both; }
    .procurement-cycle-form .record-grid { grid-template-columns:repeat(auto-fit,minmax(min(190px,100%),1fr)); }
    .procurement-cycle-form .record-line { animation:procurement-cycle-enter 180ms ease both; }
    .procurement-cycle-form>footer,.procurement-cycle-command>footer { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; margin-top:16px; }
    .procurement-cycle-suppliers { display:grid; gap:8px; }
    .procurement-cycle-suppliers label,.procurement-cycle-confirm { display:flex; align-items:flex-start; gap:8px; font-size:12px; line-height:1.7; }
    .procurement-cycle :is(.procurement-cycle-suppliers,.procurement-cycle-confirm) input { flex:0 0 auto; width:16px; height:16px; margin:2px 0 0; accent-color:#1d4ed8; }
    .procurement-cycle-original { margin:12px 0; font-size:12px; }
    dl.procurement-cycle-original,.procurement-cycle-original dl { display:grid; grid-template-columns:minmax(80px,110px) minmax(0,1fr); gap:8px 12px; }
    .procurement-cycle-original :is(dt,dd) { margin:0; white-space:pre-wrap; }
    .procurement-cycle-original dt { color:var(--muted,#697487); }
    .procurement-cycle-original ol,.procurement-cycle-basis ol { padding-left:20px; }
    .procurement-cycle-original li :is(strong,span) { display:block; line-height:1.65; }
    .procurement-cycle-confirm { margin-top:12px; }
    .procurement-cycle-basis { border-left:2px solid #dce6fa; padding-left:12px; font-size:12px; }
    .procurement-cycle-source-actions { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
    @keyframes procurement-cycle-enter { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:translateY(0)} }
    @media(max-width:600px) { .procurement-cycle-dialog{padding:14px}.procurement-cycle-recovery li,.procurement-cycle-pending li{align-items:flex-start}.procurement-cycle-form>footer button,.procurement-cycle-command>footer button{flex:1 1 150px} }
    @media(prefers-reduced-motion:reduce) { .procurement-cycle,.procurement-cycle * { animation-duration:.01ms!important; transition-duration:.01ms!important; } }
  `}</style>;
}
