"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, BookOpen, CircleAlert, FileSearch, Link2, RefreshCw, Search } from "lucide-react";
import type { z } from "zod";
import { Permission } from "@yummyai/authz/permissions";
import {
  FinanceLedgerDetailInputSchema, FinanceLedgerDetailViewSchema, FinanceLedgerKindSchema,
  FinanceLedgerListInputSchema, FinanceLedgerPageViewSchema, financeLedgerParentKinds, financeLedgerDetailParentId,
  type FinanceLedgerDetailInput, type FinanceLedgerDetailView, type FinanceLedgerKind,
  type FinanceLedgerPageView, type FinanceLedgerSummary,
} from "@yummyai/contracts/finance/ledger";
import { formatFinanceMinorAmount } from "@yummyai/contracts/finance/monetary";
import type { FinanceBillBalance, FinancePaymentBalance } from "@yummyai/contracts/finance/payables-adjustments";
import { useErpAccess } from "../identity/erp-access";
import { RecordDialog } from "../manual-operations/record-form";
import { useOwnedViewTransition } from "../navigation/use-owned-view-transition";
import "../manual-operations/manual-operations.css";
import "./finance-ledger-workspace.css";

const kindNames: Record<FinanceLedgerKind, string> = {
  statements: "结算与费用单据", facts: "财务事实行", fx_rates: "历史汇率", metrics: "利润指标",
  metric_versions: "利润指标版本", profit_runs: "利润计算记录", contributions: "利润贡献行",
  bills: "应付账单", payments: "付款证据", allocation_batches: "付款核销批次", allocations: "核销记录",
  releases: "核销撤销凭据", bill_adjustments: "应付更正凭据", payment_adjustments: "付款更正凭据",
  procurement_adjustments: "已批准采购调整来源",
};
const statusNames: Record<string, string> = {
  active: "有效", inactive: "停用", unallocated: "未核销", partially_allocated: "部分核销", fully_allocated: "已全额核销",
  fully_credited: "已全额贷记", fully_refunded: "已全额登记退款", voided: "已作废", credit: "贷项", debit: "补差",
  refund: "已发生退款证据", source_acknowledgement: "采购来源确认 无金额变化", void: "作废凭据",
  source_format_not_supported: "来源格式无法精确同步", source_adjusted: "原采购已有未同步调整", source_unavailable: "来源暂不可核对",
  source_unreconciled: "采购差异待核对", current: "来源核对有效", operator_recorded: "人工登记 未经银行认证",
  original: "原始事实", reversal: "冲销事实", replacement: "替代事实", complete: "完整", incomplete: "待完整核对",
};
type LedgerScope = { kind: FinanceLedgerKind; parentId: string | null };
type LedgerTarget = Omit<FinanceLedgerDetailInput, "parentId"> & { parentId: string | null };

export function FinanceLedgerWorkspace() {
  const access = useErpAccess(), canRead = access.can(Permission.FinanceRead), transition = useOwnedViewTransition();
  const [scope, setScope] = useState<LedgerScope>({ kind: "statements", parentId: null });
  const [parentDraft, setParentDraft] = useState(""), [idDraft, setIdDraft] = useState("");
  const [cursor, setCursor] = useState<string | null>(null), [previous, setPrevious] = useState<Array<string | null>>([]);
  const [target, setTarget] = useState<LedgerTarget | null>(null), [inputError, setInputError] = useState(""), [notice, setNotice] = useState("");
  const [denied, setDenied] = useState<string | null>(null);
  const authorization = useRef({ authority: access.authority, permitted: canRead && denied === null }), viewSequence = useRef(0);
  authorization.current = { authority: access.authority, permitted: canRead && denied === null };
  const previousIdentity = useRef({ authority: access.authority, canRead });
  const permitted = canRead && denied === null;
  const isAuthorized = useCallback((authority: string | null) => authorization.current.permitted && authorization.current.authority === authority, []);
  const revoke = useCallback((message: string) => {
    authorization.current.permitted = false; viewSequence.current++; transition.cancel(); setDenied(message); setTarget(null);
    setParentDraft(""); setIdDraft(""); setCursor(null); setPrevious([]); setInputError(""); setNotice("");
    setScope(current => ({ kind: current.kind, parentId: null }));
  }, [transition]);
  useLayoutEffect(() => {
    if (previousIdentity.current.authority === access.authority && previousIdentity.current.canRead === canRead) return;
    previousIdentity.current = { authority: access.authority, canRead };
    viewSequence.current++; transition.cancel(); setDenied(null); setTarget(null); setParentDraft(""); setIdDraft("");
    setScope({ kind: "statements", parentId: null }); setCursor(null); setPrevious([]); setInputError(""); setNotice("");
  }, [access.authority, canRead, transition]);
  const query = useMemo(() => FinanceLedgerListInputSchema.safeParse({ kind: scope.kind, limit: 25,
    ...(scope.parentId ? { parentId: scope.parentId } : {}), ...(cursor ? { cursor } : {}) }), [scope, cursor]);
  const queryKey = JSON.stringify([scope.kind, scope.parentId, cursor]);
  const loadPage = useCallback(async (signal: AbortSignal) => {
    if (!query.success) throw new LedgerReadError(400, "所属记录筛选无效 请核对原登记编号");
    const params = new URLSearchParams({ limit: String(query.data.limit) });
    if (query.data.parentId) params.set("parentId", query.data.parentId); if (query.data.cursor) params.set("cursor", query.data.cursor);
    const page = await readLedger(`${query.data.kind}?${params}`, FinanceLedgerPageViewSchema, signal);
    if (page.kind !== query.data.kind || page.parentId !== (query.data.parentId ?? null) || page.limit !== query.data.limit)
      throw new LedgerReadError(502, "返回列表与本次读取范围不一致 请重新读取");
    return page;
  }, [query]);
  const page = useLedgerRead<FinanceLedgerPageView>({ scope: queryKey, authority: access.authority, enabled: permitted && query.success, load: loadPage, isAuthorized, onDenied: revoke });
  const parentKind = financeLedgerParentKinds[scope.kind];
  const changeView = (update: () => void) => {
    const token = ++viewSequence.current, captured = access.authority;
    transition.change(() => { if (token === viewSequence.current && isAuthorized(captured)) update(); });
  };
  const applyScope = (next: LedgerScope, message = "") => {
    changeView(() => {
      setScope(next); setCursor(null); setPrevious([]); setTarget(null); setInputError(""); setNotice(message);
    });
  };
  const applyFilter = () => {
    const parsed = FinanceLedgerListInputSchema.safeParse({ kind: scope.kind, limit: 25, ...(parentDraft.trim() ? { parentId: parentDraft.trim() } : {}) });
    if (!parsed.success) { setInputError(scope.kind === "procurement_adjustments" ? "读取采购批准来源必须填写真实原应付账单 ID" : "请填写有效的所属记录 ID 或留空读取全部"); return; }
    setParentDraft(parsed.data.parentId ?? ""); applyScope({ kind: parsed.data.kind, parentId: parsed.data.parentId ?? null });
  };
  const open = (next: LedgerTarget) => changeView(() => { setInputError(""); setTarget(next); });
  const readById = () => {
    const parsed = FinanceLedgerDetailInputSchema.safeParse({ kind: scope.kind, id: idDraft.trim(), ...(parentKind && parentDraft.trim() ? { parentId: parentDraft.trim() } : {}) });
    if (!parsed.success) { setInputError(scope.kind === "procurement_adjustments" ? "请填写有效的原应付账单 ID 与真实采购调整 ID" : "请填写有效的真实记录 ID 所属筛选也必须有效"); return; }
    open({ kind: parsed.data.kind, id: parsed.data.id, parentId: parsed.data.parentId ?? null });
  };
  const refresh = () => { viewSequence.current++; transition.cancel(); setPrevious([]); if (cursor !== null) setCursor(null); else void page.reload(); };
  const closeDetail = () => { viewSequence.current++; transition.cancel(); setTarget(null); };
  return <section className="finance-ledger-workspace" id="finance-ledger-workspace" aria-labelledby="finance-ledger-title">
    <header className="finance-ledger-heading"><div><BookOpen size={18} /><h2 id="finance-ledger-title">完整财务台账查询</h2></div><button type="button" disabled={!permitted || page.reading || !query.success} onClick={refresh}><RefreshCw size={14} />刷新首页</button></header>
    <p className="finance-ledger-note"><FileSearch size={16} />只读查询真实登记记录 按登记编号倒序翻页 不是按发生时间排序 也不是财务快照 不发起付款、退款或任何更正</p>
    {!canRead && <p className="finance-ledger-note" role="status">当前没有财务读取权限 私有记录、所属筛选与输入已清除</p>}
    {denied && <div className="finance-ledger-note is-error" role="alert"><CircleAlert size={15} />{denied}<p>私有记录与输入已清除 不会切换到服务身份读取</p>{canRead && <button type="button" onClick={() => { setDenied(null); setNotice(""); }}>重新读取本人权限下的记录</button>}</div>}
    {permitted && <>
      <div className="finance-ledger-toolbar">
        <div className="finance-ledger-control"><label htmlFor="finance-ledger-kind">台账记录类型</label><select id="finance-ledger-kind" value={scope.kind} onChange={event => {
          const kind = FinanceLedgerKindSchema.parse(event.target.value); setParentDraft(""); setIdDraft("");
          applyScope({ kind, parentId: null }, "记录类型已切换 已清空原所属筛选和记录 ID 请按当前类型重新核对");
        }}>{FinanceLedgerKindSchema.options.map(kind => <option key={kind} value={kind}>{kindNames[kind]}</option>)}</select></div>
        <div className="finance-ledger-control"><label htmlFor="finance-ledger-parent">所属记录 ID</label><input id="finance-ledger-parent" className="finance-ledger-id" value={parentDraft} disabled={!parentKind} maxLength={36} autoComplete="off" onChange={event => setParentDraft(event.target.value)} /><small>{parentKind ? `按${parentKind === "suppliers" ? "供应商" : kindNames[parentKind]}的真实登记 ID 筛选${scope.kind === "procurement_adjustments" ? " 此项必填" : " 可留空"}` : "当前类型不支持所属筛选"}</small></div>
        <button type="button" disabled={!parentKind} onClick={applyFilter}><Search size={14} />应用所属筛选</button>
        <div className="finance-ledger-id-search"><div className="finance-ledger-control"><label htmlFor="finance-ledger-record-id">查询记录 ID</label><input id="finance-ledger-record-id" className="finance-ledger-id" value={idDraft} maxLength={36} autoComplete="off" onChange={event => setIdDraft(event.target.value)} /><small>按当前类型与所填所属 ID 直接读取 不受当前页或旧工作区条数限制</small></div><button type="button" className="primary" onClick={readById} disabled={!idDraft.trim()}><FileSearch size={14} />按真实 ID 读取详情</button></div>
      </div>
      {inputError && <p className="finance-ledger-note is-error" role="alert">{inputError}</p>}{notice && <p className="finance-ledger-note" role="status">{notice}</p>}
      {!query.success && !inputError && <p className="finance-ledger-note is-warning" role="status">当前类型须先填写真实原应付账单 ID 并应用筛选 才能读取已批准采购来源</p>}
      {page.error && <div className="finance-ledger-note is-error" role="alert">{page.error}<p>读取失败不代表记录不存在 请重读本页或刷新首页</p><button type="button" disabled={page.reading} onClick={() => void page.reload()}>重新读取本页</button></div>}
      <section className="finance-ledger-panel" aria-labelledby="finance-ledger-list-title" aria-busy={page.reading}>
        <header className="finance-ledger-panel-heading"><h3 id="finance-ledger-list-title">{kindNames[scope.kind]}</h3><span>{page.reading ? "正在读取真实记录" : page.data ? `本页已读取 ${page.data.items.length} 笔${page.data.hasMore ? " 还有后续记录" : ""}` : "等待有效查询"}</span></header>
        <p className="finance-ledger-scope">当前已应用范围 {scope.parentId ? <code className="finance-ledger-id">{scope.parentId}</code> : "全部所属记录"}{page.data && <><br />{page.reading || page.error ? "上次读取记录 当前字段待重读" : "本次读取结果"} · {timeLabel(page.readAt)} · 记录、余额和状态可继续变化</>}</p>
        {page.data && page.data.items.length > 0 && <table className="finance-ledger-table" aria-label="财务台账记录"><thead><tr><th>原始记录</th><th>登记编号与时间</th><th>金额与口径</th><th>状态与所属</th><th>读取操作</th></tr></thead><tbody>{page.data.items.map(row => <tr key={row.id} aria-label={`台账记录 ${row.reference || row.id}`}><td data-label="原始记录"><strong>{row.reference || "未提供业务单号"}</strong><small>{kindNames[row.kind]}</small>{row.supplierId && <small>供应商 <code className="finance-ledger-id">{row.supplierId}</code></small>}</td><td data-label="登记编号与时间"><code className="finance-ledger-id">{row.id}</code><small>{timeLabel(row.recordedAt)}</small></td><td data-label="金额与口径"><SummaryMoney row={row} /></td><td data-label="状态与所属">{row.kind === "profit_runs" ? "核对结果只在详情展示" : row.status === null ? "此摘要未提供状态" : statusLabel(row.status)}{row.parentId && <small>所属登记 <code className="finance-ledger-id">{row.parentId}</code></small>}</td><td data-label="读取操作"><button type="button" onClick={() => open({ kind: row.kind, id: row.id, parentId: row.parentId })}><FileSearch size={14} />查看记录</button></td></tr>)}</tbody></table>}
        {page.data && !page.data.items.length && !page.reading && !page.error && <p className="finance-ledger-empty" role="status">本次查询范围没有可显示记录 不代表其他类型或所属范围没有登记</p>}
        {!page.data && <p className="finance-ledger-empty" role="status">{page.reading ? "正在按本人权限读取台账" : query.success ? "尚未取得本页记录" : "请先完善所属筛选"}</p>}
        <footer className="finance-ledger-pagination"><div className="finance-ledger-page-buttons"><button type="button" disabled={page.reading || !previous.length} onClick={() => { const prior = previous[previous.length - 1] ?? null; changeView(() => { setCursor(prior); setPrevious(stack => stack.slice(0, -1)); }); }}><ArrowLeft size={14} />返回已读前页</button><button type="button" disabled={page.reading || Boolean(page.error) || !page.data?.hasMore} onClick={() => { const next = page.data?.nextCursor; if (next) changeView(() => { setPrevious(stack => [...stack, cursor]); setCursor(next); }); }}>读取下一页<ArrowRight size={14} /></button></div><p>每页最多 25 笔 不用当前页求和或推断全量余额{page.data?.upperBoundId && <><br />本轮登记编号上界 <code className="finance-ledger-id">{page.data.upperBoundId}</code> 后来新登记的记录请刷新首页读取</>}</p></footer>
      </section>
    </>}
    {target && permitted && <LedgerDetailDialog target={target} authority={access.authority} isAuthorized={isAuthorized} onDenied={revoke} onClose={closeDetail} onOpen={open} onChild={child => { setParentDraft(child.parentId); setIdDraft(""); applyScope({ kind: child.kind, parentId: child.parentId }); }} />}
  </section>;
}

function LedgerDetailDialog({ target, authority, isAuthorized, onDenied, onClose, onOpen, onChild }: {
  target: LedgerTarget; authority: string | null; isAuthorized(authority: string | null): boolean;
  onDenied(message: string): void; onClose(): void; onOpen(target: LedgerTarget): void;
  onChild(child: FinanceLedgerDetailView["children"][number]): void;
}) {
  const [closing, setClosing] = useState(false), closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const content = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null), focused = useRef("");
  const input = useMemo(() => FinanceLedgerDetailInputSchema.safeParse({ kind: target.kind, id: target.id, ...(target.parentId ? { parentId: target.parentId } : {}) }), [target]);
  const scope = JSON.stringify(target);
  const load = useCallback(async (signal: AbortSignal) => {
    if (!input.success) throw new LedgerReadError(400, "记录或所属登记编号无效 请重新核对");
    const params = new URLSearchParams(); if (input.data.parentId) params.set("parentId", input.data.parentId);
    const result = await readLedger(`${input.data.kind}/${input.data.id}${params.size ? `?${params}` : ""}`, FinanceLedgerDetailViewSchema, signal);
    if (result.kind !== input.data.kind || result.id !== input.data.id || input.data.parentId && financeLedgerDetailParentId(result) !== input.data.parentId)
      throw new LedgerReadError(502, "返回详情与本次原记录范围不一致 请重新读取");
    return result;
  }, [input]);
  const detail = useLedgerRead({ scope, authority, enabled: input.success, load, isAuthorized, onDenied });
  useEffect(() => () => { if (closeTimer.current !== null) clearTimeout(closeTimer.current); }, []);
  useLayoutEffect(() => {
    if (!detail.data || focused.current === scope) return;
    focused.current = scope;
    const dialog = content.current?.closest("dialog");
    if (dialog instanceof HTMLDialogElement && dialog.open) { dialog.scrollTo({ top: 0, behavior: "instant" }); heading.current?.focus({ preventScroll: true }); }
  }, [detail.data, scope]);
  const leave = (after?: () => void) => {
    if (closing) return;
    detail.cancel(); setClosing(true);
    closeTimer.current = setTimeout(() => { onClose(); if (isAuthorized(authority)) after?.(); }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160);
  };
  const openRelated = (next: LedgerTarget) => { if (!closing) { detail.cancel(); onOpen(next); } };
  return <RecordDialog title="财务台账记录详情" onClose={() => leave()}><div ref={content} className={`finance-ledger-dialog${closing ? " is-closing" : ""}`} aria-busy={detail.reading}>
    <header className="finance-ledger-dialog-heading"><h3 ref={heading} tabIndex={-1}>{kindNames[target.kind]}</h3><button type="button" disabled={closing || detail.reading} onClick={() => void detail.reload()}><RefreshCw size={14} />重新读取本笔详情</button></header>
    <p className="finance-ledger-help">登记编号 <code className="finance-ledger-id">{target.id}</code>{target.parentId && <><br />所属登记 <code className="finance-ledger-id">{target.parentId}</code></>}</p>
    {!input.success && <p className="finance-ledger-note is-error" role="alert">记录编号或所属筛选无效 没有发送详情读取</p>}
    {detail.reading && <p className="finance-ledger-note" role="status">正在读取真实详情 原记录不由当前列表反推</p>}
    {detail.error && <p className="finance-ledger-note is-error" role="alert">{detail.error}{detail.data ? " 下方为上次读取结果 当前字段待重读" : ""}</p>}
    {detail.data && <><p className="finance-ledger-help">{detail.reading || detail.error ? "上次读取" : "本次读取"} {timeLabel(detail.readAt)} · 账面余额不是银行余额 历史事件余额只代表该次执行</p><LedgerRecord detail={detail.data} onOpen={openRelated} blocked={closing} />
      {detail.data.children.length > 0 && <section className="finance-ledger-detail-section" aria-label="关联明细分页"><h4>继续读取关联明细</h4><p className="finance-ledger-help">每个入口独立按所属登记翻页 不把当前页或当前详情当作完整明细</p><div className="finance-ledger-relations">{detail.data.children.map(child => <button type="button" disabled={closing || detail.reading} key={child.kind} onClick={() => leave(() => onChild(child))}><Link2 size={14} />读取{kindNames[child.kind]}</button>)}</div></section>}
    </>}
    <footer><button type="button" disabled={closing} onClick={() => leave()}>返回财务台账</button></footer>
  </div></RecordDialog>;
}

function useLedgerRead<T>({ scope, authority, enabled, load, isAuthorized, onDenied }: {
  scope: string; authority: string | null; enabled: boolean; load(signal: AbortSignal): Promise<T>;
  isAuthorized(authority: string | null): boolean; onDenied(message: string): void;
}) {
  const [snapshot, setSnapshot] = useState<{ scope: string; authority: string | null; value: T; readAt: string } | null>(null);
  const [reading, setReading] = useState(false), [error, setError] = useState("");
  const live = useRef(true), sequence = useRef(0), abort = useRef<AbortController | null>(null), latest = useRef({ scope, authority, enabled });
  const transition = useOwnedViewTransition(); latest.current = { scope, authority, enabled };
  const cancel = useCallback(() => { sequence.current++; abort.current?.abort(); transition.cancel(); if (live.current) setReading(false); }, [transition]);
  useLayoutEffect(() => { cancel(); setSnapshot(null); setError(""); }, [scope, authority, enabled, cancel]);
  const reload = useCallback(async () => {
    if (!enabled || !isAuthorized(authority)) return;
    const token = ++sequence.current; abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    const valid = () => live.current && sequence.current === token && latest.current.enabled && latest.current.scope === scope && latest.current.authority === authority && isAuthorized(authority);
    setReading(true); setError("");
    try {
      const value = await load(controller.signal); if (!valid()) return;
      const readAt = new Date().toISOString();
      transition.change(() => { if (valid()) { setSnapshot({ scope, authority, value, readAt }); setError(""); } });
    } catch (failure) {
      if (controller.signal.aborted || !valid()) return;
      if (failure instanceof LedgerReadError && (failure.status === 401 || failure.status === 403)) { setSnapshot(null); onDenied(failure.message); }
      else setError(failure instanceof LedgerReadError ? failure.message : "暂时无法读取真实财务记录 请稍后重读");
    } finally { if (valid()) setReading(false); }
  }, [scope, authority, enabled, load, isAuthorized, onDenied, transition]);
  useEffect(() => { live.current = true; return () => { live.current = false; cancel(); }; }, [cancel]);
  useEffect(() => { if (enabled) void reload(); return cancel; }, [enabled, reload, cancel]);
  const current = enabled && snapshot?.scope === scope && snapshot.authority === authority ? snapshot : null;
  return { data: current?.value ?? null, readAt: current?.readAt ?? null, reading, error, reload, cancel };
}

class LedgerReadError extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function readLedger<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api/finance/ledger/${path}`, { credentials: "same-origin", cache: "no-store", redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) }); }
  catch { throw new LedgerReadError(0, "读取连接中断 原记录未被修改 请重新读取"); }
  if (!response.ok) {
    const messages: Record<number, string> = { 400: "登记编号、所属筛选或游标无效 请核对输入或刷新首页", 401: "本人登录已失效 请重新核对 ERP 会话", 403: "当前本人财务读取权限不足", 404: "此记录不存在或当前不可访问 不以列表缺失判断原因", 429: "读取过于频繁 请稍后重读" };
    throw new LedgerReadError(response.status, messages[response.status] ?? "财务详情暂不可读取 请稍后重试");
  }
  try { const parsed = schema.safeParse(await response.json()); if (parsed.success) return parsed.data; } catch { /* Only validated records reach the view. */ }
  throw new LedgerReadError(502, "返回记录格式暂时无法核对 未用缺失值代替实际事实");
}

export function SummaryMoney({ row }: { row: FinanceLedgerSummary }) {
  if (row.kind === "profit_runs") return <span>利润摘要不提供核验金额 请读取原计算详情</span>;
  return <>{row.amountMinor !== null && row.currency !== null ? <><Money value={row.amountMinor} currency={row.currency} /><small>{row.kind === "bills" || row.kind === "payments" ? "原登记金额" : "该笔原记录金额"}</small></> : <span>{row.kind === "procurement_adjustments" ? "来源金额需在详情核对" : "此摘要不提供单笔金额"}</span>}{row.netAmountMinor !== null && row.currency !== null && <small>读取时净额 <Money value={row.netAmountMinor} currency={row.currency} /></small>}</>;
}

export function LedgerRecord({ detail, onOpen, blocked }: { detail: FinanceLedgerDetailView; onOpen(target: LedgerTarget): void; blocked: boolean }) {
  const link = (kind: FinanceLedgerKind, id: string, label: string, parentId: string | null = null) => <RelatedRecord kind={kind} id={id} label={label} parentId={parentId} onOpen={onOpen} blocked={blocked} />;
  switch (detail.kind) {
    case "statements": {
      const record = detail.record, source = record.sourceIdentity;
      return <><dl><Pair label="外部单据编号">{record.externalStatementId}</Pair><Pair label="来源平台">{providerName(record.provider)}</Pair><Pair label="单据分类">{statementName(record.statementKind)}</Pair><Pair label="来源币种">{record.sourceCurrency}</Pair><Pair label="店铺账号标识"><Identifier value={record.accountId} /></Pair><Pair label="采集观察时间"><Time value={record.observedAt} /></Pair><Pair label="期间起点"><Time value={record.periodStart} /></Pair><Pair label="期间终点"><Time value={record.periodEnd} /></Pair><Pair label="登记时间"><Time value={record.recordedAt} /></Pair><Pair label="原单据校验值"><code>{record.checksum}</code></Pair></dl><DetailSection title="真实来源作用域">{!source ? <p className="finance-ledger-note is-warning">历史来源身份依据未知 不冒称已完成条目去重或外部验真</p> : <dl><Pair label="来源身份版本">{source.schemaVersion}</Pair><Pair label="真实来源范围">{source.kind === "marketplace_account" ? <>店铺账号 <Identifier value={record.accountId} /></> : source.kind === "supplier" ? <>供应商 <Identifier value={source.supplierId} /></> : <>命名来源 {source.sourceName}</>}</Pair></dl>}<p className="finance-ledger-help">原财务事实行在下方关联入口逐页读取 不用单据头或当前页推断全部行数与总金额</p></DetailSection></>;
    }
    case "facts": {
      const record = detail.record;
      return <><dl><Pair label="原单据">{link("statements", record.statementId, "读取原单据")}</Pair><Pair label="原事实行标识">{record.lineKey}</Pair><Pair label="来源条目标识">{record.sourceEntryId ? <code>{record.sourceEntryId}</code> : <Unknown>历史来源条目标识未知 不冒称已去重</Unknown>}</Pair><Pair label="事实类型">{factName(record.factType)}</Pair><Pair label="记账方向">{record.direction === "credit" ? "贷方 credit" : "借方 debit"}</Pair><Pair label="原事实金额"><Money value={record.amountMinor} currency={record.currency} /></Pair><Pair label="实际发生时间"><Time value={record.occurredAt} /></Pair><Pair label="登记时间"><Time value={record.recordedAt} /></Pair><Pair label="外部业务引用">{record.externalReference ?? "未提供外部引用"}</Pair><Pair label="纠错语义">{statusLabel(record.correctionKind)}</Pair>{record.correctsFactId && <Pair label="被更正的原事实">{link("facts", record.correctsFactId, "读取被更正事实")}</Pair>}<Pair label="供应商标识"><Identifier value={record.supplierId} /></Pair><Pair label="店铺账号标识"><Identifier value={record.accountId} /></Pair><Pair label="订单标识"><Identifier value={record.orderId} /></Pair><Pair label="订单行标识"><Identifier value={record.orderLineId} /></Pair><Pair label="SKU 标识"><Identifier value={record.skuId} /></Pair><Pair label="刊登标识"><Identifier value={record.listingId} /></Pair></dl><p className="finance-ledger-help">冲销与替代保留原事实 事实方向不代表本页发起资金交易</p></>;
    }
    case "fx_rates": {
      const record = detail.record;
      return <><dl><Pair label="汇率来源">{record.source}</Pair><Pair label="币种对">{record.baseCurrency} → {record.quoteCurrency}</Pair><Pair label="精确汇率分数"><code>{record.rateNumerator} / {record.rateDenominator}</code></Pair><Pair label="汇率单位">{record.monetaryBasis ? `1 ${record.baseCurrency} 主货币单位 对应该分数的 ${record.quoteCurrency} 主货币单位` : <Unknown>历史汇率单位依据待核对 不推测主单位或最小单位</Unknown>}</Pair><Pair label="生效时间"><Time value={record.effectiveAt} /></Pair><Pair label="检索时间"><Time value={record.retrievedAt} /></Pair><Pair label="登记时间"><Time value={record.recordedAt} /></Pair><Pair label="原汇率校验值"><code>{record.checksum}</code></Pair>{record.monetaryBasis && <><Pair label="币种精度快照">{record.monetaryBasis.currencyTableVersion}</Pair><Pair label="主币 / 报价币最小单位精度">{record.monetaryBasis.baseMinorDigits} / {record.monetaryBasis.quoteMinorDigits}</Pair></>}</dl><p className="finance-ledger-help">保留原分子与分母 本页不以浮点小数近似重算历史汇率</p></>;
    }
    case "metrics": {
      const record = detail.record;
      return <><dl><Pair label="利润指标名称">{record.name}</Pair><Pair label="当前版本号">{record.currentVersion}</Pair><Pair label="指标状态">{statusLabel(record.status)}</Pair><Pair label="创建时间"><Time value={record.createdAt} /></Pair><Pair label="更新时间"><Time value={record.updatedAt} /></Pair></dl><DetailSection title="读取时的指标版本"><MetricVersion record={record.version} onOpen={onOpen} blocked={blocked} /></DetailSection></>;
    }
    case "metric_versions": return <MetricVersion record={detail.record} onOpen={onOpen} blocked={blocked} />;
    case "profit_runs": return <ProfitRun record={detail.record} onOpen={onOpen} blocked={blocked} />;
    case "contributions": {
      const record = detail.record;
      return <><dl><Pair label="原利润计算">{link("profit_runs", record.runId, "读取原计算核对结果")}</Pair><Pair label="来源事实">{link("facts", record.factId, "读取来源事实")}</Pair><Pair label="原折算汇率">{record.fxRateId ? link("fx_rates", record.fxRateId, "读取原历史汇率") : "没有关联汇率记录"}</Pair><Pair label="原贡献分类">{record.bucket === "revenue" ? "收入" : record.bucket === "cost" ? "成本" : "未分类"}</Pair><Pair label="原来源金额"><Money value={record.sourceAmountMinor} currency={record.sourceCurrency} /></Pair><Pair label="原存储折算金额">{record.reportingAmountMinor === null ? <Unknown>原折算金额待核对</Unknown> : <Money value={record.reportingAmountMinor} currency={record.reportingCurrency} />}</Pair><Pair label="事实类型">{factName(record.factType)}</Pair><Pair label="贡献作用方向">{record.effectSign === 1 ? "+1" : "-1"} 原方向保持</Pair><Pair label="实际发生时间"><Time value={record.occurredAt} /></Pair><Pair label="订单标识"><Identifier value={record.orderId} /></Pair><Pair label="订单行标识"><Identifier value={record.orderLineId} /></Pair><Pair label="SKU 标识"><Identifier value={record.skuId} /></Pair><Pair label="刊登标识"><Identifier value={record.listingId} /></Pair><Pair label="店铺账号标识"><Identifier value={record.accountId} /></Pair><Pair label="供应商标识"><Identifier value={record.supplierId} /></Pair></dl><p className="finance-ledger-note">原贡献行与原折算金额保持 本页不重新计算 单行或当前页贡献不证明整个利润结果完整</p></>;
    }
    case "bills": {
      const record = detail.record;
      return <><dl><Pair label="原账单编号">{record.externalBillId}</Pair><Pair label="账单分类">{record.kind === "procurement_invoice" ? "采购实际发票" : record.kind === "factory_invoice" ? "工厂账单" : "供应商账单"}</Pair><Pair label="供应商标识"><Identifier value={record.supplierId} /></Pair><Pair label="原账单开具时间"><Time value={record.issuedAt} /></Pair><Pair label="到期时间">{record.dueAt ? <Time value={record.dueAt} /> : "未登记到期时间"}</Pair><Pair label="登记时间"><Time value={record.recordedAt} /></Pair><Pair label="原采购实际发票"><Identifier value={record.procurementInvoiceId} /></Pair><Pair label="原发票提交凭据"><Identifier value={record.procurementProofId} /></Pair><Pair label="核销状态">{statusLabel(record.status)}</Pair><Pair label="采购来源状态">{statusLabel(record.sourceStatus)}</Pair></dl><Balance record={record} currency={record.currency} historical={false} />{record.sourceStatus !== "current" && <p className="finance-ledger-note is-warning">来源未核对有效 原应付金额和净额仍保留 不将未知来源当成零余额或已完成同步</p>}</>;
    }
    case "payments": {
      const record = detail.record;
      return <><dl><Pair label="原付款编号">{record.externalPaymentId}</Pair><Pair label="供应商标识"><Identifier value={record.supplierId} /></Pair><Pair label="证据流水标识"><code>{record.evidenceReference}</code></Pair><Pair label="证据状态">人工登记 未经银行认证</Pair><Pair label="付款方式">{methodName(record.method)}</Pair><Pair label="原实际付款时间"><Time value={record.paidAt} /></Pair><Pair label="登记时间"><Time value={record.recordedAt} /></Pair><Pair label="核销状态">{statusLabel(record.status)}</Pair></dl><Balance record={record} currency={record.currency} historical={false} /><p className="finance-ledger-help">付款和退款为登记事实 本页不执行银行转账或退款</p></>;
    }
    case "allocation_batches": {
      const record = detail.record;
      return <><dl><Pair label="原付款记录">{link("payments", record.paymentId, "读取原付款")}</Pair><Pair label="本批登记时间"><Time value={record.recordedAt} /></Pair><Pair label="该批核销条目数">{record.allocations.length} 笔 仅代表这一登记批次</Pair></dl><DetailSection title="本批实际核销条目"><ol>{record.allocations.map(row => <li key={row.id}>{link("allocations", row.id, "读取本笔核销", row.billId)}<p><Money value={row.amountMinor} currency={row.currency} /> · {row.released ? "读取时已撤销" : "读取时有效"}</p></li>)}</ol></DetailSection></>;
    }
    case "allocations": {
      const record = detail.record;
      return <><dl><Pair label="原核销批次">{link("allocation_batches", record.batchId, "读取原批次", record.paymentId)}</Pair><Pair label="原应付账单">{link("bills", record.billId, "读取原账单", record.supplierId)}</Pair><Pair label="原付款记录">{link("payments", record.paymentId, "读取原付款", record.supplierId)}</Pair><Pair label="原核销金额"><Money value={record.amountMinor} currency={record.currency} /></Pair><Pair label="当前撤销状态">{record.released ? "已撤销 该笔不再占用余额" : "本次读取仍为有效核销"}</Pair><Pair label="供应商标识"><Identifier value={record.supplierId} /></Pair><Pair label="登记时间"><Time value={record.recordedAt} /></Pair></dl><p className="finance-ledger-help">原核销与撤销凭据均保留 不以某一页撤销列表缺失推断有效状态</p></>;
    }
    case "releases": {
      const record = detail.record;
      return <><dl><Pair label="被撤销核销">{link("allocations", record.allocationId, "读取原核销")}</Pair><Pair label="原撤销原因代码">{record.reasonCode}</Pair><Pair label="撤销登记时间"><Time value={record.recordedAt} /></Pair></dl><p className="finance-ledger-note">这是原核销占用的撤销凭据 不代表银行退款或资金转移</p></>;
    }
    case "bill_adjustments": {
      const record = detail.record;
      return <><dl><Pair label="原应付账单">{link("bills", record.billId, "读取当前账单余额", record.supplierId)}</Pair><Pair label="更正语义">{statusLabel(record.kind)}</Pair><Pair label="本笔更正金额"><Money value={record.amountMinor} currency={record.currency} /></Pair><Pair label="外部更正单据">{record.externalDocumentId ?? "作废凭据未附外部更正单号"}</Pair><Pair label="供应商标识"><Identifier value={record.supplierId} /></Pair><Pair label="采购调整来源">{record.procurementAdjustmentId ? link("procurement_adjustments", record.procurementAdjustmentId, "读取真实批准来源", record.billId) : "未关联采购批准记录"}</Pair><Pair label="实际批准凭据"><Identifier value={record.procurementReviewId} /></Pair><EventEvidence record={record} /></dl><Balance record={record.balanceAfter} currency={record.currency} historical /><p className="finance-ledger-help">外部单据引用由登记人录入 未经外部验真 当前账单余额请单独读取原应付记录</p></>;
    }
    case "payment_adjustments": {
      const record = detail.record;
      return <><dl><Pair label="原付款记录">{link("payments", record.paymentId, "读取当前付款余额", record.supplierId)}</Pair><Pair label="更正语义">{statusLabel(record.kind)}</Pair><Pair label="本笔登记金额"><Money value={record.amountMinor} currency={record.currency} /></Pair><Pair label="外部退款单据">{record.externalDocumentId ?? "作废凭据未附外部退款单号"}</Pair><Pair label="供应商标识"><Identifier value={record.supplierId} /></Pair><Pair label="证据状态">人工登记 未经银行认证</Pair><EventEvidence record={record} /></dl><Balance record={record.balanceAfter} currency={record.currency} historical /><p className="finance-ledger-help">此凭据不代表本页已执行银行退款 当前账面余额请重新读取原付款记录</p></>;
    }
    case "procurement_adjustments": {
      const record = detail.record;
      return <><dl><Pair label="原应付账单">{link("bills", record.billId, "读取原应付依据")}</Pair><Pair label="原应付币种">{detail.billCurrency}</Pair><Pair label="采购调整凭据"><code>{record.procurementAdjustmentId}</code></Pair><Pair label="实际批准凭据"><code>{record.procurementReviewId}</code></Pair></dl>{"code" in record ? <p className="finance-ledger-note is-warning" role="status">来源格式无法精确同步 请核对原采购凭据 原金额、证据文本或时间未被清洗替换 本页不捏造可同步金额</p> : <><dl><Pair label="原批准语义">{statusLabel(record.kind)}</Pair><Pair label="真实批准金额"><Money value={record.amountMinor} currency={detail.billCurrency} />{record.amountMinor === 0 && <small>零金额来源确认或数量调整 不新增应付金额</small>}</Pair><Pair label="原供应商单据">{record.externalDocumentId}</Pair><Pair label="原证据标识"><code>{record.evidenceReference}</code></Pair><Pair label="实际发生时间"><Time value={record.occurredAt} /></Pair><Pair label="应付同步状态">{record.mappedEventId ? link("bill_adjustments", record.mappedEventId, "读取实际同步凭据", record.billId) : "本次读取尚未关联应付同步事件"}</Pair></dl><p className="finance-ledger-help">这是原采购批准来源的投影 原采购凭据不修改 单笔未关联不代表整个来源范围已核对完毕</p></>}</>;
    }
  }
}

function ProfitRun({ record, onOpen, blocked }: { record: Extract<FinanceLedgerDetailView, { kind: "profit_runs" }>["record"]; onOpen(target: LedgerTarget): void; blocked: boolean }) {
  const complete = record.status === "complete";
  return <><DetailSection title="该次计算的受权核对结果"><p className={complete ? "finance-ledger-note" : "finance-ledger-note is-warning"}>{complete ? "原完整计算服务已核对该次计算依据" : "该次计算仍待完整核对 不作为完整利润"}</p><p className="finance-ledger-help">核对来自原完整贡献读取 后续仅投影单据头 本页不拼接当前分页贡献重新验证或计算总额</p><dl><Pair label="原返回状态">{statusLabel(record.status)}</Pair><Pair label="报告币种">{record.reportingCurrency}</Pair><Pair label="收入">{complete && record.revenueMinor !== null ? <Money value={record.revenueMinor} currency={record.reportingCurrency} /> : <Unknown>待完整核对</Unknown>}</Pair><Pair label="成本">{complete && record.costMinor !== null ? <Money value={record.costMinor} currency={record.reportingCurrency} /> : <Unknown>待完整核对</Unknown>}</Pair><Pair label="利润">{complete && record.profitMinor !== null ? <Money value={record.profitMinor} currency={record.reportingCurrency} /> : <Unknown>待完整核对</Unknown>}</Pair><Pair label="利润率">{complete && record.marginBps !== null ? percentLabel(record.marginBps) : "待核对"}</Pair><Pair label="原指标"><RelatedRecord kind="metrics" id={record.metricId} label="读取指标" onOpen={onOpen} blocked={blocked} /></Pair><Pair label="固定指标版本"><RelatedRecord kind="metric_versions" id={record.metricVersionId} parentId={record.metricId} label={`读取第 ${record.metricVersion} 版依据`} onOpen={onOpen} blocked={blocked} /></Pair><Pair label="计算时间"><Time value={record.calculatedAt} /></Pair><Pair label="原输入校验值"><code>{record.inputChecksum}</code></Pair></dl></DetailSection>
    <DetailSection title="固定金额与来源依据"><dl><Pair label="来源身份核对版本">{record.sourceIdentityVersion ?? "历史来源身份核对版本未知"}</Pair><Pair label="金额算法">{record.monetaryBasis ? "固定币种精度 按每笔事实折算 半值远离零舍入" : <Unknown>历史金额算法依据待核对</Unknown>}</Pair>{record.monetaryBasis && <><Pair label="币种精度快照">{record.monetaryBasis.currencyTableVersion}</Pair><Pair label="该次计算固定币种精度">{record.monetaryBasis.currencies.map(item => <span className="finance-ledger-block" key={item.currency}>{item.currency} · {item.minorDigits === null ? "精度待核对" : `${item.minorDigits} 位最小单位精度`}</span>)}</Pair></>}</dl><RecordIdList title="固定原单据" values={record.statementIds} kind="statements" onOpen={onOpen} blocked={blocked} /><RecordIdList title="固定历史汇率" values={record.fxRateIds} kind="fx_rates" onOpen={onOpen} blocked={blocked} /></DetailSection>
    <DetailSection title="原计算诊断"><dl><Pair label="缺少事实类型">{record.diagnostics.missingFactTypes.length ? record.diagnostics.missingFactTypes.map(factName).join(" · ") : "原诊断未报告此类缺口"}</Pair><Pair label="缺少汇率对">{record.diagnostics.missingFxPairs.join(" · ") || "原诊断未报告此类缺口"}</Pair><Pair label="未分类事实">{record.diagnostics.unclassifiedFactTypes.length ? record.diagnostics.unclassifiedFactTypes.map(factName).join(" · ") : "原诊断未报告此类缺口"}</Pair><Pair label="未知币种">{record.diagnostics.monetary ? record.diagnostics.monetary.unknownCurrencies.join(" · ") || "原诊断未报告未知币种" : "历史币种精度诊断未知"}</Pair><Pair label="原覆盖口径">{record.diagnostics.coverage ? `${dimensionName(record.diagnostics.coverage.dimension)} · 该次检查 ${record.diagnostics.coverage.checkedEntityCount} 个归属实体` : "历史覆盖依据未知"}</Pair></dl>
      {record.diagnostics.sourceIdentity ? <RecordIdList title="来源身份未识别事实" values={record.diagnostics.sourceIdentity.unidentifiedFactIds} kind="facts" onOpen={onOpen} blocked={blocked} /> : <p className="finance-ledger-help">历史来源身份诊断未知 不当作零缺口</p>}
      {record.diagnostics.monetary && <RecordIdList title="计价单位待核对汇率" values={record.diagnostics.monetary.ambiguousFxRateIds} kind="fx_rates" onOpen={onOpen} blocked={blocked} />}
      {record.diagnostics.coverage && <><RecordIdList title="缺少归属事实" values={record.diagnostics.coverage.unattributedFactIds} kind="facts" onOpen={onOpen} blocked={blocked} /><details><summary>查看原归属缺口 {record.diagnostics.coverage.missingByEntity.length} 项</summary><ol>{record.diagnostics.coverage.missingByEntity.map(item => <li key={item.key}><code>{item.key}</code> · {item.missingFactTypes.map(factName).join(" · ")}</li>)}</ol></details></>}
    </DetailSection>
    {record.breakdowns.length > 0 && <DetailSection title="原计算分组记录">{complete ? <details><summary>查看该次固定分组 {record.breakdowns.length} 项</summary><ol>{record.breakdowns.map(item => <li key={`${item.dimension}:${item.key}`}><strong>{dimensionName(item.dimension)} · {item.key}</strong><p>收入 <Money value={item.revenueMinor} currency={record.reportingCurrency} /> · 成本 <Money value={item.costMinor} currency={record.reportingCurrency} /> · 利润 <Money value={item.profitMinor} currency={record.reportingCurrency} /></p><span>原事实数 {item.factCount}</span></li>)}</ol></details> : <p className="finance-ledger-help">原分组仍保留 完整计算未核对前不将分组金额作为完整利润展示</p>}</DetailSection>}
  </>;
}

function MetricVersion({ record, onOpen, blocked }: { record: Extract<FinanceLedgerDetailView, { kind: "metric_versions" }>["record"]; onOpen(target: LedgerTarget): void; blocked: boolean }) {
  return <dl><Pair label="版本登记编号"><code>{record.id}</code></Pair><Pair label="原指标编号"><RelatedRecord kind="metrics" id={record.metricId} label="读取原指标" onOpen={onOpen} blocked={blocked} /></Pair><Pair label="原版本号">{record.versionNumber}</Pair><Pair label="报告币种">{record.reportingCurrency}</Pair><Pair label="收入事实分类">{record.revenueFactTypes.map(factName).join(" · ")}</Pair><Pair label="成本事实分类">{record.costFactTypes.map(factName).join(" · ")}</Pair><Pair label="必要事实分类">{record.requiredFactTypes.map(factName).join(" · ") || "此版本未列必要分类"}</Pair><Pair label="版本原因代码">{record.reasonCode}</Pair><Pair label="创建时间"><Time value={record.createdAt} /></Pair><Pair label="原版本校验值"><code>{record.checksum}</code></Pair></dl>;
}
function Balance({ record, currency, historical }: { record: FinanceBillBalance | FinancePaymentBalance; currency: string; historical: boolean }) {
  const bill = "outstandingMinor" in record;
  return <DetailSection title={historical ? "该次执行时余额" : "本次读取的账面余额"}><p className="finance-ledger-help">{historical ? "原事件保存的执行时快照 后续核销或更正可能已变化 不是当前余额" : "服务端按完整有效核销和更正计算 不是按本页求和 不是银行余额"}</p><dl><Pair label={bill ? "原账单金额" : "原登记付款金额"}><Money value={record.amountMinor} currency={currency} /></Pair>{bill ? <><Pair label="累计贷项"><Money value={record.creditMinor} currency={currency} /></Pair><Pair label="累计补差"><Money value={record.debitMinor} currency={currency} /></Pair></> : <Pair label="累计退款"><Money value={record.refundedMinor} currency={currency} /></Pair>}<Pair label="累计作废额"><Money value={record.voidedMinor} currency={currency} /></Pair><Pair label="调整后净额"><Money value={record.netAmountMinor} currency={currency} /></Pair><Pair label="已核销"><Money value={record.allocatedMinor} currency={currency} /></Pair><Pair label={bill ? "净额待核销" : "未分配余额"}><Money value={bill ? record.outstandingMinor : record.unallocatedMinor} currency={currency} /></Pair><Pair label="记录生命周期">{statusLabel(record.lifecycle)}</Pair></dl></DetailSection>;
}
function EventEvidence({ record }: { record: { evidenceReference: string; occurredAt: string; recordedAt: string; reasonCode: string } }) {
  return <><Pair label="原证据流水标识"><code>{record.evidenceReference}</code></Pair><Pair label="实际发生时间"><Time value={record.occurredAt} /></Pair><Pair label="登记时间"><Time value={record.recordedAt} /></Pair><Pair label="原原因代码">{record.reasonCode}</Pair></>;
}
function RecordIdList({ title, values, kind, onOpen, blocked }: { title: string; values: string[]; kind: FinanceLedgerKind; onOpen(target: LedgerTarget): void; blocked: boolean }) {
  return <details><summary>{title} {values.length} 笔</summary>{values.length ? <ol>{values.map(id => <li key={id}><RelatedRecord kind={kind} id={id} label="按真实 ID 读取" onOpen={onOpen} blocked={blocked} /></li>)}</ol> : <p className="finance-ledger-help">该原记录没有列出此类标识 不推断其他记录或当前全量状态</p>}</details>;
}
function RelatedRecord({ kind, id, label, parentId = null, onOpen, blocked }: { kind: FinanceLedgerKind; id: string; label: string; parentId?: string | null; onOpen(target: LedgerTarget): void; blocked: boolean }) {
  return <span className="finance-ledger-record-link"><button type="button" disabled={blocked} onClick={() => onOpen({ kind, id, parentId })}><Link2 size={13} />{label}</button><code className="finance-ledger-id">{id}</code></span>;
}
function DetailSection({ title, children }: { title: string; children: ReactNode }) { return <section className="finance-ledger-detail-section" aria-label={title}><h4>{title}</h4>{children}</section>; }
function Pair({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
function Identifier({ value }: { value: string | null | undefined }) { return value ? <code className="finance-ledger-id">{value}</code> : <span>未提供此关联标识</span>; }
function Unknown({ children }: { children: ReactNode }) { return <span className="finance-ledger-unknown">{children}</span>; }
function Money({ value, currency }: { value: number; currency: string }) { return <span className="finance-ledger-money">{formatFinanceMinorAmount(value, currency)}</span>; }
function Time({ value }: { value: string }) { return <span className="finance-ledger-block"><time dateTime={value}>{timeLabel(value)}</time><small className="finance-ledger-block"><code>{value}</code></small></span>; }
function timeLabel(value: string | null) { return value ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)) : "尚未读取"; }
function statusLabel(value: string) { return statusNames[value] ?? `原状态 ${value}`; }
function percentLabel(value: number) { const amount = BigInt(value), magnitude = amount < 0n ? -amount : amount; return `${amount < 0n ? "-" : ""}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, "0")}%`; }
function methodName(value: string) { return ({ bank_transfer: "银行转账", card: "卡付款", cash: "现金", other: "其他" } as Record<string, string>)[value] ?? value; }
function providerName(value: string) { return ({ amazon: "Amazon", etsy: "Etsy", supplier: "供应商", advertising: "广告来源", carrier: "承运商", tax_authority: "税务机构", manual: "人工来源" } as Record<string, string>)[value] ?? value; }
function statementName(value: string) { return ({ marketplace_settlement: "平台结算单", advertising_invoice: "广告发票", fulfillment_invoice: "履约账单", supplier_invoice: "供应商发票", carrier_invoice: "承运商账单", tax_statement: "税务单据", operational_cost: "运营费用", manual_adjustment: "人工调整" } as Record<string, string>)[value] ?? value; }
function factName(value: string) { return ({ sale_revenue: "销售收入", shipping_revenue: "运费收入", marketplace_commission: "平台佣金", advertising_spend: "广告费用", fulfillment_fee: "履约费用", storage_fee: "仓储费用", refund: "退款事实", chargeback: "拒付事实", procurement_cost: "采购成本", production_cost: "生产成本", freight_cost: "运输成本", carrier_cost: "承运费用", tax: "税费", other_fee: "其他费用" } as Record<string, string>)[value] ?? value; }
function dimensionName(value: string) { return ({ aggregate: "账单汇总", order: "订单", order_line: "订单行", sku: "SKU", listing: "刊登", store: "店铺", platform: "平台", supplier: "供应商", period: "期间" } as Record<string, string>)[value] ?? value; }
