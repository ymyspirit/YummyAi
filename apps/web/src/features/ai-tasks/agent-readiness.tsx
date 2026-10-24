"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { Activity, AlertCircle, ClipboardCheck, RefreshCw, Settings2 } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import type { AgentReadiness as AgentReadinessView, AgentReadinessBlocker, AgentReadinessFamily } from "@yummyai/contracts/ai/agent-readiness";
import type { AgentRuntimeReadiness } from "@yummyai/contracts/ai/agent-runtime-readiness";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { useErpAccess } from "../identity/erp-access";
import { AgentReadinessRequestError, AgentRuntimeReadinessRequestError, readAgentReadiness, readAgentRuntimeReadiness } from "./agent-readiness-client";
import "./agent-readiness.css";

const familyLabels: Record<AgentReadinessFamily, string> = {
  loop: "有界读取任务", plan: "模型业务计划", native_v1: "原生工具 v1", native_v2: "原生工具 v2", native_v3: "原生工具 v3", native_v4: "履约建议与本人补全 v4",
};
const blockers: Record<AgentReadinessBlocker, { label: string; next: string }> = {
  workflow_run_permission_missing: { label: "缺少当前任务运行权限", next: "请由权限管理员核对 WorkflowRun 原任务和回执仍按读取权限查看" },
  model_not_configured: { label: "尚未配置任务可用模型", next: "请配置受支持的分析模型及明确的报价和单任务上限" },
  model_routes_disabled: { label: "模型渠道或路由已停用", next: "请在模型配置中核对渠道及原模型路由状态" },
  model_provider_unsupported: { label: "当前模型供应商或路由结构不受支持", next: "请核对本类任务支持的供应商与单一路由 不以其他助手可用代替核验" },
  model_pricing_missing: { label: "模型缺少输入或输出报价", next: "请按渠道实际价格填写 未提供报价不能当作免费" },
  model_task_cap_missing: { label: "模型缺少正数单任务费用上限", next: "请在分析费用设置中填写明确的单任务上限" },
  original_read_unavailable: { label: "当前没有可用的原业务读取能力", next: "请核对所需业务读取权限与范围 目录可用仍不代表具体对象可读" },
  original_command_unavailable: { label: "当前没有可准备的原业务命令", next: "请核对原业务操作权限 不绕过原审批或执行确认" },
  task_budget_below_minimum: { label: "任务预算不足以预留最小金额", next: "请由预算管理员核对原任务预算策略" },
  monthly_cost_unknown: { label: "本月存在尚未核清的调用费用", next: "请先核对原账单与未知费用 避免低估已经发生的成本" },
  monthly_budget_exhausted: { label: "本月预算不足以新增最小预留", next: "请核对原预算与已预留账本 不重复提交任务" },
  active_task_limit: { label: "当前活动任务已达上限", next: "请等待已有任务结束 或按原任务入口停止后续步骤" },
};

type ReadinessOptions = { family: AgentReadinessFamily; refreshKey: number; enabled: boolean; workspaceVersion?: string };
type Stored = { key: string; value: AgentReadinessView };
type RuntimePhase = "waiting" | "loading" | "observed" | "expired" | "inactive" | "error" | "not_checked";
type RuntimeStored = { key: string; value: AgentRuntimeReadiness | null; phase: RuntimePhase; error: string };
type RuntimeProof = {
  key: string; value: AgentRuntimeReadiness; startedMonotonic: number; startedWall: number;
  monotonicDeadline: number; wallDeadline: number;
};
export type AgentRuntimeReadinessDiagnostic = {
  value: AgentRuntimeReadiness | null; phase: RuntimePhase; error: string;
  canRefresh: boolean; refresh: () => void; canStart: () => boolean;
};
export type AgentReadinessDiagnostic = {
  family: AgentReadinessFamily; value: AgentReadinessView | null; loading: boolean; error: string;
  canRead: boolean; waitingForWorkspace: boolean; canConfigure: boolean; canStart: () => boolean; refresh: () => void;
  runtime: AgentRuntimeReadinessDiagnostic;
};

const pageActive = () => typeof document !== "undefined" && document.visibilityState === "visible" && navigator.onLine !== false;
function proofFresh(proof: RuntimeProof) {
  const monotonic = performance.now(), wall = Date.now();
  return proof.value.state === "observed_ready" && monotonic >= proof.startedMonotonic && wall >= proof.startedWall
    && monotonic < proof.monotonicDeadline && wall < proof.wallDeadline;
}

function useRuntimeReadiness({ key, family, authority, workspaceVersion, canRead, canRun }: {
  key: string; family: AgentReadinessFamily; authority: string | null; workspaceVersion?: string; canRead: boolean; canRun: boolean;
}): AgentRuntimeReadinessDiagnostic {
  const context = useRef({ key, canRead, canRun }); context.current = { key, canRead, canRun };
  const alive = useRef(true), purged = useRef(false), suspended = useRef(false), sequence = useRef(0);
  const denied = useRef<{ key: string; error: string } | null>(null);
  const request = useRef<{ key: string; token: number; controller: AbortController } | null>(null);
  const proof = useRef<RuntimeProof | null>(null), expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [stored, setStored] = useState<RuntimeStored | null>(null);
  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) { clearInterval(pollTimer.current); pollTimer.current = null; }
  }, []);
  const discardProof = useCallback(() => {
    proof.current = null;
    if (expiryTimer.current !== null) { clearTimeout(expiryTimer.current); expiryTimer.current = null; }
  }, []);
  const invalidate = useCallback((phase: RuntimePhase) => {
    sequence.current++; request.current?.controller.abort(); request.current = null; discardProof();
    const rejection = !purged.current && phase === "waiting" && denied.current?.key === context.current.key ? denied.current : null;
    if (alive.current) setStored({ key: context.current.key, value: null, phase: rejection ? "error" : phase, error: rejection?.error ?? "" });
  }, [discardProof]);
  const refresh = useCallback(() => {
    if (!alive.current || purged.current || context.current.key !== key) return;
    if (!authority || !context.current.canRead) { invalidate("waiting"); return; }
    if (!context.current.canRun) { invalidate("not_checked"); return; }
    if (suspended.current || !pageActive()) { invalidate("inactive"); return; }
    if (denied.current?.key === key || request.current?.key === key) return;
    invalidate("loading");
    const token = sequence.current, abort = new AbortController();
    // Both deadlines begin before HTTP, so transport and decoding consume the lease.
    const startedMonotonic = performance.now(), startedWall = Date.now();
    request.current = { key, token, controller: abort };
    const current = () => alive.current && !purged.current && !suspended.current && pageActive() && !abort.signal.aborted
      && token === sequence.current && context.current.key === key && context.current.canRead && context.current.canRun;
    void readAgentRuntimeReadiness(family, authority, abort.signal).then(value => {
      if (!current()) return;
      if (workspaceVersion && value.executorVersion !== workspaceVersion) throw new AgentRuntimeReadinessRequestError(502);
      const observed: RuntimeProof = { key, value, startedMonotonic, startedWall,
        monotonicDeadline: startedMonotonic + value.validForMs, wallDeadline: startedWall + value.validForMs };
      if (value.state !== "observed_ready") {
        if (value.state === "not_checked") stopPolling();
        setStored({ key, value, phase: "observed", error: "" }); return;
      }
      if (!proofFresh(observed)) { setStored({ key, value, phase: "expired", error: "" }); return; }
      proof.current = observed; setStored({ key, value, phase: "observed", error: "" });
      const expire = () => {
        if (!current() || proof.current !== observed) return;
        const remaining = Math.min(observed.monotonicDeadline - performance.now(), observed.wallDeadline - Date.now());
        if (proofFresh(observed) && remaining > 0) {
          expiryTimer.current = setTimeout(expire, Math.max(1, Math.ceil(remaining))); return;
        }
        discardProof(); setStored({ key, value, phase: "expired", error: "" });
      };
      expire();
    }).catch(cause => {
      if (!current()) return;
      discardProof();
      let error = cause instanceof AgentRuntimeReadinessRequestError
        ? cause.message : "执行服务诊断读取失败 当前没有有效就绪证明 新付费提交不可用";
      if (cause instanceof AgentRuntimeReadinessRequestError && ([401, 403, 404].includes(cause.status) || cause.code === "authority_changed")) {
        error += " 请使用本任务区重新读取契约 核对当前授权";
        denied.current = { key, error }; stopPolling();
      }
      setStored({ key, value: null, phase: "error", error });
    }).finally(() => { if (request.current?.token === token && request.current.key === key) request.current = null; });
  }, [authority, discardProof, family, invalidate, key, stopPolling, workspaceVersion]);
  useLayoutEffect(() => {
    alive.current = true;
    const clear = () => { purged.current = true; stopPolling(); invalidate("waiting"); };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    return () => {
      alive.current = false; sequence.current++; request.current?.controller.abort(); request.current = null; discardProof(); stopPolling();
      window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    };
  }, [discardProof, invalidate, stopPolling]);
  useEffect(() => {
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelResume = () => { if (resumeTimer !== null) { clearTimeout(resumeTimer); resumeTimer = null; } };
    const startPolling = () => {
      stopPolling();
      if (!alive.current || purged.current || context.current.key !== key || suspended.current || !pageActive() || !context.current.canRead || !context.current.canRun || denied.current?.key === context.current.key) return;
      pollTimer.current = setInterval(() => {
        if (alive.current && !purged.current && !suspended.current && pageActive() && context.current.canRead && context.current.canRun) refresh();
      }, 6_000);
    };
    suspended.current = !pageActive(); refresh(); startPolling();
    const resume = () => {
      cancelResume(); stopPolling();
      suspended.current = !pageActive();
      invalidate(suspended.current ? "inactive" : "waiting");
      if (!suspended.current) {
        // A focus event can also refresh the owner workspace; do not race its old generation.
        resumeTimer = setTimeout(() => { resumeTimer = null; refresh(); startPolling(); }, 0);
      }
    };
    const offline = () => { cancelResume(); suspended.current = true; stopPolling(); invalidate("inactive"); };
    const modelChange = () => { cancelResume(); stopPolling(); invalidate("waiting"); };
    window.addEventListener("focus", resume); window.addEventListener("online", resume); window.addEventListener("offline", offline);
    window.addEventListener("yummyai.models.changed", modelChange); document.addEventListener("visibilitychange", resume);
    return () => {
      cancelResume(); stopPolling(); sequence.current++; request.current?.controller.abort(); request.current = null; discardProof();
      window.removeEventListener("focus", resume); window.removeEventListener("online", resume); window.removeEventListener("offline", offline);
      window.removeEventListener("yummyai.models.changed", modelChange); document.removeEventListener("visibilitychange", resume);
    };
  }, [canRead, canRun, discardProof, invalidate, key, refresh, stopPolling]);
  const canStart = useCallback(() => {
    const current = proof.current;
    if (!alive.current || purged.current || suspended.current || !pageActive() || !context.current.canRead || !context.current.canRun
      || !current || current.key !== context.current.key || !proofFresh(current)) {
      if (current) discardProof();
      return false;
    }
    return true;
  }, [discardProof]);
  const visible = canRead && canRun && !purged.current && stored?.key === key ? stored : null;
  return { value: visible?.value ?? null, phase: !canRead || purged.current ? "waiting" : !canRun ? "not_checked"
    : visible?.phase ?? "waiting", error: visible?.error ?? "",
    canRefresh: canRead && canRun && !purged.current && !suspended.current && pageActive() && denied.current?.key !== key, refresh, canStart };
}

export function useAgentReadiness({ family, refreshKey, enabled, workspaceVersion }: ReadinessOptions): AgentReadinessDiagnostic {
  const access = useErpAccess(), authority = access.authority, owner = access.preferenceScope;
  const hasReadPermission = Boolean(authority && owner && access.can(Permission.WorkflowRead));
  const canRead = hasReadPermission && enabled;
  const key = JSON.stringify([owner, authority, family, refreshKey, workspaceVersion ?? null]);
  const context = useRef({ key, canRead }); context.current = { key, canRead };
  const alive = useRef(true), purged = useRef(false), sequence = useRef(0), controller = useRef<AbortController | null>(null);
  const accepted = useRef<Stored | null>(null);
  const [stored, setStored] = useState<Stored | null>(null), [loadingKey, setLoadingKey] = useState<string | null>(null), [failure, setFailure] = useState<{ key: string; text: string } | null>(null);
  const [modelRevision, setModelRevision] = useState(0);
  const [cleared, setCleared] = useState(false);
  const runtime = useRuntimeReadiness({ key, family, authority, workspaceVersion, canRead: canRead && !cleared, canRun: access.can(Permission.WorkflowRun) });
  const refresh = useCallback(() => {
    controller.current?.abort(); sequence.current++; accepted.current = null;
    setStored(null); setFailure(null); setLoadingKey(null);
    if (!authority || !canRead || !alive.current || purged.current) return;
    const expected = key, token = sequence.current, abort = new AbortController();
    controller.current = abort; setLoadingKey(expected);
    const current = () => alive.current && !purged.current && !abort.signal.aborted && token === sequence.current && context.current.key === expected && context.current.canRead;
    void readAgentReadiness(family, authority, abort.signal).then(value => {
      if (!current()) return;
      if (workspaceVersion && value.workspaceVersion !== workspaceVersion) throw new AgentReadinessRequestError(502);
      const next = { key: expected, value }; accepted.current = next; setStored(next);
    }).catch(cause => {
      if (current()) setFailure({ key: expected, text: cause instanceof AgentReadinessRequestError ? cause.message : "启动诊断读取失败 未判定为可启动 请只读刷新后核对" });
    }).finally(() => { if (current()) setLoadingKey(null); });
  }, [authority, canRead, family, key, workspaceVersion]);
  useLayoutEffect(() => {
    alive.current = true;
    const clear = () => {
      purged.current = true; sequence.current++; controller.current?.abort(); accepted.current = null;
      setStored(null); setFailure(null); setLoadingKey(null); setCleared(true);
    };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    return () => { alive.current = false; sequence.current++; controller.current?.abort(); accepted.current = null; window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); };
  }, []);
  useEffect(() => {
    const modelsChanged = () => {
      sequence.current++; controller.current?.abort(); accepted.current = null;
      setStored(null); setFailure(null); setLoadingKey(null); setModelRevision(value => value + 1);
    };
    window.addEventListener("yummyai.models.changed", modelsChanged);
    return () => window.removeEventListener("yummyai.models.changed", modelsChanged);
  }, []);
  useEffect(() => { refresh(); return () => { sequence.current++; controller.current?.abort(); accepted.current = null; }; }, [refresh, modelRevision]);
  const value = !cleared && canRead && stored?.key === key ? stored.value : null;
  const canStart = useCallback(() => {
    const original = accepted.current;
    return alive.current && !purged.current && context.current.canRead && original?.key === context.current.key && original.value.state === "no_known_blocker" && runtime.canStart();
  }, [runtime.canStart]);
  const refreshAll = useCallback(() => { refresh(); runtime.refresh(); }, [refresh, runtime.refresh]);
  return { family, value, loading: !cleared && canRead && loadingKey === key, error: !cleared && canRead && failure?.key === key ? failure.text : "",
    canRead: canRead && !cleared, waitingForWorkspace: hasReadPermission && !enabled && !cleared, canConfigure: access.can(Permission.ModelConfigure), canStart, refresh: refreshAll, runtime };
}

export function AgentReadiness({ diagnostic }: { diagnostic: AgentReadinessDiagnostic }) {
  const { family, value, loading, error, canRead, waitingForWorkspace, canConfigure, refresh, runtime } = diagnostic;
  const modelProblem = value?.blockers.some(code => code.startsWith("model_"));
  return <section className="agent-readiness" aria-label={familyLabels[family] + "启动诊断"} aria-busy={loading}>
    <header><h3><ClipboardCheck size={15} />运行前只读诊断</h3><button type="button" disabled={!canRead || loading} onClick={refresh}><RefreshCw size={14} className={loading ? "agent-readiness-spinning" : undefined} />只读刷新启动诊断</button></header>
    {waitingForWorkspace ? <p role="status">原工作区尚未完成当前读取核对 启动诊断暂不可读 新付费提交暂不可用</p>
      : !canRead ? <p role="status">当前没有读取启动诊断的权限或本人身份尚未核对 不据此开放新付费任务</p>
      : loading ? <p role="status">正在只读核对启动条件 新付费提交暂不可用</p>
        : error ? <p role="alert" className="agent-readiness-error"><AlertCircle size={14} />{error}</p>
          : value ? <div className="agent-readiness-result" key={value.checkedAt + value.state}>
            <p role="status" className={value.state === "blocked" ? "agent-readiness-blocked" : "agent-readiness-status"}>{value.state === "blocked" ? "当前存在启动阻断" : "初步检查无已知阻断"}</p>
            {value.blockers.length > 0 && <ul className="agent-readiness-blockers">{value.blockers.map(code => <li key={code}><strong>{blockers[code].label}</strong><span>{blockers[code].next}</span></li>)}</ul>}
            {modelProblem && value.canConfigureModels && canConfigure && <Link className="agent-readiness-settings" href="/settings/ai#analysis-model-settings"><Settings2 size={14} />核对分析模型与费用设置</Link>}
            <p className="agent-readiness-muted">核对时间 <time dateTime={value.checkedAt}>{value.checkedAt}</time> 本次只读 不调用模型 不预留费用 不派发任务 不写业务</p>
            <details className="agent-readiness-checks"><summary>已检查的有限范围</summary><dl>
              <div><dt>任务运行权限</dt><dd>{value.checks.runPermission === "granted" ? "当前具有原运行权限" : "缺少原运行权限"}</dd></div>
              <div><dt>合格模型配置</dt><dd>{value.checks.model === "available" ? "至少一项配置符合原任务门" : "当前未找到合格模型"}</dd></div>
              <div><dt>原业务能力</dt><dd>{value.checks.originalCapability === "available" ? "至少一项目录能力可用 具体来源另核" : "当前无可用原能力"}</dd></div>
              <div><dt>最小任务预留</dt><dd>{value.checks.taskBudget === "not_checked" ? "未检查" : value.checks.taskBudget === "below_minimum" ? "低于最小预留" : "最小预留未见阻断 不代表本次金额通过"}</dd></div>
              <div><dt>本月预算账本</dt><dd>{({ not_configured: "未配置月度预算门", available: "当前账本未见已知阻断", exhausted: "不足以新增最小预留", cost_unknown: "存在未知费用", not_checked: "未检查" })[value.checks.monthlyBudget]}</dd></div>
              <div><dt>活动任务数量</dt><dd>{({ available: "当前未达原并发上限", at_limit: "已达原并发上限", not_checked: "未检查" })[value.checks.concurrency]}</dd></div>
            </dl></details>
          </div> : <p role="status">尚未取得当前启动诊断 不据此判定为可启动</p>}
    <p className="agent-readiness-unchecked">配置与预算初检尚未验证 本次请求金额 所选具体来源 模型提供方连通性 任务执行服务在线状态 执行服务另见下方独立观察</p>
    <AgentRuntimeReadinessStatus diagnostic={runtime} />
    <p className="agent-readiness-muted">诊断通过不等于任务已启动 原提交仍会重新核对权限 模型与实际预算 原任务回执和停止入口不受此诊断门影响</p>
  </section>;
}

const runtimeReasons: Record<AgentRuntimeReadiness["reasons"][number], string> = {
  workflow_run_permission_missing: "缺少当前任务运行权限 未检查执行服务",
  runtime_not_observed: "尚未观察到可匹配的执行服务",
  runtime_protocol_unavailable: "未观察到支持当前任务版本的执行服务",
  consumer_unavailable: "当前未观察到任务执行服务就绪",
  dispatcher_unavailable: "当前未观察到任务派发服务就绪",
  queue_paused: "任务队列当前暂停",
  runtime_observation_unknown: "当前执行服务观察无法核对",
};

function AgentRuntimeReadinessStatus({ diagnostic }: { diagnostic: AgentRuntimeReadinessDiagnostic }) {
  const { value, phase, error, canRefresh, refresh } = diagnostic;
  const fresh = phase === "observed" && diagnostic.canStart();
  const expired = phase === "expired" || phase === "observed" && value?.state === "observed_ready" && !fresh;
  const unexamined = phase === "not_checked" || value?.state === "not_checked";
  const stateText = phase === "loading" ? "正在只读核对执行与派发服务"
    : phase === "inactive" ? "页面已隐藏或离线 原就绪观察已失效"
      : unexamined ? "当前缺少任务运行权限 未检查执行服务"
        : expired ? "执行服务就绪观察已过期"
          : fresh ? "本次观察到执行服务就绪"
            : value?.state === "unavailable" ? "本次未观察到执行服务就绪"
              : value?.state === "unknown" ? "本次执行服务状态未知"
                : "当前没有有效的执行服务就绪证明 新付费提交不可用";
  const serviceText = (kind: "consumer" | "dispatcher") => phase === "loading" ? "正在核对"
    : phase === "inactive" ? "旧观察已收回 等待重新读取"
      : unexamined ? "未检查" : expired ? "原就绪观察已过期"
        : value ? ({ ready: "本次观察为就绪", unavailable: "本次未观察到就绪", unknown: "未知", not_checked: "未检查" })[value.checks[kind]]
          : "暂无可核对的当前状态";
  return <section className="agent-runtime-readiness" aria-label="执行服务当前观察" aria-busy={phase === "loading"}>
    <header><h4><Activity size={14} />执行服务当前观察</h4><button type="button" disabled={!canRefresh || phase === "loading"} onClick={refresh}><RefreshCw size={14} className={phase === "loading" ? "agent-readiness-spinning" : undefined} />只读刷新执行服务</button></header>
    <p role="status" className={fresh ? "agent-readiness-status" : "agent-readiness-muted"}>{stateText}</p>
    {error && <p role="alert" className="agent-readiness-error"><AlertCircle size={14} />{error}</p>}
    <dl className="agent-runtime-services"><div><dt>任务执行服务</dt><dd>{serviceText("consumer")}</dd></div><div><dt>任务派发服务</dt><dd>{serviceText("dispatcher")}</dd></div></dl>
    {value && !expired && <p className="agent-readiness-muted">任务队列 {({ open: "本次观察未暂停", paused: "当前已暂停", unknown: "未知", not_checked: "未检查" })[value.checks.queue]}</p>}
    {value && value.reasons.length > 0 && <ul className="agent-runtime-reasons">{value.reasons.map(reason => <li key={reason}>{runtimeReasons[reason]}</li>)}</ul>}
    {value && <p className="agent-readiness-muted">观察时间 <time dateTime={value.checkedAt}>{value.checkedAt}</time>{value.state === "observed_ready" && <> 最晚有效至 <time dateTime={value.validUntil}>{value.validUntil}</time> 读取耗时已扣除 到期收回新提交资格</>}</p>}
    {!fresh && <p className="agent-readiness-muted">暂无当前就绪证明时新付费提交不可用 原任务仍可按当前权限读取或停止 不因服务离线改写原任务结果 不自动重发未知请求</p>}
    <p className="agent-readiness-muted">这只是当前执行与派发状态观察 不验证本次请求金额 所选来源 模型提供方连通性或业务准入 不代替原提交的事务核验</p>
  </section>;
}
