"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { z } from "zod";
import { FileSearch, RefreshCw, ShieldCheck, ChevronLeft, ChevronRight, Eraser } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import {
  AGENT_FULFILLMENT_VERSION, AGENT_FULFILLMENT_TOOL, AgentFulfillmentCallSchema,
  type AgentFulfillmentKind, type AgentFulfillmentResult, type AgentFulfillmentWorkspace,
} from "@yummyai/contracts/ai/agent-fulfillment";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { useErpAccess } from "../identity/erp-access";
import { AgentFulfillmentContext, AgentFulfillmentDefinitionView, type AgentFulfillmentSelection } from "./agent-fulfillment-context";
import { AgentFulfillmentEvidence } from "./agent-fulfillment-evidence";
import {
  AgentFulfillmentRequestError, agentFulfillmentKindLabels, agentFulfillmentReadDenied,
  readAgentFulfillmentWorkspace, readAgentFulfillmentDefinition, readAgentFulfillmentCandidates, callAgentFulfillment,
  type AgentFulfillmentCandidatesQuery,
} from "./agent-fulfillment-client";
import type { AgentFulfillmentCandidates } from "@yummyai/contracts/ai/agent-fulfillment";
import "./agent-fulfillment.css";

export type AgentFulfillmentEntryProps = { orderId?: string; expectedSequence?: number };
type Identity = { authority: string | null; owner: string | null };
type SourceState = { pages: AgentFulfillmentResult[]; index: number; phase: "idle" | "definition" | "source"; error: string };
const kinds: readonly AgentFulfillmentKind[] = ["production", "shipments", "logistics"];
const emptySource = (): SourceState => ({ pages: [], index: 0, phase: "idle", error: "" });
const emptySources = (): Record<AgentFulfillmentKind, SourceState> => ({ production: emptySource(), shipments: emptySource(), logistics: emptySource() });
const failureText = (error: unknown) => error instanceof AgentFulfillmentRequestError ? error.message : "本次来源读取暂不可核对 请重读原资料 不补造缺失事实";
const selectionKey = (selection: AgentFulfillmentSelection | null) => selection ? `${selection.orderId}:${selection.expectedSequence}` : "none";

export function AgentFulfillmentEntry({ orderId, expectedSequence }: AgentFulfillmentEntryProps) {
  const access = useErpAccess(), identity = useRef<Identity>({ authority: access.authority, owner: access.preferenceScope });
  identity.current = { authority: access.authority, owner: access.preferenceScope };
  const pinned = orderId !== undefined || expectedSequence !== undefined;
  const parsedId = z.uuidv7().safeParse(orderId), parsedSequence = z.int().positive().safeParse(expectedSequence);
  if (!access.authority || !access.preferenceScope) return <section className="agent-fulfillment" aria-label="核对本单履约依据"><h2><FileSearch size={17} />核对本单履约依据</h2><p role="status">正在核对当前本人身份 暂不读取原订单</p></section>;
  if (!access.canTenant(Permission.OrderRead)) return <section className="agent-fulfillment" aria-label="核对本单履约依据"><h2><FileSearch size={17} />核对本单履约依据</h2><p role="status">当前账号缺少租户范围的订单读取权限 原候选与履约资料已隐藏</p></section>;
  if (pinned && (!parsedId.success || !parsedSequence.success)) return <section className="agent-fulfillment" aria-label="核对本单履约依据"><h2><FileSearch size={17} />核对本单履约依据</h2><p role="status">当前订单 ID 或事件修订尚未完整读取 请先在原订单页面重新核对 不使用手填编号代替</p></section>;
  const initialOrderId = pinned && parsedId.success ? parsedId.data.toLowerCase() : undefined, initialSequence = pinned && parsedSequence.success ? parsedSequence.data : undefined;
  return <FulfillmentContent key={`${access.authority}:${access.preferenceScope}:${initialOrderId ?? "candidate"}:${initialSequence ?? ""}`} identity={identity} initialOrderId={initialOrderId} initialSequence={initialSequence} />;
}
function FulfillmentContent({ identity, initialOrderId, initialSequence }: { identity: RefObject<Identity>; initialOrderId?: string; initialSequence?: number }) {
  const access = useErpAccess(), authority = access.authority!, owner = access.preferenceScope!, pinned = Boolean(initialOrderId);
  const alive = useRef(true), blocked = useRef(false), purged = useRef(false), generation = useRef(0);
  const workspaceSequence = useRef(0), candidateSequence = useRef(0), sourceSequence = useRef<Record<AgentFulfillmentKind, number>>({ production: 0, shipments: 0, logistics: 0 });
  const workspaceController = useRef<AbortController | null>(null), candidateController = useRef<AbortController | null>(null);
  const sourceControllers = useRef<Record<AgentFulfillmentKind, AbortController | null>>({ production: null, shipments: null, logistics: null });
  const sourceLocks = useRef<Record<AgentFulfillmentKind, boolean>>({ production: false, shipments: false, logistics: false });
  const [workspace, setWorkspace] = useState<AgentFulfillmentWorkspace | null>(null), workspaceRef = useRef<AgentFulfillmentWorkspace | null>(null);
  const [workspaceReading, setWorkspaceReading] = useState(false), [workspaceError, setWorkspaceError] = useState("");
  const [filters, setFilters] = useState<AgentFulfillmentCandidatesQuery["filters"]>({ limit: 50 });
  const filtersRef = useRef(filters); filtersRef.current = filters;
  const [candidates, setCandidates] = useState<AgentFulfillmentCandidates | null>(null), [candidateReading, setCandidateReading] = useState(false), [candidateError, setCandidateError] = useState("");
  const [selection, setSelection] = useState<AgentFulfillmentSelection | null>(() => initialOrderId && initialSequence ? { orderId: initialOrderId, expectedSequence: initialSequence, label: null, lineId: null } : null);
  const selectionRef = useRef(selection); selectionRef.current = selection;
  const [pageSize, setPageSize] = useState(5), pageSizeRef = useRef(5); pageSizeRef.current = pageSize;
  const [sources, setSources] = useState(emptySources), sourcesRef = useRef(sources); sourcesRef.current = sources;
  const [scopeError, setScopeError] = useState(""), [denied, setDenied] = useState(false), [cleared, setCleared] = useState(false);
  const valid = useCallback(() => alive.current && !blocked.current && !purged.current && identity.current.authority === authority && identity.current.owner === owner, [authority, owner, identity]);
  const updateSource = useCallback((kind: AgentFulfillmentKind, update: (previous: SourceState) => SourceState) => {
    const next = update(sourcesRef.current[kind]); sourcesRef.current = { ...sourcesRef.current, [kind]: next };
    setSources(previous => ({ ...previous, [kind]: next }));
  }, []);
  const clearPages = useCallback(() => {
    generation.current++;
    for (const kind of kinds) { sourceSequence.current[kind]++; sourceControllers.current[kind]?.abort(); sourceLocks.current[kind] = false; }
    const next = emptySources(); sourcesRef.current = next; setSources(next); setScopeError("");
  }, []);
  const clearPrivate = useCallback(() => {
    workspaceSequence.current++; candidateSequence.current++; workspaceController.current?.abort(); candidateController.current?.abort(); clearPages();
    workspaceRef.current = null; setWorkspace(null); setWorkspaceReading(false); setWorkspaceError("");
    setCandidates(null); setCandidateReading(false); setCandidateError(""); selectionRef.current = null; setSelection(null);
  }, [clearPages]);
  const deny = useCallback(() => { blocked.current = true; clearPrivate(); setDenied(true); window.dispatchEvent(new Event("focus")); }, [clearPrivate]);
  useLayoutEffect(() => {
    alive.current = true;
    const clear = () => { purged.current = true; clearPrivate(); setCleared(true); };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    return () => {
      alive.current = false; workspaceSequence.current++; candidateSequence.current++; generation.current++;
      workspaceController.current?.abort(); candidateController.current?.abort();
      for (const kind of kinds) { sourceSequence.current[kind]++; sourceControllers.current[kind]?.abort(); }
      window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    };
  }, [clearPrivate]);
  const loadWorkspace = useCallback(async () => {
    if (!valid()) return; clearPrivate(); const sequence = ++workspaceSequence.current, abort = new AbortController(); workspaceController.current = abort; setWorkspaceReading(true);
    try {
      const value = await readAgentFulfillmentWorkspace(authority, abort.signal);
      if (!valid() || abort.signal.aborted || sequence !== workspaceSequence.current) return;
      workspaceRef.current = value; setWorkspace(value);
      if (initialOrderId && initialSequence) { const fixed = { orderId: initialOrderId, expectedSequence: initialSequence, label: null, lineId: null }; selectionRef.current = fixed; setSelection(fixed); }
    } catch (error) { if (valid() && !abort.signal.aborted && sequence === workspaceSequence.current) { if (agentFulfillmentReadDenied(error)) deny(); else setWorkspaceError(failureText(error)); } }
    finally { if (valid() && sequence === workspaceSequence.current) setWorkspaceReading(false); }
  }, [authority, valid, clearPrivate, deny, initialOrderId, initialSequence]);
  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);
  function select(value: AgentFulfillmentSelection | null) {
    if (selectionKey(value) === selectionKey(selectionRef.current)) return;
    clearPages(); selectionRef.current = value; setSelection(value);
  }
  function changeFilters(value: AgentFulfillmentCandidatesQuery["filters"]) {
    candidateSequence.current++; candidateController.current?.abort(); clearPages();
    filtersRef.current = value; setFilters(value); setCandidateReading(false); setCandidateError(""); setCandidates(null);
    selectionRef.current = null; setSelection(null);
  }
  async function loadCandidates() {
    if (!valid() || pinned || !workspaceRef.current?.definition.available) return;
    candidateController.current?.abort(); const sequence = ++candidateSequence.current, abort = new AbortController(), query = { version: AGENT_FULFILLMENT_VERSION, filters: filtersRef.current };
    const queryKey = canonicalJson(query); candidateController.current = abort; clearPages(); selectionRef.current = null; setSelection(null); setCandidates(null); setCandidateError(""); setCandidateReading(true);
    try {
      const value = await readAgentFulfillmentCandidates(query, authority, abort.signal);
      if (valid() && sequence === candidateSequence.current && !abort.signal.aborted && queryKey === canonicalJson({ version: AGENT_FULFILLMENT_VERSION, filters: filtersRef.current })) setCandidates(value);
    } catch (error) { if (valid() && sequence === candidateSequence.current && !abort.signal.aborted) { if (agentFulfillmentReadDenied(error)) deny(); else setCandidateError(failureText(error)); } }
    finally { if (valid() && sequence === candidateSequence.current) setCandidateReading(false); }
  }
  async function loadSource(kind: AgentFulfillmentKind, next: boolean) {
    const currentWorkspace = workspaceRef.current, selected = selectionRef.current;
    if (!valid() || sourceLocks.current[kind] || !currentWorkspace?.definition.available || !currentWorkspace.sourcePermissions[kind] || !selected) return;
    const prior = next ? sourcesRef.current[kind].pages : [], last = prior.at(-1);
    if (next && (!last || !last.data.coverage.hasMore)) return;
    const cursor = next ? last!.data.coverage.nextCursor : null, selectedKey = selectionKey(selected), size = pageSizeRef.current;
    sourceControllers.current[kind]?.abort(); const sequence = ++sourceSequence.current[kind], currentGeneration = generation.current, abort = new AbortController();
    sourceControllers.current[kind] = abort; sourceLocks.current[kind] = true;
    updateSource(kind, previous => next ? { ...previous, phase: "definition", error: "" } : { ...emptySource(), phase: "definition" });
    const current = () => valid() && !abort.signal.aborted && currentGeneration === generation.current && sequence === sourceSequence.current[kind] && selectedKey === selectionKey(selectionRef.current) && size === pageSizeRef.current;
    try {
      const definition = await readAgentFulfillmentDefinition(authority, abort.signal); if (!current()) return;
      if (!definition.available) throw new AgentFulfillmentRequestError(403, "当前原订单来源已不可读取 旧资料已隐藏");
      if (definition.definitionChecksum !== currentWorkspace.definition.definitionChecksum) throw new AgentFulfillmentRequestError(409, "只读工具定义已变化 请重新核对读取权限与定义 再从第一页读取");
      const call = AgentFulfillmentCallSchema.safeParse({ version: AGENT_FULFILLMENT_VERSION, tool: AGENT_FULFILLMENT_TOOL, executionContract: currentWorkspace.executionContract,
        definitionChecksum: definition.definitionChecksum, input: { orderId: selected.orderId, expectedSequence: selected.expectedSequence, kind, cursor, pageSize: size } });
      if (!call.success) throw new AgentFulfillmentRequestError(400, "原订单与分页输入尚未完整核对 请重新读取真实候选");
      updateSource(kind, previous => ({ ...previous, phase: "source" }));
      const value = await callAgentFulfillment(call.data, authority, abort.signal); if (!current()) return;
      const first = prior[0], coverage = value.data.coverage;
      if (first && (first.data.coverage.collectionChecksum !== coverage.collectionChecksum || first.data.coverage.indexedTotal !== coverage.indexedTotal))
        throw new AgentFulfillmentRequestError(409, "本单原来源集合已变化 旧页已清空 请从第一页重新读取 不拼接不同集合");
      const ids = new Set(prior.flatMap(page => page.data.rows.map(row => row.id)));
      if (value.data.rows.some(row => ids.has(row.id)) || coverage.nextCursor !== null && (coverage.nextCursor === cursor || prior.some(page => page.input.cursor === coverage.nextCursor)))
        throw new AgentFulfillmentRequestError(409, "原来源续页出现重复或回退 旧页已清空 请重新核对原集合");
      const pages = [...prior, value];
      if (pages.reduce((count, page) => count + page.data.rows.length, 0) > coverage.indexedTotal)
        throw new AgentFulfillmentRequestError(409, "原来源页数与索引计数不一致 旧页已清空 请重新读取");
      updateSource(kind, () => ({ pages, index: pages.length - 1, phase: "idle", error: "" }));
    } catch (error) {
      if (!current()) return;
      if (agentFulfillmentReadDenied(error)) deny();
      else if (error instanceof AgentFulfillmentRequestError && error.status === 409) { clearPages(); setScopeError(failureText(error)); }
      else updateSource(kind, previous => ({ ...previous, error: failureText(error) }));
    } finally {
      if (sequence === sourceSequence.current[kind]) { sourceLocks.current[kind] = false; if (valid()) updateSource(kind, previous => ({ ...previous, phase: "idle" })); }
    }
  }
  if (cleared) return <section className="agent-fulfillment" aria-label="核对本单履约依据"><h2>核对本单履约依据</h2><p role="status">当前本人会话已清除 原订单与履约资料已隐藏 迟到响应不回填</p></section>;
  const shownWorkspace = valid() ? workspace : null, shownSelection = valid() ? selection : null;
  return <section className="agent-fulfillment" aria-label="核对本单履约依据"><header className="af-heading"><div><h2><FileSearch size={17} />核对本单履约依据</h2><p className="af-muted">仅通过原业务来源读取本单事实 不启动模型 不收费 不准备或执行业务</p></div><button type="button" disabled={workspaceReading} onClick={() => { blocked.current = false; setDenied(false); void loadWorkspace(); }}><RefreshCw size={14} />重新核对履约读取权限</button></header>
    <p className="af-notice"><ShieldCheck size={14} />按提交默认排产 工厂原表发货 实物质检 实际交运和物流面单分别核对 不将其中一种状态当作其它事实</p>
    {workspaceReading && <p role="status">正在读取当前只读工具定义与原来源权限</p>}{workspaceError && <p className="af-error" role="alert">{workspaceError}</p>}{denied && <p className="af-error" role="status">当前本人身份或对象权限已变化 原候选和全部已读页已清除 请重新核对</p>}
    {shownWorkspace && <>{!shownWorkspace.definition.available && <p className="af-warning" role="status">本次只读工具不可用 · {shownWorkspace.definition.blockReason ?? "请核对当前原订单读取权限"}</p>}
      <AgentFulfillmentContext pinned={pinned} selection={shownSelection} filters={filters} candidates={candidates} reading={candidateReading} error={candidateError} enabled={shownWorkspace.definition.available} onFiltersChange={changeFilters} onRead={() => void loadCandidates()} onSelect={select} />
      <AgentFulfillmentDefinitionView definition={shownWorkspace.definition} />
      <div className="af-actions af-read-options"><label>每页履约记录数<select aria-label="每页履约记录数" value={pageSize} onChange={event => { const value = Number(event.target.value); clearPages(); pageSizeRef.current = value; setPageSize(value); }}>{Array.from({ length: 10 }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value} 项</option>)}</select></label><button type="button" disabled={!kinds.some(kind => sources[kind].pages.length || sources[kind].phase !== "idle")} onClick={clearPages}><Eraser size={14} />清除本次已读页</button><span className="af-muted">每一来源页读取前重新核对原定义 续页仅串行读取</span></div>
      {scopeError && <p className="af-error" role="alert">{scopeError}{pinned ? " 请先在原订单页面重新核对事件修订" : " 可重新读取真实候选确认当前修订"}</p>}
      <div className="af-sections">{kinds.map(kind => {
        const state = sources[kind], currentPage = state.pages[state.index], last = state.pages.at(-1), label = agentFulfillmentKindLabels[kind], reading = state.phase !== "idle", allowed = shownWorkspace.definition.available && shownWorkspace.sourcePermissions[kind];
        const readCount = state.pages.reduce((count, page) => count + page.data.rows.length, 0);
        return <section className="af-source" key={kind} aria-label={label + "履约依据"} aria-busy={reading}><header className="af-heading"><h3>{label}履约依据</h3><button type="button" disabled={!allowed || !shownSelection || reading} onClick={() => void loadSource(kind, false)}><RefreshCw size={14} />{state.pages.length ? `重新读取${label}第一页` : `读取${label}依据`}</button></header>
          {!allowed ? <p className="af-warning" role="status">当前未获此原来源读取权限 此段未读取 不是没有记录 不影响其它已受权来源的独立核对</p> : !shownSelection && <p className="af-muted">先选择真实订单及事件修订</p>}
          {kind === "production" && !shownWorkspace.sourcePermissions.factory && <p className="af-muted">工厂原表需要另行核对原订单私文 设计和资产权限 生产页中的该项按实际缺权限状态展示</p>}
          {last && <div className="af-actions af-pager"><span>本次已读索引 {readCount} / {last.data.coverage.indexedTotal} 项 · 已读第 {state.index + 1} / {state.pages.length} 页</span><button type="button" aria-label={label + "依据上一已读页"} disabled={reading || state.index === 0} onClick={() => updateSource(kind, previous => ({ ...previous, index: previous.index - 1 }))}><ChevronLeft size={13} />上一已读页</button><button type="button" aria-label={label + "依据下一已读页"} disabled={reading || state.index + 1 === state.pages.length} onClick={() => updateSource(kind, previous => ({ ...previous, index: previous.index + 1 }))}>下一已读页<ChevronRight size={13} /></button><button type="button" aria-label={`读取下一页${label}依据`} disabled={reading || !last.data.coverage.hasMore || !allowed} onClick={() => void loadSource(kind, true)}>读取下一页{label}依据<ChevronRight size={13} /></button></div>}
          {last && <p className="af-muted">{last.data.coverage.hasMore ? "仍有后续索引页 尚未读完" : "本次索引已读到末页 仍为非全量业务投影"} · 不汇总推算整单实物或费用总额</p>}
          {reading && <p role="status">{state.phase === "definition" ? `正在核对${label}原读取定义` : `正在读取本单${label}原来源页`}</p>}
          {state.error && <p className="af-error" role="alert">{state.error}{state.pages.length ? " 已读页保留 本次未追加新页" : ""}</p>}
          {!reading && !state.pages.length && !state.error && allowed && shownSelection && <p className="af-muted">此来源尚未读取 不推断其记录或状态</p>}
          {currentPage && <AgentFulfillmentEvidence key={currentPage.callId} result={currentPage} />}
        </section>;
      })}</div>
    </>}
  </section>;
}
