"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ClipboardList, FileSearch, Plus, RefreshCw, RotateCcw } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { FinanceCommandDetailSchema, FinanceCommandKindSchema, FinanceCommandListSchema, FinanceCommandOriginalSchema,
  PrepareFinanceCommandSchema, type FinanceCommandDetail, type FinanceCommandKind, type FinanceCommandScope,
  type FinanceCommandSummary, type PrepareFinanceCommand } from "@yummyai/contracts/finance/finance-command";
import { useErpAccess } from "../identity/erp-access";
import { Field, RecordDialog } from "../manual-operations/record-form";
import { useOwnedViewTransition } from "../navigation/use-owned-view-transition";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import { financeCommandDenied, financeCommandOperationPermission, financeCommandReadPath, financeCommandRequest, FinanceCommandRequestError } from "../../lib/finance-command-client";
import { FinanceCommandOriginalSummary, FinanceCommandResultSummary, financeCommandNames, financeCommandStatusNames, financeCommandTime } from "./finance-command-summary";
import { FinanceRecordForms, type FinanceRecordKind } from "./finance-command-forms";
import { FinanceCommandResultReader } from "./finance-command-result";
import { AgentOperationHandoff } from "../ai-tasks/agent-operation-handoff";
import "../manual-operations/manual-operations.css";
import "./finance-command.css";

export function financeCommandPermission(kind: FinanceCommandKind) { return financeCommandOperationPermission(kind); }
function message(failure: unknown) { return failure instanceof FinanceCommandRequestError ? failure.message : "暂时无法核对原提交 请保留原填写并重新读取"; }

/** A scope is independent of workspace rows and survives owner list truncation. */
export function useFinanceCommandPreparation(scope: FinanceCommandScope, enabled = true) {
  const { kind, targetId } = scope;
  const access = useErpAccess();
  const identity = useMemo(() => ({ authority: access.authority, localDevelopment: access.localDevelopment }), [access.authority, access.localDevelopment]);
  const canRead = access.can(Permission.FinanceRead) || access.can(financeCommandPermission(scope.kind));
  const canWrite = enabled && access.can(financeCommandPermission(scope.kind));
  const scopeKey = `${scope.kind}:${scope.targetId ?? "root"}`;
  const [commandId, setCommandId] = useState<string | null>(null), [original, setOriginal] = useState<PrepareFinanceCommand | null>(null);
  const [checking, setChecking] = useState(true), [pending, setPending] = useState(false), [error, setError] = useState(""), [denied, setDenied] = useState(false);
  const live = useRef(true), generation = useRef(0), sequence = useRef(0), readAbort = useRef<AbortController | null>(null);
  const attempt = useRef<PrepareFinanceCommand | null>(null), owner = useRef<symbol | null>(null);
  const current = useRef({ identity, scopeKey, canRead, canWrite }); current.current = { identity, scopeKey, canRead, canWrite };
  const clearPrivate = useCallback(() => { attempt.current = null; setOriginal(null); setCommandId(null); }, []);
  const reload = useCallback(async () => {
    if (!current.current.canRead || owner.current) return;
    const epoch = generation.current, token = ++sequence.current, captured = identity.authority;
    readAbort.current?.abort(); const abort = new AbortController(); readAbort.current = abort; setChecking(true); setError("");
    const valid = () => live.current && epoch === generation.current && token === sequence.current && current.current.identity.authority === captured && current.current.scopeKey === scopeKey && current.current.canRead;
    try {
      const retained = attempt.current; let before: string | undefined, inaccessible = 0, otherOriginal = false;
      do {
        const page = await financeCommandRequest(financeCommandReadPath({ kind, targetId }, before), FinanceCommandListSchema, identity, undefined, abort.signal);
        if (!valid()) return;
        const existing = page.items.find(row => row.kind === kind && row.targetId === targetId && (!retained || row.requestKey === retained.input.idempotencyKey));
        if (existing) { setCommandId(existing.id); return; }
        inaccessible += page.unavailableCount; otherOriginal ||= page.items.length > 0; before = page.nextCursor ?? undefined;
      } while (before);
      if (inaccessible || retained && otherOriginal) setError("此操作已有暂不可访问或不同原键的提交 请先核对本人原提交列表 不另建提交键");
    } catch (failure) {
      if (abort.signal.aborted || !valid()) return;
      if (financeCommandDenied(failure)) { clearPrivate(); setDenied(true); }
      setError(message(failure));
    } finally { if (valid()) setChecking(false); }
  }, [identity, kind, targetId, scopeKey, clearPrivate]);
  useLayoutEffect(() => {
    generation.current++; sequence.current++; readAbort.current?.abort(); owner.current = null;
    clearPrivate(); setPending(false); setDenied(false); setChecking(canRead); setError(canRead ? "" : "当前没有读取这类本人原提交的权限 私有填写已清除");
  }, [identity, scopeKey, canRead, clearPrivate]);
  useLayoutEffect(() => { if (!canWrite) { attempt.current = null; setOriginal(null); } }, [canWrite]);
  useEffect(() => { live.current = true; if (canRead) void reload(); return () => { live.current = false; generation.current++; sequence.current++; readAbort.current?.abort(); }; }, [canRead, reload]);
  async function prepare(input?: PrepareFinanceCommand) {
    if (owner.current || checking || commandId || !current.current.canWrite) return;
    const parsed = PrepareFinanceCommandSchema.parse(attempt.current ?? input);
    if (parsed.kind !== scope.kind || parsed.targetId !== scope.targetId) throw new FinanceCommandRequestError(400, "原提交目标与本次入口不一致 请重新核对");
    const epoch = generation.current, captured = identity.authority, lease = Symbol("finance-prepare");
    owner.current = lease; attempt.current = parsed; setOriginal(parsed); setPending(true); setError("");
    const valid = () => live.current && epoch === generation.current && current.current.identity.authority === captured && current.current.scopeKey === scopeKey && current.current.canWrite;
    try {
      const detail = await financeCommandRequest("", FinanceCommandDetailSchema, identity, parsed);
      if (detail.kind !== parsed.kind || detail.targetId !== parsed.targetId || detail.requestKey !== parsed.input.idempotencyKey)
        throw new FinanceCommandRequestError(502, "返回提交与原目标或原键不一致 请读取本人原提交核对");
      if (valid()) setCommandId(detail.id);
    } catch (failure) {
      if (!valid()) return;
      if (financeCommandDenied(failure)) { clearPrivate(); setDenied(true); }
      setError(message(failure));
    } finally { if (owner.current === lease) { owner.current = null; if (live.current) setPending(false); } }
  }
  const finish = () => { clearPrivate(); setError(""); };
  return { commandId, original, checking, pending, error, denied, canRead, canWrite, locked: checking || pending || Boolean(original) || Boolean(commandId), prepare, reload, finish };
}

export type FinanceCommandFormProps = {
  title: string; scope: FinanceCommandScope; children: ReactNode; permitted?: boolean; submitDisabled?: boolean;
  build(form: FormData, requestKey: string): PrepareFinanceCommand;
  onClose(): void; onCompleted?(detail: FinanceCommandDetail): void; onDenied?(message: string): void;
};
export function FinanceCommandForm({ title, scope, children, build, onClose, onCompleted, onDenied, permitted = true, submitDisabled = false }: FinanceCommandFormProps) {
  const access = useErpAccess(), preparation = useFinanceCommandPreparation(scope, permitted);
  const [key] = useState(() => crypto.randomUUID()), [error, setError] = useState("");
  const callbacks = useRef({ onClose, onDenied, finish: preparation.finish }); callbacks.current = { onClose, onDenied, finish: preparation.finish };
  const revoke = useCallback((reason: string) => { callbacks.current.finish(); callbacks.current.onDenied?.(reason); callbacks.current.onClose(); }, []);
  useEffect(() => { if (preparation.denied) revoke(preparation.error); }, [preparation.denied, preparation.error, revoke]);
  useLeaveGuard(Boolean(preparation.original && !preparation.commandId), preparation.pending);
  if (preparation.commandId) return <FinanceCommandReview commandId={preparation.commandId} onClose={onClose} onDenied={revoke} onFinished={detail => { preparation.finish(); onCompleted?.(detail); onClose(); }} />;
  return <form className="record-form finance-command-form" aria-label={title} onSubmit={event => {
    event.preventDefault(); if (preparation.pending || preparation.checking || !preparation.canWrite || !preparation.original && submitDisabled) return;
    try { setError(""); void preparation.prepare(preparation.original ?? build(new FormData(event.currentTarget), key)).catch(failure => setError(message(failure))); }
    catch (failure) { setError(failure instanceof Error && /[\u3400-\u9fff]/.test(failure.message) ? failure.message : "请核对真实来源、金额、版本和全部必填字段"); }
  }}>
    <p className="finance-command-note">先保存本人原填写 核对后才执行实际财务登记 关页或重新登录后可在本人财务原提交中恢复</p>
    {preparation.checking && <p role="status">正在读取此操作的本人原提交</p>}
    {(error || preparation.error) && <p className="finance-command-notice is-error" role="alert">{error || preparation.error}</p>}
    {preparation.error && !preparation.original && <button type="button" disabled={preparation.checking || preparation.pending} onClick={() => void preparation.reload()}><RefreshCw size={14} />重新读取此操作的原提交</button>}
    {preparation.original && <div className="finance-command-notice" role="status"><strong>准备响应尚未确认 原正文与原键已固定</strong><p>只重试保存同一份原提交 或重新读取本人原提交 不根据未知结果另建键</p><button type="button" disabled={preparation.pending || preparation.checking} onClick={() => void preparation.reload()}><RefreshCw size={14} />读取此操作的原提交</button></div>}
    {!preparation.canWrite && <p className="finance-command-notice">当前不能准备新的这类操作 可在本人原提交中核对已有结果</p>}
    <fieldset className="record-fields" disabled={preparation.pending} inert={preparation.locked || !preparation.canWrite || Boolean(preparation.error)} aria-disabled={preparation.locked || !preparation.canWrite}>{children}</fieldset>
    <footer><button type="button" data-record-cancel disabled={preparation.pending} onClick={onClose}>返回实际记录</button><button type="submit" className="primary" disabled={preparation.pending || preparation.checking || !preparation.canWrite || Boolean(preparation.error) && !preparation.original || !preparation.original && submitDisabled}><Check size={14} />{preparation.pending ? "正在保存原填写" : preparation.original ? "重试保存同一笔原提交" : "保存原填写并核对"}</button></footer>
    {!access.authority && !access.localDevelopment && <p className="finance-command-notice is-error">当前身份不可核对 未发送新提交</p>}
  </form>;
}

export function FinanceCommandReview({ commandId, onClose, onFinished, onDenied }: { commandId: string; onClose(): void; onFinished(detail: FinanceCommandDetail): void; onDenied?(message: string): void }) {
  const access = useErpAccess(), identity = useMemo(() => ({ authority: access.authority, localDevelopment: access.localDevelopment }), [access.authority, access.localDevelopment]);
  const [detail, setDetail] = useState<FinanceCommandDetail | null>(null), [original, setOriginal] = useState<PrepareFinanceCommand | null>(null);
  const [originalRead, setOriginalRead] = useState(false);
  const [reading, setReading] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState(""), [uncertain, setUncertain] = useState(false), [confirmed, setConfirmed] = useState(false);
  const generation = useRef(0), sequence = useRef(0), live = useRef(true), readAbort = useRef<AbortController | null>(null), owner = useRef<symbol | null>(null), resultHeading = useRef<HTMLHeadingElement>(null);
  const authority = useRef(access.authority); authority.current = access.authority;
  const transition = useOwnedViewTransition();
  const valid = useCallback((epoch: number, captured: string | null) => live.current && epoch === generation.current && authority.current === captured, []);
  const clearPrivate = useCallback(() => { setOriginal(null); setOriginalRead(false); setDetail(null); setConfirmed(false); }, []);
  const reload = useCallback(async () => {
    if (owner.current) return;
    const epoch = generation.current, token = ++sequence.current, captured = identity.authority;
    readAbort.current?.abort(); const abort = new AbortController(); readAbort.current = abort; setReading(true); setError(""); setConfirmed(false);
    try {
      const value = await financeCommandRequest(commandId, FinanceCommandDetailSchema, identity, undefined, abort.signal);
      if (!valid(epoch, captured) || token !== sequence.current) return;
      if (value.id !== commandId) throw new FinanceCommandRequestError(502, "返回凭据与所查原提交不一致");
      transition.change(() => { if (valid(epoch, captured) && token === sequence.current) { setDetail(value); if (!value.originalRetained) setOriginal(null); setUncertain(false); } });
    } catch (failure) { if (!abort.signal.aborted && valid(epoch, captured) && token === sequence.current) { if (financeCommandDenied(failure)) { clearPrivate(); onDenied?.(message(failure)); } setError(message(failure)); } }
    finally { if (valid(epoch, captured) && token === sequence.current) setReading(false); }
  }, [commandId, identity, transition, valid, clearPrivate, onDenied]);
  useLayoutEffect(() => { generation.current++; sequence.current++; readAbort.current?.abort(); transition.cancel(); owner.current = null; clearPrivate(); setPending(false); setUncertain(false); setError(""); }, [identity, commandId, transition, clearPrivate]);
  useEffect(() => { live.current = true; void reload(); return () => { live.current = false; generation.current++; sequence.current++; readAbort.current?.abort(); transition.cancel(); }; }, [reload, transition]);
  useLayoutEffect(() => {
    if (detail?.status !== "succeeded") return;
    const heading = resultHeading.current, dialog = heading?.closest("dialog");
    if (heading && dialog instanceof HTMLDialogElement && dialog.open) { dialog.scrollTo({ top: 0, behavior: "instant" }); heading.focus({ preventScroll: true }); }
  }, [detail?.id, detail?.status]);
  async function loadOriginal() {
    if (!detail || reading || owner.current) return;
    const epoch = generation.current, token = ++sequence.current, captured = identity.authority, basis = detail;
    readAbort.current?.abort(); const abort = new AbortController(); readAbort.current = abort; setReading(true); setError(""); setOriginal(null); setConfirmed(false);
    try {
      const value = await financeCommandRequest(`${commandId}/original`, FinanceCommandOriginalSchema, identity, undefined, abort.signal);
      if (!valid(epoch, captured) || token !== sequence.current) return;
      if (value.id !== basis.id || value.original && (value.original.kind !== basis.kind || value.original.targetId !== basis.targetId || value.original.input.idempotencyKey !== basis.requestKey))
        throw new FinanceCommandRequestError(502, "原填写与命令、目标或原键不一致 已停止执行");
      setOriginal(value.original); setOriginalRead(true);
      if (value.blockReason) setDetail(previous => previous && ({ ...previous, canExecute: false, blockReason: value.blockReason }));
    } catch (failure) { if (!abort.signal.aborted && valid(epoch, captured) && token === sequence.current) { if (financeCommandDenied(failure)) { clearPrivate(); onDenied?.(message(failure)); } setError(message(failure)); } }
    finally { if (valid(epoch, captured) && token === sequence.current) setReading(false); }
  }
  async function apply(action: "execute" | "cancel" | "acknowledge") {
    if (!detail || owner.current || reading || uncertain || action === "execute" && (!detail.canExecute || !original || !confirmed)) return;
    const epoch = generation.current, captured = identity.authority, expected = detail, lease = Symbol("finance-action"); owner.current = lease; setPending(true); setError(""); setConfirmed(false);
    try {
      const value = await financeCommandRequest(`${detail.id}/${action}`, FinanceCommandDetailSchema, identity, {});
      if (!valid(epoch, captured)) return;
      if (value.id !== expected.id || value.kind !== expected.kind || value.targetId !== expected.targetId || value.requestKey !== expected.requestKey)
        throw new FinanceCommandRequestError(502, "处理回执与原提交不一致 请重新读取");
      if (action === "execute" && (value.status !== "succeeded" || !value.result) || action === "acknowledge" && (!value.acknowledged || value.originalRetained) || action === "cancel" && !["cancelled", "expired"].includes(value.status))
        throw new FinanceCommandRequestError(502, "处理回执尚未确认该动作的真实结果 请重新读取原提交");
      if (action === "acknowledge") { setOriginal(null); onFinished(value); }
      else transition.change(() => { if (valid(epoch, captured)) { setDetail(value); if (!value.originalRetained) setOriginal(null); } });
    } catch (failure) { if (valid(epoch, captured)) { if (financeCommandDenied(failure)) { clearPrivate(); onDenied?.(message(failure)); } else setUncertain(true); setError(message(failure)); } }
    finally { if (owner.current === lease) { owner.current = null; if (live.current) setPending(false); } }
  }
  const reasons = { basis_changed: "原版本、来源或余额依据已变化 原填写保留 请取消准备后明确重新核对", permission_denied: "当前权限不足以执行此原提交", input_unavailable: "原填写暂时无法读取 不执行或重建新请求", expired: "填写副本已到期 不能继续执行 实际凭据仍保留" };
  return <section className="finance-command-review finance-command-view" aria-label="核对财务原提交" aria-busy={reading || pending}>
    <header><h3 tabIndex={-1} ref={resultHeading}>{detail ? financeCommandNames[detail.kind] : "本人财务原提交"}</h3><button type="button" disabled={pending || reading} onClick={() => void reload()}><RefreshCw size={14} />重新读取原提交</button></header>
    {reading && <p role="status">正在读取原提交 当前不执行任何业务</p>}
    {error && <p className="finance-command-notice is-error" role="alert">{error}</p>}
    {uncertain && <p className="finance-command-notice" role="status">本次处理结果未知 请重新读取原命令 判明 prepared 或 succeeded 后再操作 不自动重发执行</p>}
    {detail && <>
      <dl className="finance-command-pairs"><Pair label="原提交状态">{financeCommandStatusNames[detail.status]}</Pair><Pair label="原提交 ID"><code>{detail.id}</code></Pair><Pair label="固定业务目标"><code>{detail.targetId ?? "新建记录"}</code></Pair><Pair label="准备时间">{financeCommandTime(detail.createdAt)}</Pair><Pair label="填写副本保留至">{financeCommandTime(detail.expiresAt)}</Pair><Pair label="原提交键"><code>{detail.requestKey}</code></Pair></dl>
      {detail.blockReason && <p className="finance-command-notice is-error">{reasons[detail.blockReason]}</p>}
      {detail.result && <><FinanceCommandResultSummary result={detail.result} /><FinanceCommandResultReader commandId={detail.id} kind={detail.kind} targetId={detail.targetId}
        result={detail.result} executedAt={detail.completedAt} onDenied={reason => { clearPrivate(); setError(reason); onDenied?.(reason); }} /></>}
      {detail.originalRetained ? <><button type="button" disabled={pending || reading} onClick={() => void loadOriginal()}><FileSearch size={14} />{original ? "重新读取原填写" : "读取原填写并核对"}</button>{originalRead && !original && <p className="finance-command-notice">原填写当前不可读取 请重新读取原提交核对状态 不从当前业务数据重建原文</p>}{original && <FinanceCommandOriginalSummary key={`${detail.id}:${detail.status}`} original={original} />}</> : <p className="finance-command-note">原填写副本已清除或当前不可读取 实际不可变凭据引用保留</p>}
      <fieldset className="finance-command-actions" disabled={pending}>
        {detail.status === "prepared" && original && <AgentOperationHandoff reference={{ domain: "finance", commandId: detail.id, accountId: null }} disabled={pending || reading || uncertain || Boolean(error)} onDenied={reason => { generation.current++; sequence.current++; readAbort.current?.abort(); transition.cancel(); owner.current = null; clearPrivate(); setReading(false); setPending(false); setUncertain(false); setError(reason); onDenied?.(reason); }} />}
        {detail.canExecute && <label className="finance-command-confirm"><input type="checkbox" checked={confirmed} disabled={reading || uncertain || !original || Boolean(error)} onChange={event => setConfirmed(event.target.checked)} />我已核对原填写、真实来源与固定版本 明确执行这笔财务提交</label>}
        <div><button type="button" disabled={pending} onClick={onClose}>关闭核对</button>{detail.canCancel && <button type="button" disabled={reading || uncertain || Boolean(error)} onClick={() => void apply("cancel")}><RotateCcw size={14} />取消这笔准备</button>}{detail.canExecute && <button type="button" className="primary" disabled={reading || uncertain || !original || !confirmed || Boolean(error)} onClick={() => void apply("execute")}><Check size={14} />确认执行原提交</button>}{detail.canAcknowledge && <button type="button" className="primary" disabled={reading || uncertain || Boolean(error)} onClick={() => void apply("acknowledge")}>确认结果并清除填写副本</button>}</div>
      </fieldset>
      <p className="finance-command-note">取消只取消尚未执行的准备 确认只清除本人填写副本 均不冲销业务、不执行转账或退款 读取原提交不会再次登记</p>
    </>}
    {!detail && !reading && <button type="button" onClick={onClose}>关闭核对</button>}
  </section>;
}
export function FinanceCommandDialog({ commandId, onClose, onFinished, onDenied }: { commandId: string; onClose(): void; onFinished?(detail: FinanceCommandDetail): void; onDenied?(message: string): void }) {
  const [closing, setClosing] = useState(false), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const close = () => { if (closing) return; setClosing(true); timer.current = setTimeout(onClose, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160); };
  return <RecordDialog title="财务原填写与执行" onClose={close}><div className={closing ? "finance-command-exit" : undefined}><FinanceCommandReview commandId={commandId} onClose={close} onDenied={onDenied} onFinished={detail => { onFinished?.(detail); close(); }} /></div></RecordDialog>;
}

export function FinanceCommandWorkbench() {
  const access = useErpAccess(), canRead = access.can(Permission.FinanceRead) || access.can(Permission.FinanceWrite) || access.can(Permission.FinanceReview);
  const identity = useMemo(() => ({ authority: access.authority, localDevelopment: access.localDevelopment }), [access.authority, access.localDevelopment]);
  const [items, setItems] = useState<FinanceCommandSummary[]>([]), [cursor, setCursor] = useState<string | null>(null), [unavailable, setUnavailable] = useState(0);
  const [view, setView] = useState<"active" | "recorded">("active"), [idDraft, setIdDraft] = useState("");
  const [kind, setKind] = useState<FinanceCommandKind | "">(""), [targetDraft, setTargetDraft] = useState(""), [target, setTarget] = useState<string | null | undefined>();
  const [commandId, setCommandId] = useState<string | null>(null), [formKind, setFormKind] = useState<FinanceRecordKind | null>(null), [reading, setReading] = useState(false), [error, setError] = useState("");
  const live = useRef(true), sequence = useRef(0), controller = useRef<AbortController | null>(null), authority = useRef(access.authority); authority.current = access.authority;
  const transition = useOwnedViewTransition();
  const revoke = useCallback((reason: string) => { sequence.current++; controller.current?.abort(); transition.cancel(); setItems([]); setCursor(null); setUnavailable(0); setCommandId(null); setFormKind(null); setIdDraft(""); setTargetDraft(target === undefined ? "" : target ?? "root"); setReading(false); setError(reason); }, [target, transition]);
  const reload = useCallback(async (before?: string) => {
    if (!canRead) return;
    const token = ++sequence.current, captured = identity.authority; controller.current?.abort(); const abort = new AbortController(); controller.current = abort; setReading(true); setError("");
    const valid = () => live.current && token === sequence.current && authority.current === captured;
    const query = new URLSearchParams({ view }); if (kind) query.set("kind", kind); if (target !== undefined) query.set("targetId", target ?? "root"); if (before) query.set("before", before);
    try {
      const page = await financeCommandRequest(query.size ? `?${query}` : "", FinanceCommandListSchema, identity, undefined, abort.signal);
      if (page.items.some(row => view === "recorded" ? row.status !== "succeeded" || row.result === null : row.acknowledged)
        || page.items.some(row => kind && row.kind !== kind || target !== undefined && row.targetId !== target))
        throw new FinanceCommandRequestError(502, "返回列表与本人所选类型、目标或历史范围不一致 请重新读取");
      if (valid()) { setItems(previous => before ? [...new Map([...previous, ...page.items].map(row => [row.id, row])).values()] : page.items); setCursor(page.nextCursor); setUnavailable(previous => before ? previous + page.unavailableCount : page.unavailableCount); }
    } catch (failure) { if (!abort.signal.aborted && valid()) { if (financeCommandDenied(failure)) { setItems([]); setCursor(null); setUnavailable(0); setCommandId(null); setFormKind(null); setIdDraft(""); setTargetDraft(target === undefined ? "" : target ?? "root"); } setError(message(failure)); } }
    finally { if (valid()) setReading(false); }
  }, [identity, canRead, kind, target, view]);
  useLayoutEffect(() => { sequence.current++; controller.current?.abort(); transition.cancel(); setItems([]); setCursor(null); setUnavailable(0); setCommandId(null); setFormKind(null); setTargetDraft(""); setTarget(undefined); setIdDraft(""); setView("active"); setError(""); setReading(false); }, [identity, canRead, transition]);
  useEffect(() => { live.current = true; if (canRead) void reload(); return () => { live.current = false; sequence.current++; controller.current?.abort(); }; }, [canRead, reload]);
  useEffect(() => { const check = () => { if (document.visibilityState === "visible" && canRead) void reload(); }; window.addEventListener("focus", check); document.addEventListener("visibilitychange", check); return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); }; }, [reload, canRead]);
  const clearList = () => { sequence.current++; controller.current?.abort(); transition.cancel(); setItems([]); setCursor(null); setUnavailable(0); setCommandId(null); setReading(false); setError(""); };
  return <section className="finance-command-workbench" aria-label="本人财务原提交">
    <header className="finance-command-heading"><div><ClipboardList size={19} /><h2>本人财务原提交</h2></div><button type="button" disabled={!canRead || reading} onClick={() => void reload()}><RefreshCw size={14} />重新读取原提交</button></header>
    <p className="finance-command-note">恢复本人待确认提交 或独立核对已登记的历史结果 列表只载入摘要 原文与历史结果分别受权读取 不依赖业务列表的当前页 不发起银行动作</p>
    {!canRead ? <p role="status">当前没有读取本人财务原提交的权限 私有填写与记录已清除</p> : <>
      <nav className="finance-command-new" aria-label="新增财务原填写">{(["statement_record", "fx_rate_record", "metric_upsert", "profit_calculate"] as const).filter(value => access.can(financeCommandPermission(value))).map(value => <button type="button" key={value} onClick={() => setFormKind(value)}><Plus size={14} />{financeCommandNames[value]}</button>)}</nav>
      <nav className="finance-command-view-switch" aria-label="原提交查看范围"><button type="button" aria-pressed={view === "active"} onClick={() => { if (view !== "active") { clearList(); transition.change(() => setView("active")); } }}>待核对原提交</button><button type="button" aria-pressed={view === "recorded"} onClick={() => { if (view !== "recorded") { clearList(); transition.change(() => setView("recorded")); } }}>已登记结果</button></nav>
      <form className="finance-command-id-lookup" aria-label="按原提交 ID 读取" onSubmit={event => { event.preventDefault(); const parsed = EntityIdSchema.safeParse(idDraft.trim()); if (!parsed.success) { setError("请填写真实的本人原提交 ID 不以业务凭据 ID 替代"); return; } setError(""); setCommandId(parsed.data.toLowerCase()); }}><Field label="原提交 ID" help="可读取本人已确认或原填写已清除的实际结果"><input value={idDraft} onChange={event => setIdDraft(event.target.value)} maxLength={36} required autoComplete="off" /></Field><button type="submit"><FileSearch size={14} />按原提交 ID 读取</button></form>
      <form className="finance-command-filters" aria-label="筛选本人财务原提交" onSubmit={event => { event.preventDefault(); const value = targetDraft.trim(); if (value && value !== "root" && !EntityIdSchema.safeParse(value).success) { setError("业务目标须为真实 ID 或 root 新建范围"); return; } const next = value ? value === "root" ? null : value.toLowerCase() : undefined; clearList(); if (next === target) void reload(); else transition.change(() => setTarget(next)); }}>
        <Field label="原提交类型"><select value={kind} onChange={event => { clearList(); setKind(event.target.value ? FinanceCommandKindSchema.parse(event.target.value) : ""); setTarget(undefined); setTargetDraft(""); }}><option value="">全部可读取类型</option>{FinanceCommandKindSchema.options.map(value => <option key={value} value={value}>{financeCommandNames[value]}</option>)}</select></Field><Field label="固定业务目标筛选" help="留空读取全部目标 root表示新建范围"><input value={targetDraft} onChange={event => setTargetDraft(event.target.value)} maxLength={36} autoComplete="off" /></Field><button type="submit" disabled={reading}>读取此范围</button>
      </form>
      {error && <p className="finance-command-notice is-error" role="alert">{error}</p>}
      {!items.length && !error && <p role="status">{reading ? "正在读取本人原提交摘要" : view === "recorded" ? "此范围没有可读取的本人已登记结果" : "此范围没有待确认的本人原提交"}</p>}
      <ul className="finance-command-list">{items.map(row => <li key={row.id}><div><strong>{financeCommandNames[row.kind]}</strong><span>{financeCommandStatusNames[row.status]} · {financeCommandTime(row.createdAt)}</span><small>原提交 <code>{row.id}</code></small><code>{row.targetId ?? "新建记录"}</code>{row.result && <small>实际凭据 {row.result.id}</small>}{view === "recorded" && <small>{row.acknowledged ? "原填写已确认清除 历史结果仍可核对" : row.originalRetained ? "原填写仍单独受权保留" : "原填写当前不可读取 历史结果独立保留"}</small>}</div><button type="button" disabled={reading} onClick={() => setCommandId(row.id)}>{view === "recorded" ? "核对历史结果" : "恢复原提交"}</button></li>)}</ul>
      {unavailable > 0 && <p className="finance-command-notice">本次读取有 {unavailable} 笔原提交的依据当前不可访问 未显示私有内容 仍可继续读取后页</p>}
      {cursor && <button type="button" disabled={reading} onClick={() => void reload(cursor)}>{view === "recorded" ? "读取更早的已登记结果" : "读取更早的原提交"}</button>}
      <p className="finance-command-note">{view === "recorded" ? "按实际已成功命令读取本人历史 包含已确认和填写副本已清除的结果" : "当前只展示本人尚未确认的记录 已确认结果可切换到已登记结果读取"} 已读 {items.length} 笔 不把本页或业务工作区当前页当作完整历史</p>
      {commandId && <FinanceCommandDialog commandId={commandId} onClose={() => setCommandId(null)} onFinished={() => void reload()} onDenied={revoke} />}
      {formKind && <RecordDialog title={financeCommandNames[formKind]} protectEdits onClose={() => { setFormKind(null); void reload(); }}><FinanceRecordForms key={`${access.authority}:${formKind}`} kind={formKind} Form={FinanceCommandForm} onDenied={revoke} onClose={() => { setFormKind(null); void reload(); }} /></RecordDialog>}
    </>}
  </section>;
}
function Pair({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
export default FinanceCommandWorkbench;
