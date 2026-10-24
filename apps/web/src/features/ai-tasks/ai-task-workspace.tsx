"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, FileSearch, History, Plus, RefreshCw } from "lucide-react";
import { AssistViewSchema, type AssistKind, type AssistView } from "@yummyai/contracts/ai/assist";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { requiredAssistPermissions } from "@yummyai/authz/assist-policy";
import { Permission } from "@yummyai/authz/permissions";
import {
  ASSIST_TASKS,
  assistTaskHref,
  AssistTaskBasisSchema,
  AssistTaskWorkspaceSchema,
  type AssistTaskBasis,
  type AssistTaskWorkspace,
} from "@yummyai/contracts/ai/task-workspace";
import { AssistPanel } from "../ai-assist/assist-panel";
import { MethodEvidence } from "../ai-assist/method-evidence";
import { TaskWorkspaceNav } from "../business-tasks/task-workspace-nav";
import { assistApi, assistReadDenied, AssistRequestError, sameAssistInput } from "../ai-assist/assist-client";
import { mergeAssistTargetPage, type AssistTargetCollection } from "./task-target-page-client";
import { ErpIdentityContext, useErpAccess } from "../identity/erp-access";
import { AssistRequestRecovery } from "../ai-assist/assist-request-recovery";
import { AgentReadTools } from "./agent-read-tools";
import { AgentLoopWorkbench } from "./agent-loop-workbench";
import { AgentOperationWorkbench } from "./agent-operation-workbench";
import { AgentFulfillmentCommandWorkbench, hasAgentFulfillmentCommandSelection } from "./agent-fulfillment-command-workbench";
import { AgentPlanWorkbench } from "./agent-plan-workbench";
import { AgentDependencyPlanWorkbench } from "./agent-dependency-plan";
import { AgentNativeTaskVersions } from "./agent-native-task-versions";
import { AgentFulfillmentEntry } from "./agent-fulfillment-entry";
import { AgentToolBrowser } from "./agent-tool-browser";
import { AgentMcpConnection } from "./agent-mcp-connection";
import { AgentResourceBrowser } from "./agent-resource-browser";
import "./ai-task-workspace.css";

export const taskStatus = {
  queued: "排队中",
  running: "运行中",
  completed: "分析完成",
  failed: "需要处理",
  cancelled: "已取消",
} as const;
const emptyWorkspace: AssistTaskWorkspace = {
  capabilities: [],
  items: [],
  page: 1,
  hasMore: false,
};
const dateTime = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
export function AiTaskWorkspace() {
  const access = useErpAccess();
  if (!access.authority) return <main className="ai-task-workspace"><h1>AI 任务工作台</h1><p role="status">当前本人身份尚未核对 原任务与填写已隐藏</p></main>;
  return <AssistTaskWorkspace key={access.authority} />;
}
function AssistTaskWorkspace() {
  const access = useErpAccess(), authority = access.authority!;
  const identity = useContext(ErpIdentityContext);
  const alive = useRef(true), privateBlocked = useRef(false), purged = useRef(false);
  const authorizationEpoch = useRef(0), workspaceSequence = useRef(0);
  // This instance reads metadata and task basis only; model submissions remain owned by AssistPanel.
  const readControllers = useRef(new Set<AbortController>());
  const api = useCallback(async <T,>(path: string, input?: unknown, signal?: AbortSignal): Promise<T> => {
    if (!alive.current || privateBlocked.current || purged.current || signal?.aborted) throw new DOMException("当前读取已停止", "AbortError");
    const epoch = authorizationEpoch.current, controller = new AbortController();
    readControllers.current.add(controller);
    try {
      const value = await assistApi<T>(path, input, AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]), authority);
      if (!alive.current || privateBlocked.current || purged.current || controller.signal.aborted || signal?.aborted || epoch !== authorizationEpoch.current)
        throw new DOMException("当前读取已停止", "AbortError");
      return value;
    } finally { readControllers.current.delete(controller); }
  }, [authority]);
  const [privateDenied, setPrivateDenied] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const search = useSearchParams(),
    router = useRouter();
  const [workspace, setWorkspace] = useState(emptyWorkspace),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [page, setPage] = useState(1),
    [status, setStatus] = useState(""),
    [filterKind, setFilterKind] = useState("");
  const [kind, setKind] = useState<AssistKind>("order_review"),
    [targetId, setTargetId] = useState(""),
    [query, setQuery] = useState(""),
    [goal, setGoal] = useState("");
  const [storedTargets, setTargets] = useState<AssistTargetCollection | null>(null),
    [targetRefresh, setTargetRefresh] = useState(0),
    [targetsLoading, setTargetsLoading] = useState(false),
    [targetError, setTargetError] = useState("");
  const [storedBasis, setBasis] = useState<AssistTaskBasis | null>(null),
    [basisBusy, setBasisBusy] = useState(false),
    [basisError, setBasisError] = useState("");
  const [storedSelected, setSelected] = useState<AssistView | null>(null),
    [selectedBusy, setSelectedBusy] = useState(false),
    [selectedError, setSelectedError] = useState("");
  const selectedId = search.get("run") ?? "";
  const selected = storedSelected?.id === selectedId ? storedSelected : null;
  const [newRun, setNewRun] = useState<AssistView | null>(null);
  const basisController = useRef<AbortController | null>(null);
  const targetController = useRef<AbortController | null>(null), targetSequence = useRef(0), targetPending = useRef(false);
  const targetQueryKey = JSON.stringify({ kind, q: query.trim(), pageSize: 40 });
  const currentTargetQuery = useRef(targetQueryKey); currentTargetQuery.current = targetQueryKey;
  const targetCollection = storedTargets && storedTargets.contextAuthority === authority && JSON.stringify(storedTargets.query) === targetQueryKey ? storedTargets : null;
  const targets = targetCollection?.items ?? [];
  const abortReads = useCallback(() => {
    authorizationEpoch.current++;
    workspaceSequence.current++;
    for (const controller of readControllers.current) controller.abort();
    readControllers.current.clear();
    basisController.current?.abort();
    targetController.current?.abort();
    targetSequence.current++;
    targetPending.current = false;
  }, []);
  const clearRestricted = useCallback((message: string, notifyIdentity = true) => {
    const wasBlocked = privateBlocked.current;
    privateBlocked.current = true;
    abortReads();
    setPrivateDenied(true);
    setWorkspace(emptyWorkspace);
    setSelected(null);
    setNewRun(null);
    setBasis(null);
    setGoal("");
    setTargetId("");
    setQuery("");
    setTargets(null);
    setLoading(false);
    setSelectedBusy(false);
    setBasisBusy(false);
    setTargetsLoading(false);
    setTargetError("");
    setHistoryExpanded(false);
    setSelectedError(message);
    setBasisError(message);
    setError(message);
    if (notifyIdentity && !purged.current && !wasBlocked) window.dispatchEvent(new Event("focus"));
  }, [abortReads]);
  useLayoutEffect(() => {
    alive.current = true;
    const clear = () => {
      purged.current = true;
      clearRestricted("本人会话已清除 原任务与填写已隐藏 迟到响应不会恢复", false);
    };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    return () => { alive.current = false; abortReads(); window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); };
  }, [abortReads, clearRestricted]);
  const selectionKey = JSON.stringify({ kind, targetId, goal });
  const basisKey = useRef("");
  const basis = basisKey.current === selectionKey ? storedBasis : null;
  const currentSelection = useRef(selectionKey);
  currentSelection.current = selectionKey;
  const currentTask = ASSIST_TASKS.find((task) => task.kind === kind)!;
  const capability = workspace.capabilities.find((task) => task.kind === kind);
  // These collection owners require tenant scope for their operational source bits.
  // Catalog owners continue to filter each object by its own owner and asset policy.
  const targetScopeKey = ASSIST_TASKS.filter(task => !["order_review", "artwork_preflight", "business_review", "procurement_review", "after_sales_review"].includes(task.kind) ||
    requiredAssistPermissions(task.kind, "read").filter(bit => bit !== Permission.DesignRead).every(bit => access.canTenant(bit))).map(task => task.kind).join(",");
  const targetScopeAllowed = useCallback((next: AssistKind) => targetScopeKey.split(",").includes(next), [targetScopeKey]);
  const scopeReady = targetScopeAllowed(kind);

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      if (!alive.current || privateBlocked.current || purged.current || signal?.aborted) return;
      const epoch = authorizationEpoch.current,
        request = ++workspaceSequence.current;
      const params = new URLSearchParams({ page: String(page) });
      if (status) params.set("status", status);
      if (filterKind) params.set("kind", filterKind);
      const data = AssistTaskWorkspaceSchema.parse(
        await api(`task-workspace?${params}`, undefined, signal),
      );
      if (
        alive.current && !privateBlocked.current && !signal?.aborted &&
        epoch === authorizationEpoch.current &&
        request === workspaceSequence.current
      ) {
        setWorkspace(data);
        setError("");
      }
    },
    [page, status, filterKind, api],
  );
  useEffect(() => {
    if (privateDenied || !alive.current || privateBlocked.current || purged.current) return;
    const controller = new AbortController();
    setLoading(true);
    void reload(controller.signal)
      .catch((cause) => {
        if (alive.current && !privateBlocked.current && !purged.current && !controller.signal.aborted) {
          if (assistReadDenied(cause)) clearRestricted(cause.message);
          else setError(cause instanceof Error ? cause.message : "任务读取失败");
        }
      })
      .finally(() => {
        if (alive.current && !privateBlocked.current && !purged.current && !controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload, clearRestricted, privateDenied]);
  useEffect(() => {
    if (privateDenied || !alive.current || privateBlocked.current || purged.current) return;
    const controller = new AbortController();
    const refresh = () => {
      if (document.hidden || !alive.current || privateBlocked.current || purged.current) return;
      void reload(controller.signal).catch((cause) => {
        if (alive.current && !privateBlocked.current && !purged.current && !controller.signal.aborted) {
          if (assistReadDenied(cause)) clearRestricted(cause.message);
          else setError("任务状态暂不可读取，后台任务仍可能在运行。请刷新核对。");
        }
      });
    };
    const active = workspace.items.some((task) => ["queued", "running"].includes(task.status));
    const timer = setInterval(refresh, active ? 5000 : 30000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [workspace.items, reload, clearRestricted, privateDenied]);
  useEffect(() => {
    if (loading || workspace.capabilities.some((task) => task.kind === kind && targetScopeAllowed(task.kind))) return;
    const first = workspace.capabilities.find((task) => task.canStart && targetScopeAllowed(task.kind)) ?? workspace.capabilities.find(task => targetScopeAllowed(task.kind));
    if (first) setKind(first.kind);
  }, [loading, workspace.capabilities, kind, targetScopeAllowed]);
  useEffect(() => {
    setBasis(null);
    setBasisError("");
    setBasisBusy(false);
    basisController.current?.abort();
  }, [selectionKey]);
  const readTargets = useCallback(async (previous: AssistTargetCollection | null) => {
    if (!alive.current || privateBlocked.current || targetPending.current) return;
    const controller = new AbortController(), epoch = authorizationEpoch.current, sequence = ++targetSequence.current;
    const key = targetQueryKey, requested = { kind, q: query.trim(), pageSize: 40, ...(previous?.nextCursor ? { cursor: previous.nextCursor } : {}) };
    targetController.current?.abort(); targetController.current = controller; targetPending.current = true;
    setTargetsLoading(true); setTargetError("");
    const current = () => alive.current && !privateBlocked.current && !controller.signal.aborted && epoch === authorizationEpoch.current && sequence === targetSequence.current && key === currentTargetQuery.current;
    try {
      const raw = await api(`task-target-pages?${new URLSearchParams(Object.entries(requested).map(([name, value]) => [name, String(value)]))}`, undefined, controller.signal);
      if (current()) setTargets(mergeAssistTargetPage(previous, raw, requested, authority));
    } catch (cause) {
      if (current()) {
        if (assistReadDenied(cause)) clearRestricted(cause.message);
        else {
          setTargetError(cause instanceof Error ? cause.message : "业务对象暂时无法核对 请重新读取");
          if (cause instanceof AssistRequestError && (cause.code === "assist_target_collection_changed" || cause.status === 502)) {
            setTargets(null); setTargetId(""); setBasis(null); setNewRun(null); basisController.current?.abort();
          }
        }
      }
    } finally {
      if (sequence === targetSequence.current) { targetPending.current = false; if (current()) setTargetsLoading(false); }
    }
  }, [kind, query, targetQueryKey, authority, api, clearRestricted]);
  useEffect(() => {
    targetController.current?.abort(); targetSequence.current++; targetPending.current = false;
    setTargets(null); setTargetError("");
    if (!capability || !scopeReady || kind === "knowledge_answer" || privateBlocked.current) { setTargetsLoading(false); return; }
    setTargetsLoading(true);
    const timer = setTimeout(() => void readTargets(null), 250);
    return () => { clearTimeout(timer); targetController.current?.abort(); targetSequence.current++; targetPending.current = false; };
  }, [kind, !!capability, scopeReady, readTargets, targetRefresh]);
  useEffect(() => {
    if (privateDenied || !alive.current || privateBlocked.current || purged.current) return;
    if (!selectedId) {
      setSelected(null);
      setSelectedError("");
      return;
    }
    let pendingRead: AbortController | undefined;
    const read = async (foreground = false) => {
      if (!alive.current || privateBlocked.current || purged.current) return;
      pendingRead?.abort();
      const controller = new AbortController();
      pendingRead = controller;
      const epoch = authorizationEpoch.current;
      if (foreground) {
        setSelectedBusy(true);
        setSelected(null);
        setSelectedError("");
      }
      try {
        const saved = AssistViewSchema.parse(
          await api(`runs/${selectedId}`, undefined, controller.signal),
        );
        if (alive.current && !privateBlocked.current && !controller.signal.aborted && epoch === authorizationEpoch.current) {
          setSelected(saved);
          setSelectedError("");
        }
      } catch (cause) {
        if (alive.current && !privateBlocked.current && !purged.current && !controller.signal.aborted && epoch === authorizationEpoch.current) {
          if (assistReadDenied(cause)) clearRestricted(cause.message);
          else setSelectedError(cause instanceof Error ? cause.message : "任务读取失败");
        }
      } finally {
        if (alive.current && !privateBlocked.current && !purged.current && !controller.signal.aborted && epoch === authorizationEpoch.current) setSelectedBusy(false);
      }
    };
    const refresh = () => {
      if (!document.hidden && alive.current && !privateBlocked.current && !purged.current) void read();
    };
    void read(true);
    const timer = setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      pendingRead?.abort();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [selectedId, clearRestricted, api, privateDenied]);
  useEffect(() => () => basisController.current?.abort(), []);
  async function readBasis() {
    if (!alive.current || privateBlocked.current || purged.current || basisBusy || !capability?.canStart || !scopeReady) return;
    const controller = new AbortController();
    basisController.current?.abort();
    basisController.current = controller;
    const key = selectionKey, epoch = authorizationEpoch.current;
    setBasisBusy(true);
    setBasis(null);
    setBasisError("");
    setNewRun(null);
    try {
      const next = AssistTaskBasisSchema.parse(
        await api(
          "task-basis",
          { kind, targetId: kind === "knowledge_answer" ? null : targetId, taskGoal: goal },
          controller.signal,
        ),
      );
      if (alive.current && !privateBlocked.current && !purged.current && !controller.signal.aborted && epoch === authorizationEpoch.current && currentSelection.current === key) { basisKey.current = key; setBasis(next); }
    } catch (cause) {
      if (alive.current && !privateBlocked.current && !purged.current && !controller.signal.aborted && epoch === authorizationEpoch.current && currentSelection.current === key)
        if (assistReadDenied(cause)) clearRestricted(cause.message);
        else setBasisError(cause instanceof Error ? cause.message : "分析依据读取失败");
    } finally {
      if (alive.current && !privateBlocked.current && !purged.current && !controller.signal.aborted && epoch === authorizationEpoch.current && currentSelection.current === key) setBasisBusy(false);
    }
  }
  const onRunChange = useCallback(
    (view: AssistView) => {
      if (!alive.current || privateBlocked.current || purged.current) return;
      const epoch = authorizationEpoch.current;
      setNewRun(basis && !view.stale && sameAssistInput(view.request, basis.input) ? view : null);
      void reload().catch(() => { if (alive.current && !privateBlocked.current && !purged.current && epoch === authorizationEpoch.current) setError("任务已保存，列表暂不可读取；可以使用任务链接继续查看。"); });
    },
    [basis, reload],
  );
  function selectKind(next: AssistKind) {
    setKind(next);
    setTargetId("");
    setQuery("");
    setNewRun(null);
  }
  const savedRow = workspace.items.find((task) => task.id === selectedId);
  return (
    <main className="ai-task-workspace">
      <header className="at-header">
        <div>
          <h1>AI 任务工作台</h1>
          <p>选择业务对象，核对依据，跟进分析结果与下一步。</p>
        </div>
        <div className="at-actions">
          <button
            className="at-primary"
            type="button"
            onClick={() => {
              router.push("/ai-tasks");
              setNewRun(null);
              setBasis(null);
            }}
          >
            <Plus size={15} />
            新任务
          </button>
          <button
            type="button"
            disabled={loading || privateDenied}
            onClick={() =>
              void reload().catch((cause) => {
                if (alive.current && !privateBlocked.current && !purged.current) setError(cause instanceof Error ? cause.message : "读取失败");
              })
            }
          >
            <RefreshCw size={14} />
            刷新
          </button>
        </div>
      </header>
      <TaskWorkspaceNav current="analysis" />
      <AgentNativeTaskVersions />
      <AgentFulfillmentEntry />
      <AgentMcpConnection />
      <AgentResourceBrowser />
      <AgentReadTools />
      <AgentToolBrowser />
      <AgentLoopWorkbench />
      <AgentPlanWorkbench />
      {identity?.session && <AgentDependencyPlanWorkbench session={identity.session} />}
      {!hasAgentFulfillmentCommandSelection(search) && <AgentOperationWorkbench />}
      <AgentFulfillmentCommandWorkbench />
      {!privateDenied && <AssistRequestRecovery />}
      {privateDenied && <p role="status" className="at-error">当前分析权限或资料范围已变化 原任务和填写已隐藏 请重新核对本人权限后恢复原回执</p>}
      {error && (
        <p className="at-error" role="alert">
          {error}
        </p>
      )}
      {!privateDenied && <div className="at-layout">
        <aside className="at-history" aria-label="我的任务历史">
          <header>
            <h2>
              <History size={16} aria-hidden="true" />
              我的任务
            </h2>
            <span>第 {page} 页</span>
            <button
              className="at-history-toggle"
              type="button"
              aria-label={historyExpanded ? "收起任务历史" : "展开任务历史"}
              aria-expanded={historyExpanded}
              aria-controls="at-history-content"
              onClick={() => setHistoryExpanded(!historyExpanded)}
            >
              <ChevronDown size={17} aria-hidden="true" />
            </button>
          </header>
          <div id="at-history-content" className="at-history-content" data-open={historyExpanded}>
            <div>
              <div className="at-filters">
                <label>
                  任务类型
                  <select
                    value={filterKind}
                    onChange={(event) => {
                      setFilterKind(event.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="">全部类型</option>
                    {ASSIST_TASKS.filter((task) =>
                      workspace.capabilities.some((capability) => capability.kind === task.kind),
                    ).map((task) => (
                      <option key={task.kind} value={task.kind}>
                        {task.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  状态
                  <select
                    value={status}
                    onChange={(event) => {
                      setStatus(event.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="">全部状态</option>
                    {Object.entries(taskStatus).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {loading ? (
                <p role="status">正在读取任务…</p>
              ) : !workspace.items.length ? (
                <p className="at-history-empty">
                  {workspace.capabilities.length
                    ? "当前筛选没有任务。分析完成后，记录会保存在这里。"
                    : "当前账号没有可读取的 AI 任务权限。"}
                </p>
              ) : (
                <ol className="at-task-list">
                  {workspace.items.map((task) => (
                    <li key={task.id}>
                      <button
                        type="button"
                        aria-current={task.id === selectedId ? "true" : undefined}
                        onClick={() => router.push(`/ai-tasks?run=${task.id}`)}
                      >
                        <span className="at-task-top">
                          <strong>
                            {ASSIST_TASKS.find((item) => item.kind === task.kind)!.label}
                          </strong>
                          <span data-status={task.status}>{taskStatus[task.status]}</span>
                        </span>
                        <span className="at-task-title">{task.title}</span>
                        <small>
                          {dateTime(task.createdAt)} ·{" "}
                          {task.stale ? "需重新核对依据" : task.modelLabel}
                        </small>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
              <div className="at-pagination">
                <button
                  type="button"
                  disabled={loading || page === 1}
                  onClick={() => setPage(page - 1)}
                >
                  上一页
                </button>
                <button
                  type="button"
                  disabled={loading || !workspace.hasMore}
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                </button>
              </div>
            </div>
          </div>
        </aside>
        <section className="at-detail" aria-label="任务详情">
          {selectedId ? (
            <>
              <header className="at-detail-heading">
                <div>
                  <h2>
                    {selected
                      ? ASSIST_TASKS.find((task) => task.kind === selected.kind)!.label
                      : "查看任务"}
                  </h2>
                  <p>{savedRow?.title ?? "读取本次固定的业务依据与分析记录"}</p>
                </div>
                <Link href={`/ai-tasks?run=${selectedId}`}>任务链接</Link>
              </header>
              {selectedBusy && <p role="status">正在读取任务详情…</p>}
              {selectedError && (
                <p role="alert" className="at-error">
                  {selectedError}
                </p>
              )}
              {selected && (
                <>
                  <p className="at-muted">
                    {selected.request?.taskGoal || "按该类任务的业务要求进行分析"}
                  </p>
                  <AssistPanel
                    key={selected.id}
                    kind={selected.kind}
                    scope={selected.scope}
                    input={null}
                    readOnly
                    initialRunId={selected.id}
                    onReadDenied={clearRestricted}
                  />
                  <Link
                    className="at-next"
                    href={assistTaskHref(
                      selected.request,
                      selected.kind,
                      selected.sources,
                      selected.id,
                    )}
                  >
                    进入业务页面核对与处理
                    <ArrowRight size={15} />
                  </Link>
                </>
              )}
            </>
          ) : (
            <>
              <header className="at-detail-heading">
                <div>
                  <h2>开始业务任务</h2>
                  <p>选择对象并核对依据，再开始 AI 分析</p>
                </div>
              </header>
              <ol className="at-steps" aria-label="分析步骤">
                <li data-active={!basis}>
                  <span>1</span>选择业务对象
                </li>
                <li data-active={!!basis && !newRun}>
                  <span>2</span>核对本次依据
                </li>
                <li data-active={!!newRun}>
                  <span>3</span>分析与处理
                </li>
              </ol>
              <div className="at-composer">
                <label>
                  要完成的任务
                  <select
                    value={kind}
                    onChange={(event) => selectKind(event.target.value as AssistKind)}
                  >
                    {["定制履约", "商品上新", "经营与知识"].map((group) => (
                      <optgroup key={group} label={group}>
                        {ASSIST_TASKS.filter(
                          (task) =>
                            task.group === group &&
                            workspace.capabilities.some(
                              (capability) => capability.kind === task.kind,
                            ),
                        ).map((task) => (
                          <option key={task.kind} value={task.kind} disabled={!targetScopeAllowed(task.kind)}>
                            {task.label}{!targetScopeAllowed(task.kind) ? " · 需租户范围读取权限" : ""}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <p className="at-muted">{currentTask.description}</p>
                {!scopeReady && <p className="at-muted" role="status">当前此类对象需要对应业务资料的租户范围读取权限 可以选择其他已授权任务 原任务历史仍按当前权限核对</p>}
                {kind !== "knowledge_answer" && (
                  <>
                    <label className="at-object-field">
                      查找业务对象
                      <input
                        value={query}
                        maxLength={200}
                        onChange={(event) => {
                          setQuery(event.target.value);
                          setTargetId("");
                        }}
                        placeholder="按订单号、商品名称或文件名称查找"
                      />
                    </label>
                    <label className="at-object-field">
                      本次业务对象
                      <select
                        value={targetId}
                        onChange={(event) => setTargetId(event.target.value)}
                        disabled={targetsLoading || !targets.length}
                      >
                        <option value="">
                          {targetsLoading ? "正在读取…" : "选择本次要处理的记录"}
                        </option>
                        {targets.map((target) => (
                          <option key={target.id} value={target.id}>
                            {target.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {targetError && (
                      <p role="alert" className="at-error">
                        {targetError}
                      </p>
                    )}
                    {!targetsLoading && !targets.length && !targetError && (
                      <p className="at-muted">
                        暂无匹配的业务对象。
                        <Link href={currentTask.destination}>进入业务页面准备资料</Link>
                      </p>
                    )}
                    <div className="at-pagination at-target-pagination" aria-label="业务对象分页" aria-busy={targetsLoading}>
                      <p className="at-muted" role="status">
                        {targetCollection ? <>已读取 {targetCollection.readCount} / {targetCollection.total} 项 {targetCollection.complete ? "本次集合已读完" : "尚未读取完整集合"}</> : targetsLoading ? "正在读取业务对象" : "本次集合尚未核对"}
                      </p>
                      {targetCollection?.nextCursor ? <button type="button" disabled={targetsLoading} onClick={() => void readTargets(targetCollection)}>
                        {targetsLoading ? "正在读取…" : "加载下一页"}<ChevronDown size={14} aria-hidden="true" />
                      </button> : <button type="button" disabled={targetsLoading} onClick={() => { setTargetId(""); setBasis(null); setNewRun(null); setTargetRefresh(value => value + 1); }}>
                        <RefreshCw size={14} aria-hidden="true" />重新读取对象
                      </button>}
                    </div>
                    {targets.find((target) => target.id === targetId)?.detail && (
                      <p className="at-muted">
                        {targets.find((target) => target.id === targetId)!.detail}
                      </p>
                    )}
                  </>
                )}
                <label>
                  {kind === "knowledge_answer" ? "需要查证的问题" : "分析重点（可选）"}
                  <textarea
                    rows={3}
                    value={goal}
                    maxLength={kind === "knowledge_answer" ? 300 : 2000}
                    onChange={(event) => setGoal(event.target.value)}
                    placeholder={
                      kind === "knowledge_answer"
                        ? "例如：定制订单遇到买家图片不清晰时，应该如何处理？"
                        : "例如：重点核对缺少的买家资料，并列出下一步处理建议。"
                    }
                  />
                </label>
                <p className="at-muted">
                  填写内容会发送至所选模型渠道。请勿填写凭据或不必要的客户个人资料。任务目标不能改变生产规则或审核条件。
                </p>
                {!capability?.canStart && !loading && (
                  <p className="at-error" role="status">
                    当前账号可以查看记录，但没有启动这类任务的权限。
                  </p>
                )}
                <button
                  className="at-primary"
                  type="button"
                  disabled={
                    basisBusy ||
                    !scopeReady ||
                    !capability?.canStart ||
                    (kind === "knowledge_answer" ? !goal.trim() : !targetId)
                  }
                  onClick={() => void readBasis()}
                >
                  <FileSearch size={15} />
                  {basisBusy ? "正在读取依据…" : "读取本次依据"}
                </button>
              </div>
              {basisError && (
                <p role="alert" className="at-error">
                  {basisError}
                </p>
              )}
              {basis && (
                <>
                  <section className="at-basis" aria-label="本次任务依据">
                    <h3>本次任务依据</h3>
                    <MethodEvidence selection={basis.methodSelection} preview />
                    <dl>
                      {basis.rows.map((row, index) => (
                        <div key={index}>
                          <dt>{row.label}</dt>
                          <dd>{row.value}</dd>
                        </div>
                      ))}
                    </dl>
                    <details open>
                      <summary>来源与固定版本 · {basis.sources.length} 项</summary>
                      <ul>
                        {basis.sources.map((source) => (
                          <li key={source.id}>
                            {source.href ? (
                              <Link href={source.href}>{source.label}</Link>
                            ) : (
                              source.label
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                    {!!basis.checks.length && (
                      <ul className="at-checks">
                        {basis.checks.map((check, index) => (
                          <li key={index} data-severity={check.severity}>
                            {check.message}
                          </li>
                        ))}
                      </ul>
                    )}
                    {!!basis.diagnostics.length && (
                      <ul className="at-checks">
                        {basis.diagnostics.map((diagnostic, index) => (
                          <li key={index}>{diagnostic}</li>
                        ))}
                      </ul>
                    )}
                  </section>
                  <AssistPanel
                    key={`${basis.scope}:${basis.fingerprint}`}
                    kind={kind}
                    scope={basis.scope}
                    input={basis.input}
                    onRunChange={onRunChange}
                    onReadDenied={clearRestricted}
                  />
                  <div className="at-actions">
                    <Link
                      className="at-next"
                      href={
                        newRun
                          ? assistTaskHref(newRun.request, newRun.kind, newRun.sources, newRun.id)
                          : basis.href
                      }
                    >
                      进入业务页面核对与处理
                      <ArrowRight size={15} />
                    </Link>
                    {newRun && <Link href={`/ai-tasks?run=${newRun.id}`}>打开本次任务详情</Link>}
                  </div>
                </>
              )}
            </>
          )}
        </section>
      </div>}
    </main>
  );
}
