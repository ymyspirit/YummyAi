"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowRight, Check, FileSearch, Link2, RefreshCw, Square, Workflow } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import type { ErpSessionView } from "@yummyai/contracts/auth/session";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { agentTransportTextHash } from "@yummyai/contracts/ai/agent-transport";
import type { AgentCommandView } from "@yummyai/contracts/ai/agent-command";
import {
  AGENT_DEPENDENCY_PLAN_VERSION, AGENT_DEPENDENCY_PLAN_KIND, AGENT_DEPENDENCY_PLAN_CLEAR_EVENT,
  CreateAgentDependencyPlanSchema, AgentDependencyPlanIntentSchema,
  type AgentDependencyPlanWorkspace, type AgentDependencyPlanView, type AgentDependencyPlanSummary,
  type AgentDependencyPlanPage, type AgentDependencyPlanIntent, type AgentDependencyPlanReceipt,
} from "@yummyai/contracts/ai/agent-dependency-plan";
import { formatFinanceMinorAmount } from "@yummyai/contracts/finance/monetary";
import { useErpAccess } from "../identity/erp-access";
import { TaskDrawer } from "../navigation/task-drawer";
import { readAgentOperationRequest, agentOperationDenied } from "./agent-operation-client";
import { AgentOperationNativeSummary, agentOperationStateNames } from "./agent-operation-summary";
import {
  AGENT_DEPENDENCY_PLAN_INTENT_EVENT, AgentDependencyPlanRequestError,
  agentDependencyPlanDenied, agentDependencyPlanError, readAgentDependencyPlanWorkspace,
  readAgentDependencyPlanPage, readAgentDependencyPlan, readAgentDependencyPlanReceipt,
  createAgentDependencyPlan, actOnAgentDependencyPlan, prepareAgentDependencyPlanIntent,
  readAgentDependencyPlanIntents, saveAgentDependencyPlanIntent, updateAgentDependencyPlanIntent, forgetAgentDependencyPlanIntent,
} from "./agent-dependency-plan-client";
import "./agent-dependency-plan.css";

const states: Record<AgentDependencyPlanView["state"], string> = {
  waiting_predecessor: "等待采购原操作完成", predecessor_blocked: "前置原操作受阻", ready_to_prepare: "原发票已核对 可明确准备账单",
  preparation_unknown: "后继原准备结果待核对", child_prepared: "财务原命令已准备 尚须确认执行", child_unknown: "财务原执行结果未知",
  succeeded: "财务原账单实际已登记", blocked: "当前协调受阻", cancelled: "协调计划已取消", expired: "协调计划已到期",
};
const blockReasons: Record<NonNullable<AgentDependencyPlanView["blockReason"]>, string> = {
  parent_not_succeeded: "采购前置原操作尚未实际成功 不推断发票已经建立", parent_unavailable: "前置原命令当前不可读取",
  parent_terminal: "前置原命令已结束且没有可用成功结果", permission_denied: "当前领域权限不足 请核对原任务授权",
  source_unavailable: "原采购发票来源当前不可读取", source_changed: "原发票来源已经变化 不改绑今天的依据",
  finance_input_invalid: "真实来源尚不能形成合法财务草稿 请到原业务入口核对", preparation_unresolved: "原准备登记尚未核对 只读取原计划",
  child_unavailable: "后继原命令当前不可读取", cancelled: "协调计划已取消 不推进新的准备", expired: "协调计划已经到期 不生成替代原文",
};
type Identity = { authority: string | null; scope: string | null };
type ReadKind = "workspace" | "page" | "detail" | "parent" | "receipt";
function selectPlan(value: string | null) {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set("agentDependencyPlan", value); else url.searchParams.delete("agentDependencyPlan");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}
function Pair({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
function hasPreparationProof(value: AgentDependencyPlanView) {
  return value.preparationRequestedAt !== null || value.childAgentCommandId !== null;
}
export function AgentDependencyPlanWorkbench({ session }: { session: ErpSessionView }) {
  const access = useErpAccess(), identity = useRef<Identity>({ authority: access.authority, scope: access.preferenceScope });
  identity.current = { authority: access.authority, scope: access.preferenceScope };
  if (!access.authority || access.preferenceScope !== session.tenantId + ":" + session.userId)
    return <section className="agent-dependency-plan" aria-label="跨域依赖计划"><h2><Workflow size={17} />跨域依赖计划</h2><p role="status">正在核对当前本人身份 暂不读取或登记计划</p></section>;
  return <DependencyPlanContent key={access.authority + ":" + access.preferenceScope} identity={identity} />;
}
function DependencyPlanContent({ identity }: { identity: RefObject<Identity> }) {
  const access = useErpAccess(), authority = access.authority!, scope = access.preferenceScope!, params = useSearchParams();
  const canRead = access.can(Permission.WorkflowRead), canRun = access.can(Permission.WorkflowRun);
  const raw = params.get("agentDependencyPlan"), parsed = EntityIdSchema.safeParse(raw);
  const selected = params.getAll("agentDependencyPlan").length === 1 && parsed.success ? parsed.data.toLowerCase() : null;
  const current = useRef({ authority, scope, selected, canRead, canRun });
  current.current = { authority: access.authority ?? "", scope: access.preferenceScope ?? "", selected, canRead, canRun };
  const alive = useRef(true), purged = useRef(false), epoch = useRef(0), denied = useRef(false), actionLock = useRef<symbol | null>(null);
  const sequences = useRef<Record<ReadKind, number>>({ workspace: 0, page: 0, detail: 0, parent: 0, receipt: 0 });
  const controllers = useRef(new Map<ReadKind, AbortController>()), mutationAbort = useRef<AbortController | null>(null);
  const detailRef = useRef<AgentDependencyPlanView | null>(null), verifiedPlans = useRef(new Set<string>());
  const [cleared, setCleared] = useState(false), [readDenied, setReadDenied] = useState(false), [pending, setPending] = useState<"create" | "prepare" | "cancel" | null>(null);
  const [workspace, setWorkspace] = useState<AgentDependencyPlanWorkspace | null>(null), [workspaceReading, setWorkspaceReading] = useState(false), [workspaceError, setWorkspaceError] = useState("");
  const [page, setPage] = useState<AgentDependencyPlanPage | null>(null), [rows, setRows] = useState<AgentDependencyPlanSummary[]>([]), [pageSize, setPageSize] = useState(20), [pageReading, setPageReading] = useState(false), [pageError, setPageError] = useState("");
  const pageRef = useRef<AgentDependencyPlanPage | null>(null); pageRef.current = page;
  const [parentId, setParentId] = useState(""), [parent, setParent] = useState<AgentCommandView | null>(null), [parentReading, setParentReading] = useState(false), [parentError, setParentError] = useState("");
  const parentChoice = useRef(parentId); parentChoice.current = parentId;
  const [dueMode, setDueMode] = useState<"none" | "specified">("none"), [dueInput, setDueInput] = useState(""), [createConfirmed, setCreateConfirmed] = useState(false);
  const [detail, setDetail] = useState<AgentDependencyPlanView | null>(null), [detailReading, setDetailReading] = useState(false), [detailError, setDetailError] = useState(""), [prepareConfirmed, setPrepareConfirmed] = useState(false), [idInput, setIdInput] = useState(raw ?? "");
  const [receipt, setReceipt] = useState<AgentDependencyPlanReceipt | null>(null), [receiptReading, setReceiptReading] = useState<string | null>(null), [receiptError, setReceiptError] = useState(""), [mutationError, setMutationError] = useState("");
  const [intentRevision, setIntentRevision] = useState(0), [intentStore, setIntentStore] = useState<{ scope: string; ownerScope: string; items: AgentDependencyPlanIntent[]; error: string } | null>(null);
  const intentOwner = useRef(""); intentOwner.current = intentStore?.scope === scope ? intentStore.ownerScope : "";
  const valid = useCallback((token = epoch.current) => alive.current && !purged.current && token === epoch.current
    && identity.current.authority === authority && identity.current.scope === scope && current.current.authority === authority && current.current.scope === scope, [authority, identity, scope]);
  const readable = useCallback(() => valid() && current.current.canRead && !denied.current, [valid]);
  const abortReads = useCallback(() => {
    for (const controller of controllers.current.values()) controller.abort(); controllers.current.clear();
    for (const kind of Object.keys(sequences.current) as ReadKind[]) sequences.current[kind]++;
  }, []);
  const clearPrivate = useCallback(() => {
    abortReads(); mutationAbort.current?.abort(); detailRef.current = null; verifiedPlans.current.clear();
    setWorkspace(null); setParent(null); setParentId(""); setRows([]); setPage(null); pageRef.current = null;
    setDetail(null); setReceipt(null); setDueInput(""); setDueMode("none"); setIdInput(""); setCreateConfirmed(false); setPrepareConfirmed(false);
    setWorkspaceReading(false); setParentReading(false); setPageReading(false); setDetailReading(false); setReceiptReading(null);
  }, [abortReads]);
  const deny = useCallback(() => { denied.current = true; epoch.current++; clearPrivate(); setReadDenied(true); setPending(null); }, [clearPrivate]);
  useLayoutEffect(() => {
    alive.current = true;
    const clear = () => { purged.current = true; epoch.current++; actionLock.current = null; clearPrivate(); setIntentStore(null); setPending(null); setMutationError(""); setWorkspaceError(""); setParentError(""); setPageError(""); setDetailError(""); setReceiptError(""); setCleared(true); };
    window.addEventListener(AGENT_DEPENDENCY_PLAN_CLEAR_EVENT, clear);
    return () => { alive.current = false; epoch.current++; abortReads(); mutationAbort.current?.abort(); window.removeEventListener(AGENT_DEPENDENCY_PLAN_CLEAR_EVENT, clear); };
  }, [abortReads, clearPrivate]);
  const beginRead = useCallback((kind: ReadKind) => {
    const token = epoch.current, sequence = ++sequences.current[kind], controller = new AbortController();
    controllers.current.get(kind)?.abort(); controllers.current.set(kind, controller);
    return { signal: controller.signal, isCurrent: () => valid(token) && readable() && !controller.signal.aborted && sequences.current[kind] === sequence };
  }, [readable, valid]);
  useEffect(() => {
    const reload = () => setIntentRevision(value => value + 1);
    window.addEventListener(AGENT_DEPENDENCY_PLAN_INTENT_EVENT, reload); window.addEventListener("storage", reload);
    return () => { window.removeEventListener(AGENT_DEPENDENCY_PLAN_INTENT_EVENT, reload); window.removeEventListener("storage", reload); };
  }, []);
  useEffect(() => {
    const token = epoch.current; let cancelled = false;
    void agentTransportTextHash(scope).then(ownerScope => {
      if (cancelled || !valid(token)) return;
      try { setIntentStore({ scope, ownerScope, items: readAgentDependencyPlanIntents(ownerScope), error: "" }); }
      catch (error) { setIntentStore({ scope, ownerScope, items: [], error: agentDependencyPlanError(error) }); }
    }).catch(() => { if (!cancelled && valid(token)) setIntentStore({ scope, ownerScope: "", items: [], error: "本人原请求摘要暂不可核对 不提交新的计划" }); });
    return () => { cancelled = true; };
  }, [scope, intentRevision, valid]);
  const loadWorkspace = useCallback(async () => {
    if (!readable() || actionLock.current) return; const options = beginRead("workspace"); setWorkspaceReading(true); setWorkspace(null); setWorkspaceError(""); setCreateConfirmed(false);
    try { const value = await readAgentDependencyPlanWorkspace(authority, options); if (options.isCurrent()) setWorkspace(value); }
    catch (error) { if (options.isCurrent()) { if (agentDependencyPlanDenied(error)) deny(); else setWorkspaceError(agentDependencyPlanError(error)); } }
    finally { if (options.isCurrent()) setWorkspaceReading(false); }
  }, [authority, beginRead, deny, readable]);
  const loadPage = useCallback(async (next = false) => {
    if (!readable() || actionLock.current) return;
    const previous = pageRef.current;
    if (next && (!previous?.hasMore || !previous.upperId || !previous.nextBefore)) return;
    const options = beginRead("page"); setPageReading(true); setPageError("");
    if (!next) { setRows([]); setPage(null); pageRef.current = null; }
    try {
      const value = await readAgentDependencyPlanPage({ limit: pageSize, ...(next ? { upperId: previous!.upperId!, before: previous!.nextBefore! } : {}) }, authority, options);
      if (!options.isCurrent()) return;
      setRows(prior => next ? [...prior, ...value.items] : value.items); pageRef.current = value; setPage(value);
    } catch (error) { if (options.isCurrent()) { if (agentDependencyPlanDenied(error)) deny(); else setPageError(agentDependencyPlanError(error)); } }
    finally { if (options.isCurrent()) setPageReading(false); }
  }, [authority, beginRead, deny, pageSize, readable]);
  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);
  useEffect(() => { void loadPage(); }, [loadPage]);
  useEffect(() => {
    const options = beginRead("parent"); setParent(null); setParentError(""); setCreateConfirmed(false); setParentReading(false);
    if (!parentId || !readable() || !workspace?.parents.some(candidate => candidate.id === parentId)) return;
    setParentReading(true);
    void readAgentOperationRequest(parentId, authority, options.signal).then(value => {
      if (!options.isCurrent() || parentChoice.current !== parentId) return;
      if (value.domain !== "procurement" || value.kind !== "invoice_record") throw new AgentDependencyPlanRequestError(502, "原候选不是采购发票命令 不使用替代业务对象");
      setParent(value);
    }).catch(error => { if (options.isCurrent()) { if (agentOperationDenied(error) || agentDependencyPlanDenied(error)) deny(); else setParentError(agentDependencyPlanError(error)); } })
      .finally(() => { if (options.isCurrent()) setParentReading(false); });
    return () => { controllers.current.get("parent")?.abort(); };
  }, [authority, beginRead, deny, parentId, readable, workspace]);
  const remember = useCallback((value: AgentDependencyPlanView) => {
    if (!intentOwner.current) return;
    const marker = readAgentDependencyPlanIntents(intentOwner.current).find(item => item.requestId === value.requestId);
    if (!marker) return;
    if (marker.requestChecksum !== value.requestChecksum || marker.planId !== null && marker.planId !== value.id)
      throw new AgentDependencyPlanRequestError(502, "原计划与已保存标识不一致 不采用替代回执");
    const resolved = marker.state === "prepare_unknown" ? hasPreparationProof(value)
      : marker.state === "cancel_unknown" ? value.cancelledAt !== null : true;
    if (resolved && (marker.state !== "known" || marker.planId !== value.id))
      updateAgentDependencyPlanIntent({ ...marker, planId: value.id, state: "known" });
  }, []);
  const loadDetail = useCallback(async (planId: string) => {
    if (!readable() || actionLock.current || current.current.selected !== planId) return;
    const options = beginRead("detail"); setDetailReading(true); setDetailError(""); setPrepareConfirmed(false); setDetail(null); detailRef.current = null;
    try {
      const value = await readAgentDependencyPlan(planId, authority, options);
      if (!options.isCurrent() || current.current.selected !== planId) return;
      if (value.parentAgentCommandId === parentChoice.current
        && (value.parent.state === "unavailable" || value.blockReason === "permission_denied")) {
        sequences.current.parent++; controllers.current.get("parent")?.abort();
        setParent(null); setCreateConfirmed(false); setParentReading(false);
        setParentError("所选前置来源当前不可读取 原正文已隐藏 请重新读取依赖计划契约后核对该原命令 ID");
      }
      remember(value); verifiedPlans.current.add(value.id); detailRef.current = value; setDetail(value);
    } catch (error) { if (options.isCurrent()) { if (agentDependencyPlanDenied(error)) deny(); else setDetailError(agentDependencyPlanError(error)); } }
    finally { if (options.isCurrent()) setDetailReading(false); }
  }, [authority, beginRead, deny, readable, remember]);
  useEffect(() => {
    sequences.current.detail++; controllers.current.get("detail")?.abort(); detailRef.current = null; setDetail(null); setDetailError(""); setPrepareConfirmed(false); setDetailReading(false);
    if (selected) { setIdInput(selected); void loadDetail(selected); }
  }, [loadDetail, selected]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible" && navigator.onLine !== false && selected && !actionLock.current) void loadDetail(selected); };
    window.addEventListener("focus", refresh); window.addEventListener("pageshow", refresh);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("pageshow", refresh); };
  }, [loadDetail, selected]);
  const detailState = detail?.state;
  useEffect(() => {
    if (!selected || !detailState || !["waiting_predecessor", "preparation_unknown", "child_unknown"].includes(detailState)) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible" && navigator.onLine !== false && !actionLock.current) void loadDetail(selected); }, 6000);
    return () => clearInterval(timer);
  }, [detailState, selected, loadDetail]);
  useEffect(() => {
    if (!detail?.privateAvailable) return;
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      const remaining = Date.parse(detail.expiresAt) - Date.now();
      if (remaining > 0) { timer = setTimeout(expire, Math.min(remaining, 2_147_483_647)); return; }
      if (valid() && detailRef.current?.id === detail.id) {
        const value = { ...detail, privateAvailable: false, source: null, childDraft: null, canPrepare: false };
        detailRef.current = value; setDetail(value); setPrepareConfirmed(false);
      }
    }; expire(); return () => clearTimeout(timer);
  }, [detail, valid]);
  function open(planId: string | null) {
    if (planId === null) {
      sequences.current.detail++; controllers.current.get("detail")?.abort(); current.current.selected = null;
      detailRef.current = null; setDetail(null); setPrepareConfirmed(false); setMutationError(""); setDetailReading(false);
      selectPlan(null); return;
    }
    if (!readable() || actionLock.current) return;
    sequences.current.detail++; controllers.current.get("detail")?.abort(); detailRef.current = null; setDetail(null); setPrepareConfirmed(false); setMutationError("");
    if (planId && current.current.selected === planId) void loadDetail(planId); else selectPlan(planId);
  }
  const stored = intentStore?.scope === scope ? intentStore : null, intents = stored?.items ?? [], storageReady = Boolean(stored?.ownerScope && !stored.error);
  const unresolved = intents.some(marker => marker.state !== "known"), parentReady = Boolean(parent && parent.id === parentId && workspace?.parents.some(item => item.id === parentId));
  const canCreate = readable() && canRun && workspace?.canCreate && storageReady && !unresolved && parentReady && !parentReading && !workspaceReading && !pending;
  async function create() {
    if (!canCreate || !createConfirmed || actionLock.current || !parent) return;
    const lease = Symbol("dependency-create"), token = epoch.current, abort = new AbortController(); actionLock.current = lease; mutationAbort.current = abort; setPending("create"); setMutationError(""); setCreateConfirmed(false);
    try {
      const dueAt = dueMode === "none" ? null : dueInput && Number.isFinite(Date.parse(dueInput)) ? new Date(dueInput).toISOString() : undefined;
      const input = CreateAgentDependencyPlanSchema.safeParse({ version: AGENT_DEPENDENCY_PLAN_VERSION, kind: AGENT_DEPENDENCY_PLAN_KIND, requestId: crypto.randomUUID(), parentAgentCommandId: parent.id, dueAt });
      if (!input.success) throw new AgentDependencyPlanRequestError(400, "请明确不指定到期时间 或填写有效的本机时区到期时间");
      const prepared = await prepareAgentDependencyPlanIntent(input.data, scope); if (!valid(token) || !readable() || !current.current.canRun) return;
      saveAgentDependencyPlanIntent(prepared.intent); const marker = updateAgentDependencyPlanIntent({ ...prepared.intent, state: "unknown" });
      if (!valid(token) || !readable() || !current.current.canRun) return;
      const value = await createAgentDependencyPlan(prepared.input, authority, { signal: abort.signal, isCurrent: () => valid(token) && readable() });
      if (!valid(token) || !readable()) return;
      updateAgentDependencyPlanIntent({ ...marker, planId: value.id, state: "known" }); setParentId(""); setParent(null); setDueInput(""); setDueMode("none"); selectPlan(value.id);
    } catch (error) { if (valid(token)) { if (agentDependencyPlanDenied(error)) deny(); setMutationError(agentDependencyPlanError(error)); } }
    finally { if (actionLock.current === lease) { actionLock.current = null; if (valid(token)) { setPending(null); setIntentRevision(value => value + 1); } } }
  }
  async function recover(marker: AgentDependencyPlanIntent) {
    if (!readable() || actionLock.current || receiptReading) return;
    const options = beginRead("receipt"); setReceiptReading(marker.requestId); setReceipt(null); setReceiptError("");
    try {
      const value = await readAgentDependencyPlanReceipt({ requestId: marker.requestId, requestChecksum: marker.requestChecksum }, authority, options);
      if (!options.isCurrent()) return;
      if (value.disposition === "known") {
        if (marker.planId !== null && marker.planId !== value.id) throw new AgentDependencyPlanRequestError(502, "原回执与已保存计划 ID 不一致");
        if (marker.planId === null || marker.state === "known") updateAgentDependencyPlanIntent({ ...marker, planId: value.id, state: "known" });
      }
      setReceipt(value);
    } catch (error) { if (options.isCurrent()) { if (agentDependencyPlanDenied(error)) deny(); else setReceiptError(agentDependencyPlanError(error)); } }
    finally { if (options.isCurrent()) setReceiptReading(null); }
  }
  async function act(action: "prepare" | "cancel") {
    const value = detailRef.current;
    if (!value || value.id !== selected || !readable() || !current.current.canRun || actionLock.current || detailReading || !storageReady || unresolved
      || action === "prepare" && (!prepareConfirmed || !value.privateAvailable || !value.canPrepare || !value.source || value.preparationRequestedAt !== null || Date.parse(value.expiresAt) <= Date.now())
      || action === "cancel" && !value.canCancel) return;
    if (action === "cancel" && !window.confirm("取消这笔协调计划\n" + value.id + "\n不会撤销已经登记的采购或财务事实 请分别核对原命令")) return;
    const lease = Symbol("dependency-action"), token = epoch.current, abort = new AbortController(); actionLock.current = lease; mutationAbort.current = abort; setPending(action); setMutationError(""); setPrepareConfirmed(false);
    try {
      const existing = readAgentDependencyPlanIntents(stored!.ownerScope).find(marker => marker.requestId === value.requestId);
      const marker = existing ?? saveAgentDependencyPlanIntent(AgentDependencyPlanIntentSchema.parse({ version: 1, ownerScope: stored!.ownerScope, requestId: value.requestId, requestChecksum: value.requestChecksum, planId: null, state: "prepared", createdAt: value.createdAt }));
      updateAgentDependencyPlanIntent({ ...marker, planId: value.id, state: action === "prepare" ? "prepare_unknown" : "cancel_unknown" });
      if (!valid(token) || !readable() || !current.current.canRun) return;
      const result = await actOnAgentDependencyPlan(value, action, authority, { signal: abort.signal, isCurrent: () => valid(token) && readable() });
      if (!valid(token) || !readable() || current.current.selected !== value.id) return;
      remember(result); detailRef.current = result; setDetail(result); verifiedPlans.current.add(result.id);
    } catch (error) { if (valid(token)) { if (agentDependencyPlanDenied(error)) deny(); setMutationError(agentDependencyPlanError(error)); } }
    finally { if (actionLock.current === lease) { actionLock.current = null; if (valid(token)) { setPending(null); setIntentRevision(value => value + 1); } } }
  }
  function forget(marker: AgentDependencyPlanIntent) {
    if (!readable() || actionLock.current || !marker.planId || !verifiedPlans.current.has(marker.planId)) return;
    try { forgetAgentDependencyPlanIntent(marker); setReceipt(null); } catch (error) { setReceiptError(agentDependencyPlanError(error)); }
  }
  function commandHref(commandId: string, planId: string) { const query = new URLSearchParams(params.toString()); query.set("agentDependencyPlan", planId); query.set("agentCommand", commandId); return "/ai-tasks?" + query.toString(); }
  if (cleared) return <section className="agent-dependency-plan" aria-label="跨域依赖计划"><h2><Workflow size={17} />跨域依赖计划</h2><p role="status">本人会话已清除 原计划和草稿已隐藏 迟到响应不重建恢复标识</p></section>;
  const visible = readable() && detail?.id === selected ? detail : null;
  const shown = visible && Date.parse(visible.expiresAt) <= Date.now() ? { ...visible, privateAvailable: false, source: null, childDraft: null, canPrepare: false } : visible;
  const prepareAvailable = Boolean(shown?.canPrepare && shown.privateAvailable && shown.preparationRequestedAt === null && shown.state === "ready_to_prepare" && !unresolved);
  return <section className="agent-dependency-plan" aria-label="跨域依赖计划">
    <header className="adp-heading"><div><h2><Workflow size={17} />跨域依赖计划</h2><p className="adp-muted">采购实际发票 → 财务应付账单 前项必须有原拥有者成功回执 后项另行准备并明确确认执行</p></div><button type="button" disabled={!readable() || workspaceReading || Boolean(pending)} onClick={() => void loadWorkspace()}><RefreshCw size={14} />重新读取依赖计划契约</button></header>
    <p className="adp-notice">本入口不调用模型 不派发队列 读取不推进准备或执行 财务账单登记不等于付款或银行转账</p>
    {(!canRead || readDenied) && <p role="status" className="adp-warning">当前无法读取本人计划 原来源和草稿已隐藏 请核对工作流及原领域权限</p>}
    {workspaceReading && <p role="status">正在读取真实前置命令候选与当前准入</p>}{workspaceError && <p role="alert" className="adp-error">{workspaceError}</p>}
    <section aria-label="本人依赖计划原请求恢复" className="adp-section"><h3><FileSearch size={15} />本人依赖计划原请求恢复</h3><p className="adp-muted">只保存七项本人标量标识 不保存发票号 金额 来源正文 草稿或确认凭据 未知提交只读恢复</p>
      {!stored && <p role="status">正在核对本人原请求标识</p>}{stored?.error && <p role="alert" className="adp-error">{stored.error}</p>}{storageReady && !intents.length && <p>本标签页暂无原计划恢复标识 可从下方本人原计划目录读取</p>}
      {intents.map(marker => <article className="adp-intent" key={marker.requestId} aria-label={"原依赖计划请求 " + marker.requestId}><p>原请求 <code>{marker.requestId}</code></p><p>{marker.state === "known" ? "已知原计划 仍须读取实际状态" : marker.state === "prepare_unknown" ? "原后继准备结果待核对 只读取实际准备凭据 不重复提交" : marker.state === "cancel_unknown" ? "原取消结果待核对 只读取实际取消凭据 不用旧准备证明取消" : "原计划登记结果待核对 不换键或重复提交"}</p><dl className="adp-pairs"><Pair label="原请求校验值"><code>{marker.requestChecksum}</code></Pair><Pair label="原计划 ID"><code>{marker.planId ?? "尚未取得"}</code></Pair></dl><div className="adp-actions"><button type="button" disabled={!readable() || Boolean(pending) || Boolean(receiptReading)} onClick={() => void recover(marker)}>只读取原计划回执</button>{marker.planId && <button type="button" disabled={!readable() || Boolean(pending)} onClick={() => open(marker.planId)}>读取原协调计划</button>}{marker.state === "known" && marker.planId && verifiedPlans.current.has(marker.planId) && <button type="button" disabled={!readable() || Boolean(pending)} onClick={() => forget(marker)}>结束本次已读计划核对</button>}</div></article>)}
      {receiptReading && <p role="status">正在只读核对原请求回执</p>}{receiptError && <p role="alert" className="adp-error">{receiptError}</p>}{receipt && <section className="adp-receipt" aria-label="已找回的原依赖计划回执"><h4>原请求回执</h4><code>{receipt.requestId}</code>{receipt.disposition === "not_found" ? <p className="adp-warning">尚未找到原回执 不等于请求未提交 不忘记原键 不登记替代计划</p> : <><p>原计划 <code>{receipt.id}</code> 回执存在不证明后继准备或业务已执行</p><button type="button" disabled={!readable() || Boolean(pending)} onClick={() => open(receipt.id)}>读取找回的原计划</button></>}</section>}
    </section>
    {readable() && <details className="adp-section"><summary>登记采购发票到财务账单计划</summary><form aria-label="登记跨域依赖计划" onSubmit={event => { event.preventDefault(); void create(); }}><fieldset disabled={!workspace?.canCreate || !canRun || !storageReady || unresolved || Boolean(pending) || workspaceReading}>
      <label>真实前置采购发票原命令<select aria-label="真实前置采购发票原命令" value={parentId} onChange={event => { setParent(null); setCreateConfirmed(false); setParentId(event.target.value); }} required><option value="">选择本人真实原命令</option>{workspace?.parents.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.createdAt} · {candidate.id}</option>)}</select></label>
      {workspace && <p className="adp-muted">近期最多 {workspace.parentLimit} 个本人采购发票命令{workspace.parentHasMore ? " 仍有更早命令 当前候选不是完整集合" : " 不把候选数量当作全部业务"} 可先到原采购入口核对准备 不输入虚构业务 ID</p>}
      {parentReading && <p role="status">正在读取所选原采购命令实际状态</p>}{parentError && <p role="alert" className="adp-error">{parentError}</p>}
      {parent && parent.id === parentId && <section className="adp-parent" aria-label="已选前置原命令"><h4>已选采购发票原命令</h4><p>{agentOperationStateNames[parent.state]}</p><code>{parent.id}</code>{parent.snapshot && <details><summary>核对原命令真实业务回执</summary><AgentOperationNativeSummary snapshot={parent.snapshot} /></details>}<p className="adp-muted">前置尚未成功时只登记等待关系 不把计划登记当作实际发票出生</p></section>}
      <div className="adp-fields"><label>后继账单到期时间<select aria-label="后继账单到期时间" value={dueMode} onChange={event => { setDueMode(event.target.value === "specified" ? "specified" : "none"); setDueInput(""); setCreateConfirmed(false); }}><option value="none">明确不指定到期时间</option><option value="specified">明确填写到期时间</option></select></label>{dueMode === "specified" && <label>账单到期时间 本机时区<input aria-label="账单到期时间 本机时区" type="datetime-local" step="1" required value={dueInput} onChange={event => { setDueInput(event.target.value); setCreateConfirmed(false); }} /></label>}</div>
      <label className="adp-confirm"><input type="checkbox" checked={createConfirmed} onChange={event => setCreateConfirmed(event.target.checked)} />已核对真实前置命令及到期时间 只登记协调计划 不执行业务</label><button type="submit" className="adp-primary" disabled={!canCreate || !createConfirmed}><Link2 size={14} />登记两步协调计划</button>
    </fieldset></form>{workspace && !workspace.canCreate && <p className="adp-warning">服务器当前未允许登记此类计划 请核对原采购 财务和工作流权限 原回执读取保持独立</p>}</details>}
    {pending && <p role="status">{pending === "create" ? "正在登记固定原计划" : pending === "prepare" ? "正在保存后继财务原准备 不执行业务" : "正在取消原协调计划"} 原请求标识已保存 不重复发送</p>}{mutationError && <p role="alert" className="adp-error">{mutationError}</p>}
    {readable() && <section className="adp-section" aria-label="本人原依赖计划目录"><header><h3>本人原依赖计划目录</h3><div className="adp-actions"><label>计划每页条数<select aria-label="计划每页条数" value={pageSize} disabled={pageReading || Boolean(pending)} onChange={event => setPageSize(event.target.value === "50" ? 50 : 20)}><option value={20}>20</option><option value={50}>50</option></select></label><button type="button" disabled={pageReading || Boolean(pending)} onClick={() => void loadPage()}><RefreshCw size={14} />重读本人计划目录</button></div></header>
      <form className="adp-id-form" onSubmit={event => { event.preventDefault(); const result = EntityIdSchema.safeParse(idInput.trim()); if (result.success) open(result.data.toLowerCase()); else setPageError("请填写真实有效的原计划 ID"); }}><label>已知原计划 ID<input aria-label="已知原计划 ID" value={idInput} onChange={event => setIdInput(event.target.value)} /></label><button type="submit" disabled={Boolean(pending)}>按原计划 ID 读取</button></form>
      {pageReading && <p role="status">正在读取本人原计划分页</p>}{pageError && <p role="alert" className="adp-error">{pageError}</p>}{page && <p className="adp-muted">当前固定 ID 范围已读取 {rows.length} 条 · {page.hasMore ? "还有更早原计划 可继续读取" : "本次固定范围已读尽 不包含之后新登记的计划"}</p>}
      <ol className="adp-directory">{rows.map(row => <li key={row.id}><button type="button" disabled={Boolean(pending)} onClick={() => open(row.id)}><span>采购发票 → 财务账单 · {row.createdAt}</span><code>{row.id}</code><small>前置原命令 {row.parentAgentCommandId}</small></button></li>)}</ol>{page && !rows.length && <p>本次本人原计划范围没有返回记录</p>}{page?.hasMore && <button type="button" disabled={pageReading || Boolean(pending)} onClick={() => void loadPage(true)}>继续读取更早原计划</button>}
    </section>}
    {raw && !selected && <p role="alert" className="adp-error">网址中的原计划 ID 无效 未读取替代记录</p>}
    {selected && <TaskDrawer title="核对跨域依赖计划" description="真实前置回执与固定后继草稿 准备和执行分开" recordKey={selected} className="agent-dependency-plan-drawer" state={{ dirty: false, busy: Boolean(pending), loading: detailReading }} contentUnavailable={!readable()} onClose={() => open(null)} closeLabel="关闭依赖计划核对">
      <section className="agent-dependency-plan adp-detail" aria-label="跨域依赖计划详情" aria-busy={detailReading}><header><h3>原两步协调计划</h3><button type="button" disabled={!readable() || detailReading || Boolean(pending)} onClick={() => void loadDetail(selected)}><RefreshCw size={14} />只重新读取原计划</button></header><p>原计划 <code>{selected}</code></p><p className="adp-muted">关闭只收起详情 不取消计划 不撤销原命令或已经登记的事实</p>
        {detailReading && <p role="status">正在读取原依赖及真实业务回执 不准备或执行</p>}{detailError && <p role="alert" className="adp-error">{detailError}</p>}{mutationError && <p role="alert" className="adp-error">{mutationError}</p>}
        {shown && <><p className="adp-state" role="status">{states[shown.state]}</p>{shown.blockReason && <p className="adp-warning">{blockReasons[shown.blockReason]}</p>}
          <ol className="adp-steps" aria-label="两步实际原业务状态"><li><h4><span>1</span>采购实际发票</h4><p>{agentOperationStateNames[shown.parent.state]}</p><dl className="adp-pairs"><Pair label="原 Agent 操作"><code>{shown.parent.agentCommandId}</code></Pair><Pair label="原采购命令"><code>{shown.parent.ownerCommandId ?? "尚未取得"}</code></Pair><Pair label="实际发票结果"><code>{shown.parent.resultId ?? "尚无原成功凭据"}</code></Pair></dl><Link href={commandHref(shown.parent.agentCommandId, shown.id)}>核对前置原采购操作<ArrowRight size={14} /></Link></li><li><h4><span>2</span>财务应付账单</h4><p>{shown.child ? agentOperationStateNames[shown.child.state] : "尚未取得后继原命令 不推断账单已经登记"}</p><dl className="adp-pairs"><Pair label="原 Agent 操作"><code>{shown.childAgentCommandId ?? "尚未取得"}</code></Pair><Pair label="原财务命令"><code>{shown.childOwnerCommandId ?? "尚未取得"}</code></Pair><Pair label="实际账单结果"><code>{shown.child?.resultId ?? "尚无原成功凭据"}</code></Pair></dl>{shown.childAgentCommandId && <Link href={commandHref(shown.childAgentCommandId, shown.id)}>核对后继原财务操作<ArrowRight size={14} /></Link>}</li></ol>
          {shown.source && shown.privateAvailable ? <section className="adp-source" aria-label="真实采购发票来源"><h4>真实采购发票来源</h4><dl className="adp-pairs"><Pair label="实际发票号">{shown.source.invoiceNumber}</Pair><Pair label="原金额与币种">{formatFinanceMinorAmount(shown.source.totalMinor, shown.source.currency)}</Pair><Pair label="原金额最小单位">{shown.source.totalMinor} · {shown.source.currency}</Pair><Pair label="原开具时间">{shown.source.issuedAt}</Pair><Pair label="原到期时间">{shown.dueAt ?? "原请求明确未指定"}</Pair><Pair label="原发票 ID"><code>{shown.source.invoiceId}</code></Pair><Pair label="原采购单 / 版本"><code>{shown.source.purchaseOrderId}</code><br /><code>{shown.source.purchaseOrderVersionId}</code></Pair><Pair label="采购实际凭据"><code>{shown.source.procurementProofId}</code></Pair><Pair label="原供应商"><code>{shown.source.supplierId}</code></Pair><Pair label="原来源校验值"><code>{shown.source.sourceChecksum}</code></Pair></dl></section> : <p className="adp-warning">原发票来源尚未可读或已到期 未提供的金额和版本保持未知 不从当前列表补造历史</p>}
          {shown.childDraft && shown.privateAvailable && <details className="adp-source"><summary>核对固定后继财务草稿</summary><p className="adp-warning">这是根据实际原发票形成的固定准备草稿 尚未等于原业务命令或财务账单登记 不付款或转账</p><FixedBillDraft value={shown.childDraft} /></details>}
          {unresolved && <p className="adp-warning">本人仍有原操作结果待核对 只读取原计划 准备须取得实际准备凭据 取消须取得实际取消凭据 不用旧准备或业务成功代替取消证明</p>}
          {prepareAvailable && <label className="adp-confirm"><input type="checkbox" checked={prepareConfirmed} disabled={!canRun || Boolean(pending) || detailReading || !storageReady} onChange={event => setPrepareConfirmed(event.target.checked)} />已核对真实发票来源与固定账单草稿 只保存后继原准备 不执行业务</label>}
          <div className="adp-actions">{prepareAvailable && <button type="button" className="adp-primary" disabled={!prepareConfirmed || !canRun || Boolean(pending) || detailReading || !storageReady} onClick={() => void act("prepare")}><Check size={14} />保存后继财务原准备</button>}{shown.canCancel && <button type="button" disabled={!canRun || Boolean(pending) || detailReading || !storageReady || unresolved} onClick={() => void act("cancel")}><Square size={13} />取消此协调计划</button>}</div>
          <details><summary>原计划身份与准备凭据</summary><dl className="adp-pairs"><Pair label="原请求 ID"><code>{shown.requestId}</code></Pair><Pair label="原请求校验值"><code>{shown.requestChecksum}</code></Pair><Pair label="固定后继请求 ID"><code>{shown.childRequestId}</code></Pair><Pair label="原准备请求校验"><code>{shown.childPreparationRequestChecksum ?? "尚未登记"}</code></Pair><Pair label="固定后继原文校验"><code>{shown.childOriginalChecksum ?? "尚未登记"}</code></Pair><Pair label="实际准备登记时间">{shown.preparationRequestedAt ?? "尚无凭据 不证明未知请求从未提交"}</Pair><Pair label="原资料保留至">{shown.expiresAt}</Pair></dl></details><p className="adp-muted">前置与后继的执行都在原业务核对入口完成 依赖计划不代为确认 不把模型或界面状态当作业务成功</p>
        </>}
      </section>
    </TaskDrawer>}
  </section>;
}

function FixedBillDraft({ value }: { value: NonNullable<AgentDependencyPlanView["childDraft"]> }) {
  const input = value.command.input;
  return <dl className="adp-pairs"><Pair label="准备动作">登记应付账单 · 采购实际发票</Pair><Pair label="固定原目标">新建账单 尚未执行</Pair>
    <Pair label="账单编号">{input.externalBillId}</Pair><Pair label="供应商 ID"><code>{input.supplierId}</code></Pair>
    <Pair label="采购发票 ID"><code>{input.procurementInvoiceId}</code></Pair><Pair label="金额与币种">{formatFinanceMinorAmount(input.amountMinor, input.currency)}</Pair>
    <Pair label="原金额最小单位">{input.amountMinor} · {input.currency}</Pair><Pair label="开具时间">{input.issuedAt}</Pair><Pair label="到期时间">{input.dueAt ?? "明确未指定"}</Pair>
    <Pair label="固定原准备请求键"><code>{input.idempotencyKey}</code></Pair></dl>;
}
