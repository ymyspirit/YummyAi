"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Clock3, RefreshCw, UserRound } from "lucide-react";
import { type WorkflowResponsibilityView } from "@yummyai/contracts/workflow/responsibility";
import { TaskDrawer } from "../navigation/task-drawer";
import type { WorkflowActionState } from "../workflows/workflow-actions";
import "../workflows/workflow-responsibility.css";
export type ResponsibilityValue = Omit<WorkflowResponsibilityView, "runId" | "nodeId"> & {
  sourceChecksum?: string;
  currentTask?: string;
  openExceptionCount?: number;
};
export type ResponsibilitySaveInput = {
  expectedRevision: number;
  expectedSourceChecksum: string;
  assignedUserId: string | null;
  dueAt: string | null;
  escalationUserId: string | null;
  escalationDelayMinutes: number | null;
  reason: string;
};

type Draft = {
  assignedUserId: string;
  dueAt: string;
  escalationUserId: string;
  delay: string;
  reason: string;
  revision: number;
  sourceKey: string;
};
function localDate(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}
function form(value: ResponsibilityValue): Draft {
  return {
    assignedUserId: value.assignedUserId ?? "",
    dueAt: localDate(value.dueAt),
    escalationUserId: value.escalationUserId ?? "",
    delay: String(value.escalationDelayMinutes ?? 60),
    reason: "",
    revision: value.revision,
    sourceKey: value.sourceChecksum ?? String(value.revision),
  };
}
const date = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(
        new Date(value),
      )
    : "未设置";
export function ResponsibilityPanel({
  recordKey,
  revision,
  disabled,
  read,
  save,
  onResult,
  onBusyChange,
  reasonOptions,
  title = "责任与时限",
  drawerTitle = "调整任务责任与时限",
  regionLabel = "任务责任与时限",
}: {
  recordKey: string;
  revision: number;
  disabled: boolean;
  read(search: string, signal: AbortSignal): Promise<ResponsibilityValue>;
  save(input: ResponsibilitySaveInput): Promise<WorkflowActionState<ResponsibilityValue>>;
  onResult?(result: WorkflowActionState<{ revision: number }>): void;
  onBusyChange?(busy: boolean): void;
  reasonOptions?: ReadonlyArray<{ value: string; label: string }>;
  title?: string;
  drawerTitle?: string;
  regionLabel?: string;
}) {
  const formId = useId();
  const [value, setValue] = useState<ResponsibilityValue>(),
    [error, setError] = useState<string>(),
    [editing, setEditing] = useState(false),
    [draft, setDraft] = useState<Draft>(),
    [busy, setBusy] = useState(false),
    [reading, setReading] = useState(false),
    [closing, setClosing] = useState(false),
    [query, setQuery] = useState("");
  const request = useRef<AbortController | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  function closeEditor() {
    if (closing) return;
    const finish = () => {
      setEditing(false);
      setDraft(undefined);
      setClosing(false);
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
    else {
      setClosing(true);
      closeTimer.current = setTimeout(finish, 160);
    }
  }
  const labels = useRef(new Map<string, string>());
  const refresh = useRef<() => void>(() => {});
  refresh.current = () => {
    if (!busy && !reading && !closing && document.visibilityState === "visible") void load(query);
  };
  useEffect(() => {
    const read = () => refresh.current(),
      timer = setInterval(read, 30000);
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", read);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", read);
    };
  }, [recordKey]);
  async function load(search = "", replace = false) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setReading(true);
    setError(undefined);
    try {
      const next = await read(search, controller.signal);
      if (controller.signal.aborted) return;
      for (const candidate of next.candidates) labels.current.set(candidate.id, candidate.label);
      if (next.assignedUserId && next.assignedUserName)
        labels.current.set(next.assignedUserId, next.assignedUserName);
      if (next.escalationUserId && next.escalationUserName)
        labels.current.set(next.escalationUserId, next.escalationUserName);
      setValue(next);
      if (replace) setDraft(form(next));
    } catch (error) {
      if (controller.signal.aborted) return;
      setError(error instanceof Error ? error.message : "责任安排读取未完成");
      if (
        error instanceof Error &&
        [401, 403, 404].includes(Number((error as { status?: number }).status))
      ) {
        setValue(undefined);
        setEditing(false);
        setDraft(undefined);
        labels.current.clear();
      }
    } finally {
      if (!controller.signal.aborted) setReading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [recordKey, revision, read]);
  useEffect(() => {
    onBusyChange?.(editing || busy || closing);
    return () => onBusyChange?.(false);
  }, [editing, busy, closing, onBusyChange]);
  const stale = Boolean(
    draft &&
    (draft.revision < Math.max(revision, value?.revision ?? 0) ||
      Boolean(value && draft.sourceKey !== (value.sourceChecksum ?? String(value.revision)))),
  );
  const changed = Boolean(draft && value && JSON.stringify(draft) !== JSON.stringify(form(value)));
  const update = (patch: Partial<Draft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));
  return (
    <section className="wf-responsibility" aria-label={regionLabel}>
      <header>
        <strong>
          <UserRound size={15} />
          {title}
        </strong>
        <button
          type="button"
          className="oc-button"
          disabled={busy || reading}
          onClick={() => void load()}
          aria-label="刷新责任安排"
        >
          <RefreshCw size={14} />
        </button>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {reading && value ? <p role="status">正在核对责任安排</p> : null}
      {value?.currentTask ? (
        <p>
          {value.currentTask}
          {value.openExceptionCount ? ` · 订单级异常 ${value.openExceptionCount} 项` : ""}
        </p>
      ) : null}
      {value ? (
        <>
          <dl>
            <div>
              <dt>负责人</dt>
              <dd>
                {value.assignedUserName ?? (value.assignedUserId ? "原成员已移除" : "未分配")}
              </dd>
            </div>
            <div>
              <dt>内部截止</dt>
              <dd>{date(value.dueAt)}</dd>
            </div>
            <div>
              <dt>逾期升级</dt>
              <dd>
                {value.escalationUserName
                  ? `${value.escalationUserName} · 逾期 ${value.escalationDelayMinutes} 分钟后`
                  : "未设置"}
              </dd>
            </div>
          </dl>
          {value.assignmentRevision === 0 ? (
            <p>原记录未设置提醒安排</p>
          ) : (
            <p>
              <Clock3 size={13} />
              {value.lastError
                ? {
                    RECIPIENT_UNAVAILABLE: "负责人当前权限或范围不可用 后台稍后复核",
                    ESCALATION_UNAVAILABLE: "升级接收人当前权限或范围不可用 后台稍后复核",
                    SOURCE_UNAVAILABLE: "任务来源不可用 请回到业务详情核对",
                    DISPATCH_FAILED: "提醒保存未完成 后台将按原安排重试",
                  }[value.lastError]
                : value.escalationNotifiedAt
                  ? "已发送逾期升级提醒"
                  : value.dueNotifiedAt
                    ? "已发送到期提醒"
                    : value.assignmentNotifiedAt
                      ? "已发送安排提醒"
                      : value.nextCheckAt
                        ? "安排已保存 等待后台检查"
                        : "当前没有待派发提醒"}
            </p>
          )}
          <button
            type="button"
            className="oc-button"
            disabled={disabled || busy || reading || !value.canManage}
            onClick={() => {
              setDraft(form(value));
              setEditing(true);
            }}
          >
            调整责任与时限
          </button>
        </>
      ) : !error ? (
        <p role="status">正在读取责任安排</p>
      ) : null}
      {editing && draft && value ? (
        <TaskDrawer
          className={`wf-responsibility-drawer${closing ? " wf-responsibility-closing" : ""}`}
          title={drawerTitle}
          recordKey={recordKey}
          state={{ dirty: changed, busy: busy || closing, loading: reading }}
          onClose={closeEditor}
          footer={
            <button
              type="submit"
              form={formId}
              className="oc-button primary"
              disabled={
                busy ||
                reading ||
                closing ||
                disabled ||
                stale ||
                !value.canManage ||
                !draft.reason.trim()
              }
            >
              保存安排
            </button>
          }
        >
          <form
            id={formId}
            className="wf-responsibility-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (stale || busy || reading || closing || !value.canManage) return;
              setBusy(true);
              setError(undefined);
              try {
                const result = await save({
                  expectedRevision: draft.revision,
                  expectedSourceChecksum: draft.sourceKey,
                  assignedUserId: draft.assignedUserId || null,
                  dueAt: draft.dueAt ? new Date(draft.dueAt).toISOString() : null,
                  escalationUserId: draft.escalationUserId || null,
                  escalationDelayMinutes: draft.escalationUserId ? Number(draft.delay) : null,
                  reason: draft.reason,
                });
                onResult?.(result);
                if (result.status === "success" && result.data) {
                  setValue(result.data);
                  closeEditor();
                } else setError(result.message);
              } catch (cause) {
                const status = Number((cause as { status?: number })?.status);
                setError(cause instanceof Error ? cause.message : "安排保存未完成 请刷新后核对");
                if ([401, 403, 404].includes(status)) {
                  setValue(undefined);
                  setEditing(false);
                  setDraft(undefined);
                  labels.current.clear();
                } else if (status === 409) void load();
              } finally {
                setBusy(false);
              }
            }}
          >
            <p>内部安排独立于平台承诺时间 分配任务不会授予数据或执行权限</p>
            {stale ? (
              <div role="alert">
                <p>任务已变化 当前填写保留 请核对最新安排</p>
                <button
                  type="button"
                  className="oc-button"
                  disabled={busy || reading}
                  onClick={() => void load("", true)}
                >
                  放弃填写并载入最新安排
                </button>
              </div>
            ) : null}
            <label>
              查找成员
              <div>
                <input
                  aria-label="查找成员"
                  value={query}
                  disabled={busy || reading}
                  maxLength={100}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <button
                  type="button"
                  className="oc-button"
                  disabled={busy || reading}
                  onClick={() => void load(query)}
                >
                  查找
                </button>
              </div>
            </label>
            <label>
              负责人
              <select
                aria-label="负责人"
                value={draft.assignedUserId}
                disabled={busy || reading || !value.canManage}
                onChange={(event) =>
                  update({
                    assignedUserId: event.target.value,
                    ...(!event.target.value || event.target.value === draft.escalationUserId
                      ? { escalationUserId: "" }
                      : {}),
                  })
                }
              >
                <option value="">未分配</option>
                {draft.assignedUserId &&
                !value.candidates.some(
                  (candidate) => candidate.id === draft.assignedUserId && candidate.canAssign,
                ) ? (
                  <option value={draft.assignedUserId}>
                    {labels.current.get(draft.assignedUserId) ?? "已选成员"} · 保存时复核
                  </option>
                ) : null}
                {value.candidates
                  .filter((candidate) => candidate.canAssign)
                  .map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.label}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              内部截止时间 · 浏览器本地时间
              <input
                aria-label="内部截止时间 · 浏览器本地时间"
                type="datetime-local"
                value={draft.dueAt}
                disabled={busy || reading || !value.canManage}
                onChange={(event) =>
                  update({
                    dueAt: event.target.value,
                    ...(!event.target.value ? { escalationUserId: "" } : {}),
                  })
                }
              />
            </label>
            <label>
              逾期升级接收人
              <select
                aria-label="逾期升级接收人"
                value={draft.escalationUserId}
                disabled={
                  busy || reading || !value.canManage || !draft.dueAt || !draft.assignedUserId
                }
                onChange={(event) => update({ escalationUserId: event.target.value })}
              >
                <option value="">不设置升级提醒</option>
                {draft.escalationUserId &&
                !value.candidates.some(
                  (candidate) =>
                    candidate.id === draft.escalationUserId &&
                    candidate.canEscalate &&
                    candidate.id !== draft.assignedUserId,
                ) ? (
                  <option value={draft.escalationUserId}>
                    {labels.current.get(draft.escalationUserId) ?? "已选成员"} · 保存时复核
                  </option>
                ) : null}
                {value.candidates
                  .filter(
                    (candidate) => candidate.canEscalate && candidate.id !== draft.assignedUserId,
                  )
                  .map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.label}
                    </option>
                  ))}
              </select>
            </label>
            {draft.escalationUserId ? (
              <label>
                逾期后提醒 · 分钟
                <input
                  aria-label="逾期后提醒 · 分钟"
                  type="number"
                  min={1}
                  max={10080}
                  value={draft.delay}
                  disabled={busy || reading}
                  onChange={(event) => update({ delay: event.target.value })}
                />
              </label>
            ) : null}
            <label>
              调整原因
              {reasonOptions ? (
                <select
                  aria-label="调整原因"
                  required
                  value={draft.reason}
                  disabled={busy || reading || !value.canManage}
                  onChange={(event) => update({ reason: event.target.value })}
                >
                  <option value="">选择调整原因</option>
                  {reasonOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  {" "}
                  <textarea
                    aria-label="调整原因"
                    required
                    maxLength={1000}
                    value={draft.reason}
                    disabled={busy || reading || !value.canManage}
                    onChange={(event) => update({ reason: event.target.value })}
                  />
                </>
              )}
            </label>
            {value.candidatesTruncated ? <p>成员过多 请按姓名查找</p> : null}
            {!value.canManage ? <p role="alert">当前没有修改责任安排的权限</p> : null}
            {error ? <p role="alert">{error}</p> : null}
          </form>
        </TaskDrawer>
      ) : null}
    </section>
  );
}
