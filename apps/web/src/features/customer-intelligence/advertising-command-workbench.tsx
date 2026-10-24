"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ClipboardList, FileSearch, RefreshCw, RotateCcw } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { AdvertisingWorkspaceSchema, type AdvertisingWorkspace } from "@yummyai/contracts/advertising";
import {
  AdCommandDetailSchema, AdCommandKindSchema, AdCommandListSchema, AdCommandOriginalSchema, adCommandScopeKey,
  type AdCommandDetail, type AdCommandKind, type AdCommandSummary, type PrepareAdCommand,
} from "@yummyai/contracts/advertising/command";
import { useErpAccess } from "../identity/erp-access";
import { RecordDialog } from "../manual-operations/record-form";
import { AgentOperationHandoff } from "../ai-tasks/agent-operation-handoff";
import { adCheckAuthority, adCommandRequest, adDenied, adError, adRecheckSession, adRequest, AdRequestError } from "./advertising-client";
import { AdCommandOriginalSummary, adCommandNames, adCommandPermission, adCommandStatusNames, adCommandAccountPath, type AdCommandMutation } from "./advertising-command-forms";
import "../manual-operations/manual-operations.css";
import "./advertising-command.css";

export function AdCommandResultSummary({ detail }: { detail: AdCommandDetail }) {
  const result = detail.result;
  if (!result) return null;
  const recordKind = { goal_save: "goals", observation_record: "observations", analysis_run: "analyses", export_seal: "exports" } as const;
  let location: string | null = null;
  if (detail.kind === "action_transition" && result.parentId) location = `history:action_events:${result.parentId}:${result.id}`;
  else if (detail.kind === "import_archive" && result.parentId) location = `history:import_events:${result.parentId}:${result.id}`;
  else if (detail.kind in recordKind) location = `history:${recordKind[detail.kind as keyof typeof recordKind]}:${result.id}`;
  const href = `/customer-intelligence?${new URLSearchParams({ account: detail.accountId, tab: "history", ...(location ? { detail: location } : {}) })}`;
  return <section className="ad-command-result" aria-label="广告实际登记凭据"><h4>实际登记凭据</h4><p>以下是原命令实际返回的不可变凭据引用 与随后读取的当前业务状态分开</p><dl className="ad-command-pairs"><div><dt>实际凭据 ID</dt><dd><code>{result.id}</code></dd></div><div><dt>实际父记录</dt><dd><code>{result.parentId ?? "无父记录"}</code></dd></div><div><dt>实际版本</dt><dd>{result.version === null ? "此凭据不含版本" : `V${result.version}`}</dd></div><div><dt>实际完成时间</dt><dd>{detail.completedAt ?? "未提供"}</dd></div></dl>{detail.kind === "import_commit" && <p>此 ID 为导入批次凭据 不冒充单份来源 ID 各来源需到完整历史按真实记录核对</p>}<Link href={href}>{location ? "按真实凭据 ID 读取历史" : "到完整历史核对实际来源"}</Link></section>;
}

export function AdCommandReview({ commandId, accountId, onClose, onFinished, onDenied }: {
  commandId: string; accountId: string; onClose(): void; onFinished(detail: AdCommandDetail): void; onDenied?(message: string): void;
}) {
  const access = useErpAccess();
  const identity = useMemo(() => ({ authority: access.authority, preferenceScope: access.preferenceScope, localDevelopment: access.localDevelopment }), [access.authority, access.preferenceScope, access.localDevelopment]);
  const stamp = `${identity.authority}:${identity.preferenceScope}:${accountId}:${commandId}`;
  const [snapshot, setSnapshot] = useState<{ stamp: string; value: AdCommandDetail } | null>(null), [original, setOriginal] = useState<{ stamp: string; value: PrepareAdCommand } | null>(null);
  const [reading, setReading] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState(""), [uncertain, setUncertain] = useState(false), [confirmed, setConfirmed] = useState(false), [originalRead, setOriginalRead] = useState(false);
  const sequence = useRef(0), live = useRef(true), controller = useRef<AbortController | null>(null), lease = useRef<symbol | null>(null), known = useRef<string | null>(null), heading = useRef<HTMLHeadingElement | null>(null);
  const current = useRef(stamp); current.current = stamp;
  const callbacks = useRef({ onDenied, onFinished }); callbacks.current = { onDenied, onFinished };
  const detail = snapshot?.stamp === stamp ? snapshot.value : null, body = original?.stamp === stamp ? original.value : null;
  const clear = useCallback(() => { setSnapshot(null); setOriginal(null); setOriginalRead(false); setConfirmed(false); known.current = null; }, []);
  const deny = useCallback((reason: string) => { sequence.current++; controller.current?.abort(); clear(); setReading(false); setPending(false); setUncertain(false); adRecheckSession(); callbacks.current.onDenied?.(reason); }, [clear]);
  const reload = useCallback(async () => {
    if (lease.current || !EntityIdSchema.safeParse(commandId).success || !EntityIdSchema.safeParse(accountId).success) return;
    const token = ++sequence.current; controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    const valid = () => live.current && !abort.signal.aborted && token === sequence.current && current.current === stamp;
    setReading(true); setError(""); setConfirmed(false);
    try {
      const value = await adCommandRequest(adCommandAccountPath(commandId, accountId), AdCommandDetailSchema, identity, undefined, abort.signal);
      if (!valid()) return;
      if (value.id !== commandId || value.accountId !== accountId) throw new AdRequestError(502, "原命令详情与固定账户或 ID 不一致");
      known.current = stamp; setSnapshot({ stamp, value }); setUncertain(false);
      if (!value.originalRetained) { setOriginal(null); setOriginalRead(false); }
    } catch (failure) {
      if (!valid()) return;
      if (adDenied(failure) || failure instanceof AdRequestError && failure.status === 404 && known.current === stamp) deny(adError(failure));
      setError(adError(failure));
    } finally { if (valid()) setReading(false); }
  }, [commandId, accountId, stamp, identity, deny]);
  useLayoutEffect(() => { sequence.current++; controller.current?.abort(); lease.current = null; clear(); setReading(false); setPending(false); setError(""); setUncertain(false); }, [stamp, clear]);
  useEffect(() => { live.current = true; void reload(); return () => { live.current = false; sequence.current++; controller.current?.abort(); }; }, [reload]);
  useLayoutEffect(() => {
    if (detail?.status !== "succeeded") return;
    const dialog = heading.current?.closest("dialog");
    if (dialog instanceof HTMLDialogElement && dialog.open) { dialog.scrollTo({ top: 0, behavior: "instant" }); heading.current?.focus({ preventScroll: true }); }
  }, [detail?.id, detail?.status]);
  async function readOriginal() {
    if (!detail || lease.current || reading) return;
    const expected = detail, token = ++sequence.current; controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    const valid = () => live.current && !abort.signal.aborted && sequence.current === token && current.current === stamp;
    setReading(true); setOriginal(null); setOriginalRead(false); setConfirmed(false); setError("");
    try {
      const value = await adCommandRequest(adCommandAccountPath(commandId, accountId, "original"), AdCommandOriginalSchema, identity, undefined, abort.signal);
      if (!valid()) return;
      if (value.id !== commandId || value.accountId !== accountId || value.original && (value.original.kind !== expected.kind || value.original.targetId !== expected.targetId || value.original.input.idempotencyKey !== expected.requestKey || adCommandScopeKey(value.original) !== expected.scopeKey)) throw new AdRequestError(502, "原填写与原命令 目标 产品范围或原键不一致 未允许执行");
      setOriginalRead(true); setOriginal(value.original ? { stamp, value: value.original } : null);
      if (value.blockReason) setSnapshot(previous => previous?.stamp === stamp ? { stamp, value: { ...previous.value, canExecute: false, blockReason: value.blockReason } } : previous);
    } catch (failure) {
      if (!valid()) return;
      if (adDenied(failure) || failure instanceof AdRequestError && failure.status === 404 && known.current === stamp) deny(adError(failure));
      setError(adError(failure));
    } finally { if (valid()) setReading(false); }
  }
  async function apply(action: "execute" | "cancel" | "acknowledge") {
    if (!detail || lease.current || reading || uncertain || action === "execute" && (!detail.canExecute || !body || !confirmed) || action === "cancel" && !detail.canCancel || action === "acknowledge" && !detail.canAcknowledge) return;
    const expected = detail, owner = Symbol("ad-command-action"); lease.current = owner; setPending(true); setConfirmed(false); setError("");
    const valid = () => live.current && current.current === stamp;
    try {
      const value = await adCommandRequest(adCommandAccountPath(commandId, accountId, action), AdCommandDetailSchema, identity, {});
      if (!valid()) return;
      if (value.id !== expected.id || value.accountId !== accountId || value.kind !== expected.kind || value.targetId !== expected.targetId || value.scopeKey !== expected.scopeKey || value.requestKey !== expected.requestKey) throw new AdRequestError(502, "处理回执与原命令不一致 请读取原 ID 核对 不重发新提交");
      if (action === "execute" && (value.status !== "succeeded" || !value.result) || action === "cancel" && !["cancelled", "expired"].includes(value.status) || action === "acknowledge" && (!value.acknowledged || value.originalRetained)) throw new AdRequestError(502, "尚未取得此动作的确切回执 请读取原命令判明结果");
      setSnapshot({ stamp, value }); if (!value.originalRetained) { setOriginal(null); setOriginalRead(false); }
      if (action === "acknowledge") callbacks.current.onFinished(value);
    } catch (failure) {
      if (!valid()) return;
      if (adDenied(failure) || failure instanceof AdRequestError && failure.status === 404) deny(adError(failure)); else setUncertain(true);
      setError(adError(failure));
    } finally { if (lease.current === owner) { lease.current = null; if (valid()) setPending(false); } }
  }
  const reasons = { basis_changed: "原版本 来源或观察期依据已变化 请核对原文 不自动换版本或重采输入", permission_denied: "当前权限不足以执行原提交", input_unavailable: "原文当前不可完整读取 不从业务列表重建", expired: "填写副本已到期 实际业务凭据引用仍保留" };
  return <section className="ad-command-review" aria-label="核对广告原提交" aria-busy={reading || pending}><header><h3 ref={heading} tabIndex={-1}>{detail ? adCommandNames[detail.kind] : "本人广告原提交"}</h3><button type="button" disabled={reading || pending} onClick={() => void reload()}><RefreshCw size={14} />重新读取原命令</button></header>
    {reading && <p role="status">正在读取原命令 未执行任何广告业务</p>}{error && <p className="ad-command-notice is-error" role="alert">{error}</p>}{uncertain && <p className="ad-command-notice" role="status">处理结果未知 只按原命令 ID 读取 判明准备或成功后再明确操作 不自动二次执行</p>}
    {detail && <><dl className="ad-command-pairs"><div><dt>原提交状态</dt><dd>{adCommandStatusNames[detail.status]}</dd></div><div><dt>原命令 ID</dt><dd><code>{detail.id}</code></dd></div><div><dt>固定广告账户</dt><dd><code>{detail.accountId}</code></dd></div><div><dt>固定业务目标</dt><dd><code>{detail.targetId ?? "新建范围"}</code></dd></div><div><dt>固定产品或操作范围</dt><dd>{detail.scopeKey}</dd></div><div><dt>原提交键</dt><dd><code>{detail.requestKey}</code></dd></div><div><dt>准备／保留截止</dt><dd>{detail.createdAt} 至 {detail.expiresAt}</dd></div></dl>
      {detail.status === "prepared" && <p className="ad-command-notice">原填写已保存 准备不等于实际业务已写入 必须读取原文并明确核对后执行</p>}{detail.blockReason && <p className="ad-command-notice is-error">{reasons[detail.blockReason]}</p>}<AdCommandResultSummary detail={detail} />
      {detail.originalRetained ? <><button type="button" disabled={reading || pending} onClick={() => void readOriginal()}><FileSearch size={14} />{body ? "重新读取广告原文" : "读取广告原文并核对"}</button>{originalRead && !body && <p>原文当前不可读取 请重新读取原命令 不用今天的工作区补原文</p>}{body && <AdCommandOriginalSummary key={detail.id} original={body} />}</> : <p>本人填写副本已清除或到期 原业务事实与实际凭据不因此撤销</p>}
      {detail.status === "prepared" && body && <AgentOperationHandoff reference={{ domain: "advertising", commandId: detail.id, accountId: detail.accountId }} disabled={pending || reading || uncertain || Boolean(error)} onDenied={deny} />}
      <fieldset className="ad-command-actions" disabled={pending}>{detail.canExecute && <label className="ad-command-confirm"><input type="checkbox" checked={confirmed} disabled={reading || uncertain || !body || Boolean(error)} onChange={event => setConfirmed(event.target.checked)} />我已核对原填写 真实来源 固定版本与观察期 明确执行此原提交</label>}<div><button type="button" onClick={onClose} disabled={pending}>关闭核对</button>{detail.canCancel && <button type="button" disabled={reading || uncertain || Boolean(error)} onClick={() => void apply("cancel")}><RotateCcw size={14} />取消这笔广告准备</button>}{detail.canExecute && <button type="button" className="primary" disabled={reading || uncertain || !body || !confirmed || Boolean(error)} onClick={() => void apply("execute")}><Check size={14} />确认执行广告原提交</button>}{detail.canAcknowledge && <button type="button" className="primary" disabled={reading || uncertain || Boolean(error)} onClick={() => void apply("acknowledge")}>确认结果并清除填写副本</button>}{detail.acknowledged && <button type="button" disabled={reading || uncertain || Boolean(error)} onClick={() => callbacks.current.onFinished(detail)}>完成核对并返回</button>}</div></fieldset><p>取消仅取消尚未执行的准备 确认仅清除本人填写副本 均不撤销事实 也不执行广告后台修改</p>
    </>}{!detail && !reading && <button type="button" onClick={onClose}>关闭核对</button>}
  </section>;
}

export function AdCommandMutationPanel({ mutation, accountId, onCompleted, onDenied }: { mutation: AdCommandMutation; accountId: string; onCompleted?(detail: AdCommandDetail): void; onDenied?(message: string): void }) {
  const [closingId, setClosingId] = useState<string | null>(null), closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; } }, [mutation.commandId, mutation.reviewOpen]);
  if (!mutation.commandId) return null;
  const commandId = mutation.commandId;
  if (!mutation.reviewOpen) return <section className="ad-command-retained" aria-label="已保存的广告原提交"><p>原填写已保存在本人原提交 当前页面副本已清除 不另建提交键</p><code>{commandId}</code><button type="button" onClick={mutation.openReview}>继续核对已保存原提交</button><Link href={`/advertising/originals?${new URLSearchParams({ account: accountId, detail: `command:${commandId}` })}`}>到本人广告原提交恢复</Link></section>;
  const closing = closingId === commandId;
  const close = () => { if (closeTimer.current) return; setClosingId(commandId); closeTimer.current = setTimeout(() => { closeTimer.current = null; setClosingId(null); mutation.closeReview(); }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160); };
  return <div className={closing ? "ad-command-exit" : undefined} inert={closing}><AdCommandReview commandId={commandId} accountId={accountId} onClose={close} onDenied={onDenied} onFinished={detail => { mutation.finish(); onCompleted?.(detail); }} /></div>;
}
export function AdCommandDialog({ accountId, commandId, onClose, onFinished, onDenied }: { accountId: string; commandId: string; onClose(): void; onFinished?(): void; onDenied?(message: string): void }) {
  const [closing, setClosing] = useState(false), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const close = () => { if (closing) return; setClosing(true); timer.current = setTimeout(onClose, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160); };
  return <RecordDialog title="广告原填写与执行" onClose={close}><div className={closing ? "ad-command-exit" : undefined}><AdCommandReview accountId={accountId} commandId={commandId} onClose={close} onFinished={() => { onFinished?.(); close(); }} onDenied={onDenied} /></div></RecordDialog>;
}

export function AdvertisingCommandWorkbench() {
  const query = useSearchParams(), queryKey = query.toString(), access = useErpAccess();
  const location = typeof window === "undefined" ? new URLSearchParams(queryKey) : new URLSearchParams(window.location.search);
  const requestedAccount = EntityIdSchema.safeParse(location.get("account")), requestedId = /^command:([0-9a-f-]{36})$/i.exec(location.get("detail") ?? "")?.[1];
  const urlAccount = requestedAccount.success ? requestedAccount.data.toLowerCase() : "";
  const canAny = access.can(Permission.CustomerIntelligenceRead) || access.can(Permission.CustomerIntelligenceWrite) || access.can(Permission.CustomerIntelligenceReview);
  const identity = useMemo(() => ({ authority: access.authority, preferenceScope: access.preferenceScope, localDevelopment: access.localDevelopment }), [access.authority, access.preferenceScope, access.localDevelopment]);
  const owner = `${identity.authority}:${identity.preferenceScope}`;
  const [accountId, setAccountId] = useState(urlAccount), [directory, setDirectory] = useState<{ owner: string; scope: string; accounts: AdvertisingWorkspace["accounts"] } | null>(null);
  const [page, setPage] = useState<{ stamp: string; rows: AdCommandSummary[]; next: string | null; unavailable: number } | null>(null), [view, setView] = useState<"active" | "recorded">("active"), [kind, setKind] = useState<AdCommandKind | "">("");
  const [commandId, setCommandId] = useState<string | null>(null), [idDraft, setIdDraft] = useState(""), [targetDraft, setTargetDraft] = useState(""), [targetId, setTargetId] = useState<string | null | undefined>();
  const [reading, setReading] = useState(false), [error, setError] = useState(""), [denied, setDenied] = useState(false);
  const accounts = directory?.owner === owner ? directory.accounts : [], account = accounts.find(value => value.id === accountId);
  const urlReady = urlAccount === accountId;
  const permitted = canAny && !denied && urlReady && directory?.scope === accountId && Boolean(account && (account.access.canRead || account.access.canWrite || account.access.canReview));
  const stamp = `${owner}:${accountId}:${kind}:${targetId}:${view}:${permitted}`;
  const live = useRef(true), sequence = useRef(0), abort = useRef<AbortController | null>(null), directorySequence = useRef(0), current = useRef({ stamp, owner, accountId }); current.current = { stamp, owner, accountId };
  const known = useRef<string | null>(null), knownDirectory = useRef<string | null>(null);
  const updateUrl = useCallback((selected: string, command: string | null) => { const url = new URL(window.location.href); if (selected) url.searchParams.set("account", selected); else url.searchParams.delete("account"); if (command) url.searchParams.set("detail", `command:${command}`); else url.searchParams.delete("detail"); window.history.replaceState(null, "", `${url.pathname}${url.search}`); }, []);
  const clearPrivate = useCallback((reason = "") => { sequence.current++; abort.current?.abort(); setPage(null); setCommandId(null); setIdDraft(""); setTargetDraft(""); setTargetId(undefined); setReading(false); known.current = null; setError(reason); }, []);
  const revoke = useCallback((reason: string) => { clearPrivate(reason); setDirectory(null); setDenied(true); adRecheckSession(); }, [clearPrivate]);
  useLayoutEffect(() => { clearPrivate(); setDirectory(null); knownDirectory.current = null; setDenied(false); setView("active"); setKind(""); }, [owner, canAny, clearPrivate]);
  useLayoutEffect(() => { if (urlAccount !== accountId) { clearPrivate(); setAccountId(urlAccount); } }, [urlAccount, accountId, clearPrivate]);
  useEffect(() => {
    if (!canAny || denied) return;
    const token = ++directorySequence.current, captured = owner; const controller = new AbortController();
    void adRequest(`workspace${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""}`, undefined, controller.signal).then(raw => {
      if (!live.current || controller.signal.aborted || directorySequence.current !== token || current.current.owner !== captured) return;
      const value = AdvertisingWorkspaceSchema.parse(raw); adCheckAuthority(value, identity);
      if (value.accountId !== (accountId || null)) throw new AdRequestError(502, "返回账户目录与本次所选账户不一致");
      knownDirectory.current = `${captured}:${accountId}`;
      setDirectory({ owner: captured, scope: accountId, accounts: value.accounts });
      if (!accountId && value.accounts[0]) { setAccountId(value.accounts[0].id); updateUrl(value.accounts[0].id, null); }
    }).catch(failure => { if (!controller.signal.aborted && current.current.owner === captured) { if (adDenied(failure) || failure instanceof AdRequestError && failure.status === 404 && knownDirectory.current === `${captured}:${accountId}`) revoke(adError(failure)); else setError(adError(failure)); } });
    return () => { controller.abort(); directorySequence.current++; };
  }, [canAny, denied, owner, identity, accountId, revoke, updateUrl]);
  useLayoutEffect(() => {
    if (!permitted) return;
    const parsed = EntityIdSchema.safeParse(requestedId);
    if (parsed.success) { setCommandId(parsed.data.toLowerCase()); setIdDraft(parsed.data.toLowerCase()); }
    else setCommandId(null);
  }, [requestedId, permitted, accountId]);
  const reload = useCallback(async (before?: string) => {
    if (!permitted) return;
    const token = ++sequence.current; abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    const valid = () => live.current && !controller.signal.aborted && token === sequence.current && current.current.stamp === stamp;
    setReading(true); setError("");
    const params = new URLSearchParams({ accountId, view }); if (kind) params.set("kind", kind); if (targetId !== undefined) params.set("targetId", targetId ?? "root"); if (before) params.set("before", before);
    try {
      const value = await adCommandRequest(`?${params}`, AdCommandListSchema, identity, undefined, controller.signal);
      if (!valid()) return;
      if (value.accountId !== accountId || value.items.some(row => kind && row.kind !== kind || targetId !== undefined && row.targetId !== targetId || view === "active" && row.acknowledged || view === "recorded" && row.status !== "succeeded")) throw new AdRequestError(502, "本人广告原提交列表与固定筛选范围不一致");
      known.current = stamp; setPage(previous => ({ stamp, rows: before && previous?.stamp === stamp ? [...new Map([...previous.rows, ...value.items].map(row => [row.id, row])).values()] : value.items, next: value.nextCursor, unavailable: (before && previous?.stamp === stamp ? previous.unavailable : 0) + value.unavailableCount }));
    } catch (failure) { if (valid()) { if (adDenied(failure) || failure instanceof AdRequestError && failure.status === 404 && known.current === stamp) revoke(adError(failure)); else setError(adError(failure)); } }
    finally { if (valid()) setReading(false); }
  }, [permitted, stamp, accountId, view, kind, targetId, identity, revoke]);
  useEffect(() => { live.current = true; if (permitted) void reload(); return () => { sequence.current++; abort.current?.abort(); }; }, [permitted, reload]);
  useEffect(() => () => { live.current = false; sequence.current++; directorySequence.current++; abort.current?.abort(); }, []);
  const shown = permitted && page?.stamp === stamp ? page : null;
  return <section className="ad-command-workbench" aria-label="本人广告原提交"><header><h2><ClipboardList size={18} />本人广告原提交</h2><button type="button" disabled={!permitted || reading} onClick={() => void reload()}><RefreshCw size={14} />重新读取本人原提交</button></header><p>原准备与执行分开 关页或重新登录后可恢复本人已保存原提交 列表只有摘要 明确读取后才载入单份完整原文 不依赖近期业务列表</p>
    {!canAny && <p role="status">当前没有广告读取 录入或审核权限 私有记录与填写已清除</p>}
    <label>原提交广告账户<select aria-label="原提交广告账户" value={urlReady ? accountId : urlAccount} disabled={!canAny || denied} onChange={event => { clearPrivate(); setAccountId(event.target.value); updateUrl(event.target.value, null); }}><option value="">选择当前可访问的账户</option>{accounts.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
    {error && <p className="ad-command-notice is-error" role="alert">{error}</p>}{denied && <button type="button" onClick={() => { setDenied(false); setError(""); }}>重新核对当前本人权限</button>}
    {permitted && <><nav className="ad-command-view" aria-label="广告原提交查看范围"><button type="button" aria-pressed={view === "active"} onClick={() => { if (view !== "active") { clearPrivate(); setView("active"); updateUrl(accountId, null); } }}>待核对原提交</button><button type="button" aria-pressed={view === "recorded"} onClick={() => { if (view !== "recorded") { clearPrivate(); setView("recorded"); updateUrl(accountId, null); } }}>已登记结果</button></nav>
      <form className="ad-command-lookup" onSubmit={event => { event.preventDefault(); const parsed = EntityIdSchema.safeParse(idDraft.trim()); if (!parsed.success) { setError("请填写真实本人广告原提交 ID 不用业务凭据 ID 替代"); return; } setCommandId(parsed.data.toLowerCase()); updateUrl(accountId, parsed.data.toLowerCase()); }}><label>广告原提交 ID<input required maxLength={36} value={idDraft} onChange={event => setIdDraft(event.target.value)} autoComplete="off" /></label><button type="submit"><FileSearch size={14} />按原提交 ID 读取</button></form>
      <form className="ad-command-filter" onSubmit={event => { event.preventDefault(); const value = targetDraft.trim(), parsed = value === "root" || value === "" ? null : EntityIdSchema.safeParse(value); if (parsed && !parsed.success) { setError("固定目标须为真实 ID 或 root 新建范围"); return; } const nextTarget = value === "" ? undefined : value === "root" ? null : parsed && parsed.success ? parsed.data.toLowerCase() : undefined; if (nextTarget === targetId) void reload(); else { setPage(null); setTargetId(nextTarget); } }}><label>广告原提交类型<select value={kind} onChange={event => { clearPrivate(); setKind(event.target.value ? AdCommandKindSchema.parse(event.target.value) : ""); }}><option value="">全部当前可读取类型</option>{AdCommandKindSchema.options.filter(value => access.can(Permission.CustomerIntelligenceRead) || access.can(adCommandPermission(value))).map(value => <option key={value} value={value}>{adCommandNames[value]}</option>)}</select></label><label>原业务目标筛选<input value={targetDraft} onChange={event => setTargetDraft(event.target.value)} maxLength={36} placeholder="留空全部 root表示新建范围" autoComplete="off" /></label><button type="submit" disabled={reading}>读取原提交范围</button></form>
      {reading && <p role="status">正在读取本人原提交摘要</p>}<ul className="ad-command-list">{shown?.rows.map(row => <li key={row.id}><div><strong>{adCommandNames[row.kind]}</strong><span>{adCommandStatusNames[row.status]} · {row.createdAt}</span><code>{row.id}</code><small>固定范围 {row.scopeKey}</small>{row.result && <small>实际凭据 <code>{row.result.id}</code></small>}<small>{row.acknowledged ? "填写副本已确认清除" : row.originalRetained ? "原文单独受权保留" : "原文未保留或到期"}</small></div><button type="button" onClick={() => { setCommandId(row.id); setIdDraft(row.id); updateUrl(accountId, row.id); }}>恢复并核对原提交</button></li>)}</ul>
      {!reading && !error && !shown?.rows.length && <p role="status">当前范围没有可读取的本人原提交</p>}{shown && shown.unavailable > 0 && <p>本轮有 {shown.unavailable} 笔依据当前不可访问 未显示私有内容 仍可继续翻页</p>}{shown?.next && <button type="button" disabled={reading} onClick={() => void reload(shown.next!)}>读取更早的广告原提交</button>}<p>已读 {shown?.rows.length ?? 0} 笔 每次最多 50 笔 不把当前页当作完整历史</p>
      {commandId && <AdCommandDialog key={`${stamp}:${commandId}`} accountId={accountId} commandId={commandId} onClose={() => { setCommandId(null); updateUrl(accountId, null); }} onFinished={() => void reload()} onDenied={revoke} />}
    </>}
  </section>;
}
export default AdvertisingCommandWorkbench;
