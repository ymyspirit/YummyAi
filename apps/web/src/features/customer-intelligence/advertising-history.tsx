"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, FileSearch, History, Link2, RefreshCw, X } from "lucide-react";
import type { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import {
  AdHistoryKindSchema, AdHistoryQuerySchema, AdHistoryRecordQuerySchema,
  AdHistoryPageSchema, AdHistoryRecordResultSchema,
  type AdHistoryKind, type AdHistoryPage, type AdHistoryRecordResult,
} from "@yummyai/contracts/advertising/history";
import type { AdAnalysisRun, AdImportView, AdExportView } from "@yummyai/contracts/advertising";
import { useErpAccess } from "../identity/erp-access";
import { useOwnedViewTransition } from "../navigation/use-owned-view-transition";
import { AdActionForm, AdArchiveForm, AdGoalMoneySummary, AdMeasurementSummary, AdMonetaryBasisNote } from "./advertising-forms";
import { adCheckAuthority, adDenied, adDownload, adError, adLabels, adMoney, adRequest, adRecheckSession, adStatusLabels, AdRequestError, type AdIdentity } from "./advertising-client";

export const adHistoryLabels: Record<AdHistoryKind, string> = {
  imports: "报表导入", goals: "目标版本", observations: "观察证据", analyses: "封存分析",
  actions: "调整动作", exports: "审阅导出包", action_events: "动作处理事件", import_events: "来源归档事件",
};
type Caps = { canRead: boolean; canWrite: boolean; canReview: boolean };
export type AdHistoryTarget = { kind: AdHistoryKind; id: string; parentId: string | null };
const writeKinds = new Set<AdHistoryKind>(["imports", "observations", "import_events"]);
export const adHistoryPermitted = (kind: AdHistoryKind, caps: Caps) => caps.canRead || (writeKinds.has(kind) ? caps.canWrite : caps.canReview);
const accessLabel = (mode: AdHistoryPage["accessMode"]) => mode === "read" ? "当前读取权限下的历史" : mode === "own_write" ? "仅本人录入的记录" : "仅本人审核操作产生的记录";
const id = (value: string | undefined) => { const parsed = EntityIdSchema.safeParse(value); return parsed.success ? parsed.data.toLowerCase() : null; };
export function parseAdHistoryLocation(value: string, runId = ""): AdHistoryTarget | null {
  const parts = value.split(":");
  if (parts[0] === "history") {
    const kind = AdHistoryKindSchema.safeParse(parts[1]);
    if (!kind.success) return null;
    const event = kind.data.endsWith("_events"), recordId = id(parts[event ? 3 : 2]), parentId = event ? id(parts[2]) : null;
    if (parts.length !== (event ? 4 : 3) || !recordId || event && !parentId) return null;
    return { kind: kind.data, id: recordId, parentId };
  }
  if (["action", "import"].includes(parts[0] ?? "") && parts.length === 2 && id(parts[1])) return { kind: parts[0] === "action" ? "actions" : "imports", id: id(parts[1])!, parentId: null };
  const originalRun = id(runId);
  return originalRun ? { kind: "analyses", id: originalRun, parentId: null } : null;
}
export const adHistoryLocation = (target: AdHistoryTarget) => `history:${target.kind}:${target.parentId ? `${target.parentId}:` : ""}${target.id}`;

function useHistoryRead<T>({ path, stamp, schema, identity, validate, onDenied }: {
  path: string | null; stamp: string; schema: z.ZodType<T>; identity: AdIdentity;
  validate(value: T): void; onDenied(message: string): void;
}) {
  const [snapshot, setSnapshot] = useState<{ stamp: string; value: T; readAt: string } | null>(null);
  const [reading, setReading] = useState(false), [error, setError] = useState("");
  const live = useRef(true), sequence = useRef(0), abort = useRef<AbortController | null>(null);
  const lastSuccessful = useRef<{ path: string; stamp: string } | null>(null);
  const current = useRef({ path, stamp }); current.current = { path, stamp };
  const cancel = useCallback(() => { sequence.current++; abort.current?.abort(); }, []);
  useLayoutEffect(() => { cancel(); lastSuccessful.current = null; setSnapshot(null); setError(""); setReading(false); }, [stamp, path, cancel]);
  const reload = useCallback(async () => {
    if (!path) return null;
    const token = ++sequence.current; abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    const valid = () => live.current && !controller.signal.aborted && token === sequence.current && current.current.path === path && current.current.stamp === stamp;
    setReading(true); setError("");
    try {
      const raw = await adRequest(path, undefined, controller.signal);
      if (!valid()) return null;
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new AdRequestError(502, "历史返回格式无法核对 未以空白或零代替原事实");
      const value = parsed.data;
      adCheckAuthority(value as T & { contextAuthority: string }, identity); validate(value);
      if (!valid()) return null;
      lastSuccessful.current = { path, stamp };
      setSnapshot({ stamp, value, readAt: new Date().toISOString() });
      return value;
    } catch (failure) {
      if (!valid()) return null;
      const knownRecordHidden = failure instanceof AdRequestError && failure.status === 404 && lastSuccessful.current?.path === path && lastSuccessful.current.stamp === stamp;
      if (adDenied(failure) || knownRecordHidden) {
        lastSuccessful.current = null; setSnapshot(null);
        if (knownRecordHidden) adRecheckSession();
        onDenied(knownRecordHidden ? "此前可读的记录当前已不可访问 私有内容已清除 请重新核对本人权限" : adError(failure));
      }
      else setError(adError(failure));
      return null;
    } finally { if (valid()) setReading(false); }
  }, [path, stamp, schema, identity, validate, onDenied]);
  useEffect(() => { live.current = true; return () => { live.current = false; lastSuccessful.current = null; cancel(); }; }, [cancel]);
  useEffect(() => { if (path) void reload(); return cancel; }, [path, reload, cancel]);
  const visible = path && snapshot?.stamp === stamp ? snapshot : null;
  return { data: visible?.value ?? null, readAt: visible?.readAt ?? null, reading, error, reload, cancel };
}

type HistoryProps = Caps & {
  accountId: string; initialTarget?: AdHistoryTarget | null;
  onLocate(target: AdHistoryTarget | null): void;
  onRestoreAnalysis(run: AdAnalysisRun): void;
  renderAnalysisBasis?(run: AdAnalysisRun): ReactNode;
  onDirty(dirty: boolean): void; onDenied(message: string): void;
};
export function AdvertisingHistory({ accountId, canRead, canWrite, canReview, initialTarget = null, onLocate, onRestoreAnalysis, renderAnalysisBasis, onDirty, onDenied }: HistoryProps) {
  const access = useErpAccess(), transition = useOwnedViewTransition();
  const identity = useMemo(() => ({ authority: access.authority, preferenceScope: access.preferenceScope, localDevelopment: access.localDevelopment }), [access.authority, access.preferenceScope, access.localDevelopment]);
  const owner = `${identity.preferenceScope ?? ""}:${identity.authority ?? ""}:${accountId}:${canRead}:${canWrite}:${canReview}`;
  const caps = useMemo(() => ({ canRead, canWrite, canReview }), [canRead, canWrite, canReview]);
  const kinds = AdHistoryKindSchema.options.filter(kind => adHistoryPermitted(kind, caps));
  const permittedInitial = initialTarget && adHistoryPermitted(initialTarget.kind, caps) ? initialTarget : null;
  const [scope, setScope] = useState<{ kind: AdHistoryKind; parentId: string | null }>(() => ({ kind: permittedInitial?.kind ?? kinds[0] ?? "imports", parentId: permittedInitial?.parentId ?? null }));
  const [target, setTarget] = useState<AdHistoryTarget | null>(permittedInitial);
  const [cursor, setCursor] = useState<string | null>(null), [previous, setPrevious] = useState<Array<string | null>>([]);
  const [idDraft, setIdDraft] = useState(permittedInitial?.id ?? ""), [parentDraft, setParentDraft] = useState(permittedInitial?.parentId ?? "");
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [dirty, setDirty] = useState(false);
  const [locationStamp, setLocationStamp] = useState(JSON.stringify(initialTarget));
  const installedOwner = useRef(owner), installedLocation = useRef(JSON.stringify(initialTarget)), navigation = useRef(0);
  const current = useRef({ owner, canRead, accountId }); current.current = { owner, canRead, accountId };
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const allowed = installedOwner.current === owner && locationStamp === JSON.stringify(initialTarget);
  const markDirty = useCallback((value: boolean) => { setDirty(value); onDirty(value); }, [onDirty]);
  const mayLeave = () => {
    if (dirtyRef.current && !window.confirm("切换会清除当前填写副本 已提交操作不会撤销 结果尚未确认时请先重试原正文与原键 是否继续")) return false;
    markDirty(false); return true;
  };
  useLayoutEffect(() => {
    if (installedOwner.current === owner) return;
    installedOwner.current = owner; navigation.current++; transition.cancel();
    setScope({ kind: AdHistoryKindSchema.options.find(kind => adHistoryPermitted(kind, caps)) ?? "imports", parentId: null });
    setTarget(null); setCursor(null); setPrevious([]); setIdDraft(""); setParentDraft(""); setError(""); setNotice(""); setDirty(false); onDirty(false);
  }, [owner, caps, transition, onDirty]);
  const locationKey = JSON.stringify(initialTarget);
  useEffect(() => () => { navigation.current++; transition.cancel(); }, [transition]);
  useLayoutEffect(() => {
    if (installedLocation.current === locationKey) return;
    installedLocation.current = locationKey; setLocationStamp(locationKey);
    if (JSON.stringify(target) === locationKey) return;
    navigation.current++; transition.cancel(); setDirty(false); onDirty(false); setError(""); setNotice("");
    if (initialTarget && adHistoryPermitted(initialTarget.kind, caps)) {
      setScope({ kind: initialTarget.kind, parentId: initialTarget.parentId }); setTarget(initialTarget); setIdDraft(initialTarget.id); setParentDraft(initialTarget.parentId ?? ""); setCursor(null); setPrevious([]);
    } else setTarget(null);
  }, [locationKey, initialTarget, target, caps, transition, onDirty]);
  const checkMode = useCallback((mode: AdHistoryPage["accessMode"], kind: AdHistoryKind) => {
    const permitted = mode === "read" ? canRead : mode === "own_write" ? canWrite && writeKinds.has(kind) : canReview && !writeKinds.has(kind);
    if (!permitted) { adRecheckSession(); throw new AdRequestError(409, "当前历史读取权限已变化 私有内容已清除", "authority_changed"); }
  }, [canRead, canWrite, canReview]);
  const query = useMemo(() => AdHistoryQuerySchema.safeParse({ accountId, kind: scope.kind, pageSize: 25, ...(scope.parentId ? { parentId: scope.parentId } : {}), ...(cursor ? { cursor } : {}) }), [accountId, scope, cursor]);
  const pagePath = allowed && adHistoryPermitted(scope.kind, caps) && query.success ? `history?${new URLSearchParams(Object.entries(query.data).map(([key, value]) => [key, String(value)]))}` : null;
  const validatePage = useCallback((page: AdHistoryPage) => {
    if (page.accountId !== accountId || page.kind !== scope.kind || page.parentId !== scope.parentId || page.pageSize !== 25 || page.requestCursor !== cursor) throw new AdRequestError(502, "历史列表与当前账户 类型 父记录或游标不一致");
    checkMode(page.accessMode, page.kind);
  }, [accountId, scope.kind, scope.parentId, cursor, checkMode]);
  const page = useHistoryRead({ path: pagePath, stamp: `${owner}:${pagePath}`, schema: AdHistoryPageSchema, identity, validate: validatePage, onDenied });
  const recordQuery = target && AdHistoryRecordQuerySchema.safeParse({ accountId, kind: target.kind, ...(target.parentId ? { parentId: target.parentId } : {}) });
  const detailPath = allowed && target && adHistoryPermitted(target.kind, caps) && recordQuery?.success ? `records/${target.id}?${new URLSearchParams(Object.entries(recordQuery.data).map(([key, value]) => [key, String(value)]))}` : null;
  const validateDetail = useCallback((detail: AdHistoryRecordResult) => {
    if (!target || detail.accountId !== accountId || detail.recordId !== target.id || detail.record.kind !== target.kind || detail.parentId !== target.parentId) throw new AdRequestError(502, "原记录详情与本次账户 类型 ID 或父记录不一致");
    checkMode(detail.accessMode, detail.record.kind);
  }, [accountId, target, checkMode]);
  const detail = useHistoryRead({ path: detailPath, stamp: `${owner}:${detailPath}`, schema: AdHistoryRecordResultSchema, identity, validate: validateDetail, onDenied });
  const selectRecord = (next: AdHistoryTarget) => {
    if (!adHistoryPermitted(next.kind, caps) || !mayLeave()) return;
    navigation.current++; transition.cancel(); detail.cancel(); setTarget(next); setIdDraft(next.id); setError(""); setNotice("");
    if (scope.kind !== next.kind || scope.parentId !== next.parentId) { setScope({ kind: next.kind, parentId: next.parentId }); setParentDraft(next.parentId ?? ""); setCursor(null); setPrevious([]); }
    onLocate(next);
  };
  const selectScope = (kind: AdHistoryKind, parentId: string | null) => {
    if (!mayLeave()) return;
    navigation.current++; transition.cancel(); page.cancel(); detail.cancel();
    setScope({ kind, parentId }); setParentDraft(parentId ?? ""); setIdDraft(""); setTarget(null); setCursor(null); setPrevious([]); setError(""); setNotice(""); onLocate(null);
  };
  const closeDetail = () => { if (mayLeave()) { navigation.current++; transition.cancel(); detail.cancel(); setTarget(null); setNotice(""); onLocate(null); } };
  const changePage = (update: () => void) => {
    const token = ++navigation.current, captured = owner; transition.cancel(); page.cancel();
    transition.change(() => { if (token === navigation.current && current.current.owner === captured) update(); });
  };
  const rereadAfterWrite = async () => {
    const captured = owner, token = navigation.current;
    markDirty(false);
    const value = await detail.reload();
    if (current.current.owner !== captured || navigation.current !== token) return;
    if (!value) { setNotice("原操作已返回登记凭据 详情重新读取未完成 请重读 不要重复登记"); throw new Error("refresh_failed"); }
    setNotice("原操作已返回登记凭据 下方是另一次受权读取的当前详情");
  };
  async function download(path: string, fileName: string) {
    if (!canRead) return;
    const captured = owner, token = navigation.current;
    try {
      const blob = await adDownload(path);
      if (current.current.owner !== captured || !current.current.canRead || navigation.current !== token) return;
      const href = URL.createObjectURL(blob), anchor = document.createElement("a"); anchor.href = href; anchor.download = fileName; document.body.append(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(href);
    } catch (failure) {
      if (current.current.owner !== captured || navigation.current !== token) return;
      if (adDenied(failure)) onDenied(adError(failure)); else setError(adError(failure));
    }
  }
  return <section className="ad-history ad-panel" aria-label="广告完整历史">
    <header><h2><History size={17} />完整历史与原 ID 恢复</h2><button type="button" className="ad-secondary" disabled={!pagePath || page.reading} onClick={() => { if (cursor) changePage(() => { setPrevious([]); setCursor(null); }); else void page.reload(); }}><RefreshCw size={14} />刷新历史首页</button></header>
    <p className="ad-note">按当前店铺 类型与父记录读取 不使用复盘区的日期 站点或币种筛选 按登记 ID 倒序 不是发生时间排序 记录状态可继续变化 本轮截止时间与编号上界不等于业务快照</p>
    {!canRead && <p className="ad-note">没有广告读取权限 仅恢复当前录入或审核权限允许的本人记录 不授予 CSV 来源下载权限</p>}
    {allowed && kinds.length > 0 ? <>
      <div className="ad-history-controls">
        <label>历史记录类型<select aria-label="历史记录类型" value={scope.kind} onChange={event => selectScope(AdHistoryKindSchema.parse(event.target.value), null)}>{kinds.map(kind => <option key={kind} value={kind}>{adHistoryLabels[kind]}</option>)}</select></label>
        {scope.kind.endsWith("_events") && <form className="ad-history-parent" onSubmit={event => { event.preventDefault(); const parent = id(parentDraft.trim()); if (!parent) { setError("请填写真实的父动作或导入来源 ID"); return; } selectScope(scope.kind, parent); }}><label>历史父记录 ID<input value={parentDraft} maxLength={36} required autoComplete="off" onChange={event => setParentDraft(event.target.value)} /></label><button type="submit" className="ad-secondary">应用父记录</button></form>}
        <form className="ad-history-lookup" onSubmit={event => { event.preventDefault(); const recordId = id(idDraft.trim()); if (!recordId || scope.kind.endsWith("_events") && !scope.parentId) { setError("请填写真实原记录 ID 事件须先应用父记录 ID"); return; } selectRecord({ kind: scope.kind, id: recordId, parentId: scope.parentId }); }}><label>广告原记录 ID<input value={idDraft} maxLength={36} required autoComplete="off" onChange={event => setIdDraft(event.target.value)} /></label><button type="submit" className="ad-secondary"><FileSearch size={14} />按原 ID 读取</button></form>
      </div>
      {scope.kind.endsWith("_events") && <p className="ad-note">当前已应用父记录 <code>{scope.parentId ?? "尚未应用 请输入父记录"}</code></p>}
      {error && <p className="ad-error" role="alert">{error}</p>}{notice && <p className="ad-notice" role="status">{notice}</p>}
      <section className="ad-history-list" aria-label="广告历史记录" aria-busy={page.reading}>
        {page.error && <div className="ad-error" role="alert">{page.error}<button type="button" className="ad-secondary" disabled={page.reading} onClick={() => void page.reload()}>重新读取历史本页</button></div>}
        {page.reading && <p className="ad-note" role="status">正在读取这页真实历史记录</p>}
        {page.data && <><p className="ad-note">{accessLabel(page.data.accessMode)} · 本轮范围共 {page.data.count} 条 · 本页 {page.data.rows.length} 条 · 第 {previous.length + 1} 个已读页{page.error || page.reading ? " · 上次读取记录待重读" : ""}</p><p className="ad-history-boundary">本轮登记截止 {page.data.recordedBefore}<br />登记 ID 上界 <code>{page.data.upperBound ?? "无记录"}</code></p>
          <table className="ad-history-table"><thead><tr><th>原记录</th><th>登记与统计范围</th><th>状态与依据</th><th>读取</th></tr></thead><tbody>{page.data.rows.map(row => <tr key={row.id}><td data-label="原记录"><strong>{row.title || "未提供标题"}</strong><code>{row.id}</code><small>{row.ownedByCurrentActor ? "本人登记" : "当前读取权限可见"}</small></td><td data-label="登记与统计范围"><time>{row.createdAt}</time><small>{row.periodStart ?? "未提供统计开始"} 至 {row.periodEnd ?? "未提供统计结束"}</small></td><td data-label="状态与依据">{row.status ? adStatusLabels[row.status as keyof typeof adStatusLabels] ?? row.status : "无状态字段"}{row.revision !== null && <small>原版本 V{row.revision}</small>}{row.checksum && <small>校验值 <code>{row.checksum}</code></small>}{row.runId && <small>分析 ID <code>{row.runId}</code></small>}</td><td data-label="读取"><button type="button" className="ad-link" aria-label={`读取历史记录 ${row.id}`} onClick={() => selectRecord({ kind: row.kind, id: row.id, parentId: row.parentId })}><FileSearch size={14} />读取原记录</button></td></tr>)}</tbody></table>
          {!page.data.rows.length && !page.error && !page.reading && <p className="ad-empty" role="status">本次范围没有历史记录 不代表其他类型或其他账户没有登记</p>}</>}
        {!page.data && !page.reading && !page.error && <p className="ad-note">{query.success ? "尚未读取本页" : "事件历史须先应用真实父记录 ID"}</p>}
        <nav className="ad-pager" aria-label="广告完整历史分页"><button type="button" className="ad-secondary" disabled={page.reading || !previous.length} onClick={() => changePage(() => { setCursor(previous[previous.length - 1] ?? null); setPrevious(stack => stack.slice(0, -1)); })}><ArrowLeft size={14} />返回已读历史前页</button><button type="button" className="ad-secondary" disabled={page.reading || Boolean(page.error) || !page.data?.hasMore} onClick={() => { const next = page.data?.nextCursor; if (next) changePage(() => { setPrevious(stack => [...stack, cursor]); setCursor(next); }); }}>读取下一页历史<ArrowRight size={14} /></button></nav>
      </section>
      {target && <section className="ad-history-detail" aria-label="广告历史详情" aria-busy={detail.reading}><header><h3>{adHistoryLabels[target.kind]}原记录</h3><button type="button" className="ad-icon" aria-label="关闭历史详情" onClick={closeDetail}><X size={16} /></button></header><p className="ad-note">原记录 ID <code>{target.id}</code> · 当前账户 <code>{accountId}</code></p>
        <button type="button" className="ad-secondary" disabled={detail.reading || dirty} onClick={() => void detail.reload()}><RefreshCw size={14} />重新读取原记录</button>
        {detail.reading && <p className="ad-note" role="status">正在独立读取原 ID 详情</p>}{detail.error && <p className="ad-error" role="alert">{detail.error} 读取失败不代表记录不存在</p>}
        {detail.data && <><p className="ad-note">{accessLabel(detail.data.accessMode)} · {detail.error || detail.reading ? "上次读取详情 待重新核对" : "本次读取详情"} · {detail.readAt}</p><fieldset className="ad-history-record" disabled={detail.reading || Boolean(detail.error)}><AdHistoryRecordView key={`${detail.data.record.kind}:${detail.data.recordId}`} detail={detail.data} canRead={canRead} canWrite={canWrite} canReview={canReview} onOpen={selectRecord} onEvents={(kind, parentId) => selectScope(kind, parentId)} onDownload={(path, fileName) => void download(path, fileName)} onRestoreAnalysis={run => { if (mayLeave()) onRestoreAnalysis(run); }} renderAnalysisBasis={renderAnalysisBasis} onSaved={rereadAfterWrite} onDirty={markDirty} onDenied={onDenied} /></fieldset></>}
      </section>}
    </> : <p className="ad-note" role="status">当前没有历史恢复权限 私有列表与原记录已清除</p>}
  </section>;
}

function Pair({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
function OriginalIds({ label, values, onSelect }: { label: string; values: string[]; onSelect?(value: string): void }) {
  const [page, setPage] = useState(1), size = 25, pages = Math.max(1, Math.ceil(values.length / size)), selected = Math.min(page, pages);
  return <details className="ad-history-ids"><summary>{label} {values.length} 项</summary><p className="ad-note">原传输完整保留 当前显示第 {selected}／{pages} 页</p><nav className="ad-pager" aria-label={`${label}分页`}><button type="button" className="ad-secondary" disabled={selected === 1} onClick={() => setPage(value => value - 1)}>上一页{label}</button><button type="button" className="ad-secondary" disabled={selected === pages} onClick={() => setPage(value => value + 1)}>下一页{label}</button></nav><ul>{values.slice((selected - 1) * size, selected * size).map((value, index) => <li key={`${value}:${index}`}>{onSelect ? <button type="button" className="ad-link" onClick={() => onSelect(value)}><Link2 size={13} /><code>{value}</code></button> : <code>{value}</code>}</li>)}</ul></details>;
}
function ExportSourceSnapshots({ sources }: { sources: AdImportView[] | undefined }) {
  const [page, setPage] = useState(1), size = 25;
  if (!sources) return <p className="ad-note">此历史包未保存逐来源快照 不用当前来源补填</p>;
  const pages = Math.max(1, Math.ceil(sources.length / size)), selected = Math.min(page, pages);
  return <details className="ad-history-ids"><summary>原封存来源快照 {sources.length} 项</summary><p className="ad-note">只显示原包保存内容 不读取今天来源 当前第 {selected}／{pages} 页</p><nav className="ad-pager" aria-label="原封存来源快照分页"><button type="button" className="ad-secondary" disabled={selected === 1} onClick={() => setPage(value => value - 1)}>上一页来源快照</button><button type="button" className="ad-secondary" disabled={selected === pages} onClick={() => setPage(value => value + 1)}>下一页来源快照</button></nav>{sources.slice((selected - 1) * size, selected * size).map(source => <details key={source.id}><summary>{source.fileName} · <code>{source.id}</code></summary><dl className="ad-source-fields"><Pair label="原来源校验值"><code>{source.checksum}</code></Pair><Pair label="原报表类型">{adLabels[source.reportType]}</Pair><Pair label="原统计范围">{source.periodStart ?? "未知"} 至 {source.periodEnd ?? "未知"}</Pair><Pair label="原采集与声明口径">{source.observedAt} · {source.timezone} · {source.attributionWindowDays ?? "未知"} 天 · {source.attributionBasis}</Pair><Pair label="原包保存归档状态">{source.archivedAt ?? "当时未归档"}</Pair><Pair label="原始／可用／隔离行">{source.sourceRowCount}／{source.acceptedRowCount}／{source.rejectedRowCount}</Pair></dl><AdMeasurementSummary measurement={source.measurement} /><OriginalIds label="原来源诊断" values={source.diagnostics.map(value => `${value.code} · ${value.row === null ? "文件" : `第 ${value.row} 行`} · ${value.column ?? "未指定列"} · ${value.message}`)} /></details>)}</details>;
}
function ExportActionSnapshots({ actions }: { actions: AdExportView["payload"]["actions"] }) {
  const [page, setPage] = useState(1), size = 25, pages = Math.max(1, Math.ceil(actions.length / size)), selected = Math.min(page, pages);
  return <details className="ad-history-ids"><summary>原封存动作快照 {actions.length} 项</summary><p className="ad-note">这是原包保存的状态和金额 与随后按 ID 读取的当前动作分开 当前第 {selected}／{pages} 页</p><nav className="ad-pager" aria-label="原封存动作快照分页"><button type="button" className="ad-secondary" disabled={selected === 1} onClick={() => setPage(value => value - 1)}>上一页动作快照</button><button type="button" className="ad-secondary" disabled={selected === pages} onClick={() => setPage(value => value + 1)}>下一页动作快照</button></nav>{actions.slice((selected - 1) * size, selected * size).map(action => { const rec = action.recommendation; return <details key={action.id}><summary>{rec.title} · {adStatusLabels[action.status]} · V{action.revision}</summary><dl className="ad-source-fields"><Pair label="原包动作 ID"><code>{action.id}</code></Pair><Pair label="原包分析 ID"><code>{action.runId}</code></Pair><Pair label="原产品与统计范围">{rec.scope?.asin ?? "产品未关联"} · {rec.marketplace ?? "站点未知"} · {rec.currency ?? "币种未知"} · {rec.periodStart} 至 {rec.periodEnd}</Pair><Pair label="原规则／目标版本"><code>{rec.ruleId}</code> · <code>{rec.goalVersionId ?? "未使用目标版本"}</code></Pair><Pair label="原建议原因">{rec.reason}</Pair><Pair label="原竞价／建议竞价">{adMoney(rec.currentBidMinor, rec.currency, rec.monetaryBasis)} → {adMoney(rec.proposedBidMinor, rec.currency, rec.monetaryBasis)}</Pair><Pair label="原花费／归因销售额">{adMoney(rec.metrics.spendMinor, rec.currency, rec.monetaryBasis)}／{adMoney(rec.metrics.salesMinor, rec.currency, rec.monetaryBasis)}</Pair><Pair label="原展示／点击／购买">{rec.metrics.impressions ?? "未知"}／{rec.metrics.clicks ?? "未知"}／{rec.metrics.purchases ?? "未知"}</Pair><Pair label="原包保存执行时间">{action.executedAt ?? "未登记执行"}</Pair><Pair label="原包保存实际前／后金额">{adMoney(action.actualBeforeMinor, rec.currency, rec.monetaryBasis)} → {adMoney(action.actualAfterMinor, rec.currency, rec.monetaryBasis)}</Pair><Pair label="原包保存实际对象">活动 {action.execution?.campaignId ?? "未保存"} · 广告组 {action.execution?.adGroupId ?? "未保存"} · 投放 {action.execution?.targetId ?? "未保存"}</Pair></dl><AdMonetaryBasisNote currency={rec.currency} basis={rec.monetaryBasis} /><OriginalIds label="原包建议限制" values={rec.constraints} /><OriginalIds label="原包事实校验值" values={rec.evidenceKeys} /><OriginalIds label="原包处理事件" values={action.events.map(event => `${event.id} · ${event.at} · ${adStatusLabels[event.status]} · ${event.reason}`)} /></details>; })}</details>;
}
type RecordProps = Caps & {
  detail: AdHistoryRecordResult; onOpen(target: AdHistoryTarget): void;
  onEvents(kind: "action_events" | "import_events", parentId: string): void;
  onDownload(path: string, fileName: string): void; onRestoreAnalysis(run: AdAnalysisRun): void;
  renderAnalysisBasis?(run: AdAnalysisRun): ReactNode;
  onSaved(): Promise<void>; onDirty(value: boolean): void; onDenied(message: string): void;
};
export function AdHistoryRecordView({ detail, canRead, canWrite, canReview, onOpen, onEvents, onDownload, onRestoreAnalysis, renderAnalysisBasis, onSaved, onDirty, onDenied }: RecordProps) {
  const record = detail.record;
  switch (record.kind) {
    case "imports": {
      const row = record.value;
      return <><dl className="ad-source-fields"><Pair label="原文件">{row.fileName} · {adLabels[row.reportType]}</Pair><Pair label="来源校验值"><code>{row.checksum}</code></Pair><Pair label="原统计范围">{row.periodStart ?? "未知"} 至 {row.periodEnd ?? "未知"}</Pair><Pair label="原采集与声明归因">{row.observedAt} · {row.timezone} · {row.attributionWindowDays ?? "未知"} 天 · {row.attributionBasis}</Pair><Pair label="原始／可用／隔离行">{row.sourceRowCount}／{row.acceptedRowCount}／{row.rejectedRowCount}</Pair><Pair label="当前读取归档状态">{row.archivedAt ?? "未归档"}</Pair></dl><AdMeasurementSummary measurement={row.measurement} /><ul className="ad-constraints">{row.diagnostics.map((item, index) => <li key={index}>{item.code} · {item.row === null ? "文件" : `第 ${item.row} 行`} · {item.message}</li>)}</ul><div className="ad-history-related"><button type="button" className="ad-secondary" onClick={() => onEvents("import_events", row.id)}>读取全部来源归档事件</button>{canRead && <button type="button" className="ad-secondary" onClick={() => onDownload(`imports/${row.id}/source`, `advertising-source-${row.id}.csv`)}>下载原 CSV 来源</button>}</div><AdArchiveForm key={row.id} accountId={row.accountId} importId={row.id} permitted={canWrite && !row.archivedAt} onSaved={onSaved} onDirty={onDirty} onDenied={onDenied} /></>;
    }
    case "goals": {
      const row = record.value, fields = row.fields;
      return <><AdGoalMoneySummary goal={row} /><dl className="ad-source-fields"><Pair label="产品范围">{row.scope.asin} · {row.scope.marketplace} · {row.scope.currency}</Pair><Pair label="固定产品 ID"><code>{row.productId}</code></Pair><Pair label="目标模式">{fields.mode === "rank_growth" ? "推排名" : "保利润"}</Pair><Pair label="生效日期">{fields.effectiveFrom}</Pair><Pair label="试验结束">{fields.trialEndDate ?? "未设置"}</Pair><Pair label="原目标 ACoS">{fields.targetAcosBps === null ? "未设置" : `${fields.targetAcosBps} 基点`}</Pair><Pair label="最少点击／购买">{fields.minimumClicks}／{fields.minimumPurchases}</Pair><Pair label="原调整上限／利润预留">{fields.maxBidChangeBps}／{fields.profitReserveBps} 基点</Pair><Pair label="原观察窗口">{fields.cooldownDays} 天</Pair><Pair label="人工依据">{fields.notes || "未填写"}</Pair><Pair label="原版本校验值"><code>{row.checksum}</code></Pair></dl><OriginalIds label="核心关键词" values={fields.coreKeywords} /><OriginalIds label="保护词" values={fields.protectedTerms} /></>;
    }
    case "observations": {
      const row = record.value;
      return <><dl className="ad-source-fields"><Pair label="证据类型">{row.kind === "organic_rank" ? "自然排名" : "产品经营数据"}</Pair><Pair label="产品范围">{row.scope.asin} · {row.scope.marketplace} · {row.scope.currency}</Pair><Pair label="原统计期间">{row.periodStart} 至 {row.periodEnd}</Pair><Pair label="原采集时间">{row.observedAt}</Pair><Pair label="原来源说明">{row.source}</Pair>{row.kind === "organic_rank" ? <Pair label="实际关键词与自然名次">{row.keyword} · {row.organicRank ?? "未知"}</Pair> : <><Pair label="总销售额">{adMoney(row.totalSalesMinor, row.scope.currency, row.monetaryBasis)}</Pair><Pair label="总购买量">{row.totalPurchases ?? "未知"}</Pair><Pair label="广告前贡献利润">{adMoney(row.preAdContributionMinor, row.scope.currency, row.monetaryBasis)}</Pair><Pair label="原广告覆盖确认">{row.adsCoverageConfirmed ? "登记时已人工确认" : "登记时未确认"}</Pair></>}</dl>{row.kind === "commerce" && <AdMonetaryBasisNote currency={row.scope.currency} basis={row.monetaryBasis} />}</>;
    }
    case "analyses": {
      const row = record.value;
      return <><dl className="ad-source-fields"><Pair label="原分析 ID"><code>{row.id}</code></Pair><Pair label="原统计范围">{row.periodStart} 至 {row.periodEnd} · {row.marketplace ?? "全部站点"} · {row.currency ?? "分币种"}</Pair><Pair label="原证据截止时间">{row.evidenceCutoffAt}</Pair><Pair label="原封存状态">{row.status === "partial" ? "存在待核对项" : "已封存"}</Pair><Pair label="原输入校验值"><code>{row.inputChecksum}</code></Pair><Pair label="已选／替代事实">{row.result.selectedFactCount}／{row.result.supersededFactCount}</Pair></dl><p className="ad-note">这是原分析保存结果 载入不重新分析 不按今天的报表或目标改写原版本</p><button type="button" className="ad-secondary" onClick={() => onRestoreAnalysis(row)}>载入此分析原结果</button><OriginalIds label="原导入来源 ID" values={row.result.evidenceImportIds} onSelect={canRead || canWrite ? value => onOpen({ kind: "imports", id: value, parentId: null }) : undefined} /><OriginalIds label="原目标版本 ID" values={row.result.goalVersionIds} onSelect={canRead || canReview ? value => onOpen({ kind: "goals", id: value, parentId: null }) : undefined} />{renderAnalysisBasis?.(row)}</>;
    }
    case "actions": {
      const row = record.value, context = detail.actionContext;
      return <><dl className="ad-source-fields"><Pair label="原所属分析"><button type="button" className="ad-link" onClick={() => onOpen({ kind: "analyses", id: row.runId, parentId: null })}><Link2 size={13} /><code>{row.runId}</code></button></Pair><Pair label="本次读取状态／版本">{adStatusLabels[row.status]} · V{row.revision}</Pair><Pair label="原观察窗口">{context ? `${context.cooldownDays} 天 · ${context.source === "saved_goal" ? "来自保存的原目标" : "原服务缺少目标时的历史默认规则"}` : "原操作观察窗口待核对"}</Pair><Pair label="最早可复盘时间">{context?.reviewNotBefore ?? "尚无实际执行时间"}</Pair></dl><button type="button" className="ad-secondary" onClick={() => onEvents("action_events", row.id)}>读取全部动作处理事件</button><p className="ad-note">下方动作详情是本次独立读取的投影 续办只登记人工已完成的处理 不直接操作广告平台</p>{context && <AdActionForm key={`${row.id}:${row.revision}`} action={row} cooldownDays={context.cooldownDays} permitted={canReview} onSaved={onSaved} onDirty={onDirty} onDenied={onDenied} />}<OriginalIds label="证据事实校验值" values={row.recommendation.evidenceKeys} /></>;
    }
    case "exports": {
      const row = record.value;
      return <><dl className="ad-source-fields"><Pair label="原审阅包校验值"><code>{row.checksum}</code></Pair><Pair label="原封存分析 ID"><code>{row.runId}</code></Pair><Pair label="原审阅者 ID"><code>{row.payload.reviewedBy}</code></Pair><Pair label="原审阅依据">{row.reviewReason}</Pair><Pair label="原封存时间">{row.createdAt}</Pair><Pair label="版本／执行方式">{row.payload.schemaVersion} · 人工执行清单</Pair></dl><p className="ad-note">此包保存当时分析与动作快照 不代表今天的动作状态 也不是广告后台执行成功回执</p><div className="ad-history-related"><button type="button" className="ad-secondary" onClick={() => onOpen({ kind: "analyses", id: row.runId, parentId: null })}>按原 ID 读取分析</button><button type="button" className="ad-secondary" onClick={() => onRestoreAnalysis(row.payload.run)}>载入原包中的分析快照</button></div>{canRead && <div className="ad-history-related"><button type="button" className="ad-secondary" onClick={() => onDownload(`exports/${row.id}`, `advertising-review-${row.id}.json`)}>下载原封存包</button><button type="button" className="ad-secondary" onClick={() => onDownload(`exports/${row.id}/csv`, `advertising-review-${row.id}.csv`)}>下载原人工清单</button></div>}<OriginalIds label="原封存动作 ID" values={row.payload.actions.map(action => action.id)} onSelect={value => onOpen({ kind: "actions", id: value, parentId: null })} /><ExportActionSnapshots actions={row.payload.actions} /><ExportSourceSnapshots sources={row.payload.sourcePins} />{renderAnalysisBasis?.(row.payload.run)}</>;
    }
    case "action_events": {
      const row = record.value;
      return <dl className="ad-source-fields"><Pair label="原动作 ID"><code>{row.actionId}</code></Pair><Pair label="实际登记状态">{adStatusLabels[row.status]}</Pair><Pair label="原处理原因">{row.reason}</Pair><Pair label="原预期版本／状态">{row.expectedRevision ?? "历史未保存"}／{row.expectedStatus ? adStatusLabels[row.expectedStatus] : "历史未保存"}</Pair><Pair label="实际登记时间">{row.createdAt}</Pair><Pair label="原实际执行时间">{row.executedAt ?? "未登记"}</Pair><Pair label="原执行前金额">{row.actualBeforeMinor === null ? "未登记" : `${row.actualBeforeMinor} 保存最小单位 事件未保存币种与精度`}</Pair><Pair label="原执行后金额">{row.actualAfterMinor === null ? "未登记" : `${row.actualAfterMinor} 保存最小单位 事件未保存币种与精度`}</Pair><Pair label="原实际执行对象">活动 {row.execution?.campaignId ?? "未登记"} · 广告组 {row.execution?.adGroupId ?? "未登记"} · 投放 {row.execution?.targetId ?? "未登记"}</Pair></dl>;
    }
    case "import_events": {
      const row = record.value;
      return <dl className="ad-source-fields"><Pair label="原来源 ID"><code>{row.importId}</code></Pair><Pair label="实际归档事件">已归档</Pair><Pair label="原归档原因">{row.reason}</Pair><Pair label="实际登记时间">{row.createdAt}</Pair></dl>;
    }
  }
}
