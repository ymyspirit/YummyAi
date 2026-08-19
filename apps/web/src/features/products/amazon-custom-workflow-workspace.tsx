"use client";

import {
  AMAZON_CUSTOM_WORKFLOW_STEPS,
  type AmazonCustomWorkflowDetail,
  type AmazonCustomWorkflowStepKey,
  type AmazonCustomWorkflowStepStatus,
  type AmazonCustomWorkflowSummary,
} from "@yummyai/contracts/catalog/amazon-custom-workflow";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  CircleDot,
  Clock3,
  ListChecks,
  LockKeyhole,
  Play,
  RotateCcw,
} from "lucide-react";
import Link from "next/link";
import { useActionState } from "react";

import {
  startAmazonCustomWorkflow,
  transitionAmazonCustomWorkflowStep,
  updateAmazonCustomWorkflowStepNote,
  type AmazonCustomWorkflowActionState,
} from "./amazon-custom-workflow-actions";

const initialState: AmazonCustomWorkflowActionState = { message: "", status: "idle" };

export function AmazonCustomWorkflowWorkspace({
  detail,
  error,
  items,
  selectedPlanId,
}: {
  detail?: AmazonCustomWorkflowDetail;
  error?: string;
  items: AmazonCustomWorkflowSummary[];
  selectedPlanId?: string;
}) {
  const activeCount = items.filter((item) => item.status === "active").length;
  const blockedCount = items.filter((item) => item.status === "blocked").length;
  const completedCount = items.filter((item) => item.status === "completed").length;

  return (
    <section className="custom-workflow-workspace" aria-labelledby="custom-workflow-title">
      <header className="custom-workflow-heading">
        <div>
          <p className="section-code">PRODUCT TASK CONTROL</p>
          <h2 id="custom-workflow-title">产品开发进度</h2>
          <p>每个产品独立保存 14 个任务状态、阻断原因、操作人和事件历史。</p>
        </div>
        <span className="custom-workflow-boundary">
          <LockKeyhole aria-hidden="true" size={16} />
          顺序推进
        </span>
      </header>

      <dl className="custom-workflow-metrics">
        <Metric label="全部产品" value={items.length} />
        <Metric label="执行中" value={activeCount} />
        <Metric label="已阻断" value={blockedCount} tone="danger" />
        <Metric label="已完成" value={completedCount} tone="success" />
      </dl>

      {error ? (
        <div className="custom-workflow-load-state" role="alert">
          <AlertTriangle aria-hidden="true" size={18} />
          <div>
            <strong>产品流程暂不可用</strong>
            <span>{error}</span>
          </div>
        </div>
      ) : items.length ? (
        <div className="custom-workflow-table-scroll">
          <table className="custom-workflow-table">
            <thead>
              <tr>
                <th>产品</th>
                <th>负责人</th>
                <th>当前任务</th>
                <th>流程状态</th>
                <th>完成度</th>
                <th>最近更新</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  className={item.productPlanId === selectedPlanId ? "is-selected" : undefined}
                  key={item.productPlanId}
                >
                  <td>
                    <strong>{item.productName}</strong>
                    <span>{item.spuCode ?? item.skuCodes[0] ?? "SPU/SKU 待创建"}</span>
                  </td>
                  <td>{item.ownerName ?? "负责人待分配"}</td>
                  <td>
                    <b>{item.currentStepTitle ?? "全部任务已完成"}</b>
                    {item.latestBlocker ? <small>{item.latestBlocker}</small> : null}
                  </td>
                  <td>
                    <StatusLabel status={item.status} />
                  </td>
                  <td className="mono">
                    {item.completedSteps} / {item.totalSteps}
                  </td>
                  <td>{formatDate(item.updatedAt)}</td>
                  <td>
                    <Link href={`/amazon-custom-sop?plan=${item.productPlanId}#workflow-detail`}>
                      {item.status === "not_started" ? "开始" : "查看"}
                      <ArrowUpRight aria-hidden="true" size={13} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="custom-workflow-empty">
          <ListChecks aria-hidden="true" size={22} />
          <div>
            <strong>还没有产品企划</strong>
            <p>先在产品目录创建产品，系统会自动把它列入流程看板。</p>
          </div>
          <Link href="/products">创建产品企划</Link>
        </div>
      )}

      {selectedPlanId ? (
        detail ? (
          <WorkflowDetail detail={detail} />
        ) : error ? null : (
          <p className="custom-workflow-selection-error" role="alert">
            指定产品不存在或当前成员无权访问。
          </p>
        )
      ) : items.length ? (
        <div className="custom-workflow-selection-hint">
          <CircleDot aria-hidden="true" size={17} />
          <p>从上表选择一个产品，查看并执行它的 14 个任务步骤。</p>
        </div>
      ) : null}
    </section>
  );
}

function WorkflowDetail({ detail }: { detail: AmazonCustomWorkflowDetail }) {
  return (
    <section className="custom-workflow-detail" id="workflow-detail" aria-labelledby="workflow-detail-title">
      <header>
        <div>
          <p className="section-code">SELECTED PRODUCT WORKFLOW</p>
          <h3 id="workflow-detail-title">{detail.productName}</h3>
          <p>
            当前任务：{detail.currentStepTitle ?? "全部完成"}，已完成 {detail.completedSteps} /{" "}
            {detail.totalSteps}
          </p>
        </div>
        <Link href={`/products?plan=${detail.productPlanId}#product-detail`}>
          打开产品档案
          <ArrowUpRight aria-hidden="true" size={13} />
        </Link>
      </header>

      {detail.status === "not_started" ? (
        <StartWorkflow planId={detail.productPlanId} />
      ) : (
        <>
          <div className="custom-workflow-step-table" role="table" aria-label="Amazon Custom 任务步骤">
            <div className="custom-workflow-step-head" role="row">
              <span role="columnheader">任务</span>
              <span role="columnheader">责任与位置</span>
              <span role="columnheader">状态</span>
              <span role="columnheader">操作</span>
            </div>
            {detail.steps.map((step, index) => (
              <div
                className={`custom-workflow-step-row state-${step.status}`}
                role="row"
                key={step.key}
              >
                <div className="custom-workflow-step-name" role="cell">
                  <span className="mono">{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <strong>{step.title}</strong>
                    <small>{step.updatedByName ? `${step.updatedByName}，${formatDate(step.updatedAt)}` : "尚无操作记录"}</small>
                  </div>
                </div>
                <div className="custom-workflow-step-owner" role="cell">
                  <strong>{step.ownerRole}</strong>
                  <span>{step.system} / {step.location}</span>
                </div>
                <div role="cell">
                  <StepStatus status={step.status} />
                  {step.note ? <small className="custom-workflow-step-note">{step.note}</small> : null}
                </div>
                <div className="custom-workflow-step-actions" role="cell">
                  <StepActions
                    detail={detail}
                    index={index}
                    note={step.note}
                    status={step.status}
                    stepKey={step.key}
                  />
                </div>
              </div>
            ))}
          </div>
          <WorkflowEvents detail={detail} />
        </>
      )}
    </section>
  );
}

function StartWorkflow({ planId }: { planId: string }) {
  const [state, action, pending] = useActionState(
    startAmazonCustomWorkflow.bind(null, planId),
    initialState,
  );
  return (
    <div className="custom-workflow-start">
      <Play aria-hidden="true" size={20} />
      <div>
        <strong>该产品尚未开始 Amazon Custom 流程</strong>
        <p>创建后第一个任务“录入竞品研究资料”会立即进入执行中。</p>
      </div>
      <form action={action}>
        <button disabled={pending} type="submit">
          {pending ? "创建中..." : "创建并开始"}
        </button>
      </form>
      <ActionNotice state={state} />
    </div>
  );
}

function StepActions({
  detail,
  index,
  note,
  status,
  stepKey,
}: {
  detail: AmazonCustomWorkflowDetail;
  index: number;
  note?: string;
  status: AmazonCustomWorkflowStepStatus;
  stepKey: AmazonCustomWorkflowStepKey;
}) {
  const isCurrent = detail.currentStepKey === stepKey;
  const laterSteps = detail.steps.slice(index + 1);
  const canReopen =
    status === "completed" && laterSteps.every((step) => step.status === "not_started");
  if (status === "not_started" && isCurrent) {
    return (
      <TransitionForm
        expectedRevision={detail.revision}
        label="开始任务"
        planId={detail.productPlanId}
        status="in_progress"
        stepKey={stepKey}
      />
    );
  }
  if (status === "in_progress") {
    return (
      <div className="custom-workflow-active-actions">
        <TransitionForm
          expectedRevision={detail.revision}
          label="完成"
          noteLabel="完成说明（选填）"
          planId={detail.productPlanId}
          status="completed"
          stepKey={stepKey}
        />
        <TransitionForm
          expectedRevision={detail.revision}
          label="设为阻断"
          noteLabel="阻断原因"
          noteRequired
          planId={detail.productPlanId}
          status="blocked"
          stepKey={stepKey}
          tone="danger"
        />
      </div>
    );
  }
  if (status === "blocked") {
    return (
      <TransitionForm
        expectedRevision={detail.revision}
        label="解除阻断"
        noteLabel="处理结果（选填）"
        planId={detail.productPlanId}
        status="in_progress"
        stepKey={stepKey}
      />
    );
  }
  if (status === "completed") {
    return (
      <div className="custom-workflow-completed-actions">
        <CompletedStepNoteEditor
          expectedRevision={detail.revision}
          note={note}
          planId={detail.productPlanId}
          stepKey={stepKey}
        />
        {canReopen ? (
          <TransitionForm
            expectedRevision={detail.revision}
            icon="reopen"
            label="返工重开"
            noteLabel="返工原因"
            noteRequired
            planId={detail.productPlanId}
            status="in_progress"
            stepKey={stepKey}
          />
        ) : null}
      </div>
    );
  }
  return <span className="custom-workflow-no-action">无需操作</span>;
}

function CompletedStepNoteEditor({
  expectedRevision,
  note,
  planId,
  stepKey,
}: {
  expectedRevision: number;
  note?: string;
  planId: string;
  stepKey: AmazonCustomWorkflowStepKey;
}) {
  const [state, action, pending] = useActionState(
    updateAmazonCustomWorkflowStepNote.bind(null, planId, stepKey),
    initialState,
  );
  return (
    <details className="custom-workflow-completed-editor">
      <summary>编辑完成记录</summary>
      <form action={action} className="custom-workflow-transition">
        <input name="expectedRevision" type="hidden" value={expectedRevision} />
        <label>
          <span>完成说明</span>
          <input defaultValue={note ?? ""} maxLength={1_000} name="note" />
        </label>
        <button disabled={pending} type="submit">
          {pending ? "保存中..." : "保存说明"}
        </button>
        <ActionNotice state={state} />
      </form>
    </details>
  );
}

function TransitionForm({
  expectedRevision,
  icon,
  label,
  noteLabel,
  noteRequired,
  planId,
  status,
  stepKey,
  tone,
}: {
  expectedRevision: number;
  icon?: "reopen";
  label: string;
  noteLabel?: string;
  noteRequired?: boolean;
  planId: string;
  status: "in_progress" | "blocked" | "completed";
  stepKey: AmazonCustomWorkflowStepKey;
  tone?: "danger";
}) {
  const [state, action, pending] = useActionState(
    transitionAmazonCustomWorkflowStep.bind(null, planId, stepKey),
    initialState,
  );
  return (
    <form action={action} className={`custom-workflow-transition ${tone ?? ""}`}>
      <input name="expectedRevision" type="hidden" value={expectedRevision} />
      <input name="status" type="hidden" value={status} />
      {noteLabel ? (
        <label>
          <span>{noteLabel}</span>
          <input maxLength={1_000} name="note" required={noteRequired} />
        </label>
      ) : null}
      <button disabled={pending} type="submit">
        {icon === "reopen" ? <RotateCcw aria-hidden="true" size={13} /> : null}
        {pending ? "保存中..." : label}
      </button>
      <ActionNotice state={state} />
    </form>
  );
}

function WorkflowEvents({ detail }: { detail: AmazonCustomWorkflowDetail }) {
  return (
    <details className="custom-workflow-events">
      <summary>
        事件记录
        <span>{detail.events.length} 条</span>
      </summary>
      {detail.events.length ? (
        <ol>
          {detail.events.map((event) => (
            <li key={event.id}>
              <span className="mono">R{event.revision}</span>
              <div>
                <strong>{eventLabel(event.action)}</strong>
                <small>
                  {stepTitle(event.stepKey)} / {event.actorName} / {formatDate(event.occurredAt)}
                </small>
                {event.note ? <p>{event.note}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p>暂无事件记录。</p>
      )}
    </details>
  );
}

function Metric({
  label,
  tone = "neutral",
  value,
}: {
  label: string;
  tone?: "neutral" | "danger" | "success";
  value: number;
}) {
  return (
    <div className={`tone-${tone}`}>
      <dt>{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  );
}

function StatusLabel({ status }: { status: AmazonCustomWorkflowSummary["status"] }) {
  return <span className={`custom-workflow-status status-${status}`}>{workflowStatusLabel(status)}</span>;
}

function StepStatus({ status }: { status: AmazonCustomWorkflowStepStatus }) {
  const Icon =
    status === "completed"
      ? CheckCircle2
      : status === "blocked"
        ? AlertTriangle
        : status === "in_progress"
          ? Clock3
          : CircleDot;
  return (
    <span className={`custom-workflow-step-status status-${status}`}>
      <Icon aria-hidden="true" size={13} />
      {stepStatusLabel(status)}
    </span>
  );
}

function ActionNotice({ state }: { state: AmazonCustomWorkflowActionState }) {
  return state.status === "idle" ? null : (
    <p className={`custom-workflow-action-notice ${state.status}`} role={state.status === "error" ? "alert" : "status"}>
      {state.message}
    </p>
  );
}

function workflowStatusLabel(status: AmazonCustomWorkflowSummary["status"]) {
  return {
    not_started: "未开始",
    active: "执行中",
    blocked: "已阻断",
    completed: "已完成",
  }[status];
}

function stepStatusLabel(status: AmazonCustomWorkflowStepStatus) {
  return {
    not_started: "待开始",
    in_progress: "执行中",
    blocked: "已阻断",
    completed: "已完成",
  }[status];
}

function eventLabel(action: AmazonCustomWorkflowDetail["events"][number]["action"]) {
  return {
    workflow_started: "流程已创建",
    step_started: "任务已开始",
    step_blocked: "任务被阻断",
    step_unblocked: "阻断已解除",
    step_completed: "任务已完成",
    step_note_updated: "完成说明已更新",
    step_reopened: "任务已重新打开",
  }[action];
}

function stepTitle(key: AmazonCustomWorkflowStepKey) {
  return AMAZON_CUSTOM_WORKFLOW_STEPS.find((step) => step.key === key)?.title ?? key;
}

function formatDate(value?: string) {
  if (!value) return "尚未更新";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
