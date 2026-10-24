"use client";
import { useCallback } from "react";
import Link from "next/link";
import { ArrowUpRight, CalendarClock } from "lucide-react";
import {
  WorkflowTaskInboxViewSchema,
  type WorkflowTaskInboxView,
} from "@yummyai/contracts/workflow/task-inbox";
import { readWorkflow } from "../workflows/workflow-operator-client";
import { BusinessTaskInbox, formatTaskDate } from "./business-task-inbox";
import type { BusinessTaskSource } from "./business-task-source-picker";
const nodeLabels = {
  not_started: "待上游",
  in_progress: "处理中",
  blocked: "已阻断",
  failed: "执行失败",
  completed: "已完成",
  skipped: "已跳过",
  cancelled: "已停止",
};

export function WorkflowTaskInbox({
  reload,
  onChangeSource,
}: {
  reload: number;
  onChangeSource(value: BusinessTaskSource): void;
}) {
  const read = useCallback(
    (query: string, signal: AbortSignal) =>
      readWorkflow(`tasks?${query}`, WorkflowTaskInboxViewSchema, signal),
    [],
  );
  return (
    <BusinessTaskInbox<WorkflowTaskInboxView["items"][number], WorkflowTaskInboxView>
      reload={reload}
      onChangeSource={onChangeSource}
      source="workflow"
      title="工作流待办"
      description="每个节点一项任务 状态以原流程为准"
      regionLabel="工作流任务收件箱"
      searchPlaceholder="任务、流程、商品或负责人"
      read={read}
      columns={["任务", "商品与流程", "负责人", "内部截止", "当前状态", ""]}
      renderSummary={(value) => (
        <>
          <strong>筛选结果 {value.total} 项</strong>
          <span>逾期 {value.summary.overdue}</span>
          <span>今日到期 {value.summary.dueToday}</span>
          <span>阻断或失败 {value.summary.blocked}</span>
          <span>待上游 {value.summary.upcoming}</span>
          <span>未分配 {value.summary.unassigned}</span>
        </>
      )}
      renderRow={(item, query) => (
        <tr key={item.id} className="wi-row" data-task-id={item.id}>
          <td data-label="任务">
            <strong>{item.title}</strong>
            <small>
              {item.definitionMissing
                ? "任务定义待核对"
                : item.isClosed
                  ? "原流程记录"
                  : item.isCurrent
                    ? "当前节点"
                    : "待上游节点"}
            </small>
            {item.responsibilityRevision === 0 ? <small>尚未设置提醒安排</small> : null}
          </td>
          <td data-label="商品与流程">
            <span>{item.productName}</span>
            <small>
              {item.runTitle} · 流程 v{item.definitionVersion}
            </small>
            {item.productArchived ? <small>商品已归档 任务状态保留</small> : null}
          </td>
          <td data-label="负责人">
            {item.assignedUserName ?? (item.assignedUserId ? "原成员已移除" : "未分配")}
          </td>
          <td data-label="内部截止" data-overdue={item.isOverdue}>
            {item.dueAt ? (
              <>
                <time dateTime={item.dueAt}>{formatTaskDate(item.dueAt, query.timeZone)}</time>
                {item.isOverdue ? (
                  <small>
                    <CalendarClock size={12} />
                    已逾期
                  </small>
                ) : item.isDueToday ? (
                  <small>今日到期</small>
                ) : null}
              </>
            ) : (
              "未设置"
            )}
          </td>
          <td data-label="当前状态">
            <span
              className="wi-state"
              data-attention={item.nodeStatus === "blocked" || item.nodeStatus === "failed"}
            >
              {nodeLabels[item.nodeStatus]}
            </span>
            {item.runStatus === "cancelled" ? (
              <small>流程已停止</small>
            ) : item.runStatus === "completed" ? (
              <small>流程已完成</small>
            ) : null}
          </td>
          <td data-label="操作">
            <Link
              prefetch={false}
              className="wi-open"
              href={`/workflows/runs/${item.runId}?task=${item.id}`}
            >
              打开任务
              <ArrowUpRight size={14} />
            </Link>
          </td>
        </tr>
      )}
    />
  );
}
