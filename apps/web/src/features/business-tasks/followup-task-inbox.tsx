"use client";
import { useCallback } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  FollowupTaskInboxViewSchema,
  type FollowupTaskInboxView,
  type FollowupSource,
} from "@yummyai/contracts/operations/followup";
import { BusinessTaskInbox, formatTaskDate } from "./business-task-inbox";
import type { BusinessTaskSource } from "./business-task-source-picker";
import {
  followupNames,
  followupRequest,
  followupStatus,
  followupContext,
} from "./followup-request";
import { label } from "../order-centers/order-center-model";
export function FollowupTaskInbox({
  source,
  reload,
  onChangeSource,
}: {
  source: FollowupSource;
  reload: number;
  onChangeSource(value: BusinessTaskSource): void;
}) {
  const read = useCallback(
    async (query: string, signal: AbortSignal) =>
      FollowupTaskInboxViewSchema.parse(await followupRequest(source, `tasks?${query}`, signal)),
    [source],
  );
  return (
    <BusinessTaskInbox<FollowupTaskInboxView["items"][number], FollowupTaskInboxView>
      source={source}
      reload={reload}
      onChangeSource={onChangeSource}
      title={followupNames[source]}
      regionLabel={followupNames[source] + "任务收件箱"}
      description="按负责人和内部截止筛选 核对原业务的实际处理进度"
      searchPlaceholder="业务编号、类型或负责人"
      read={read}
      columns={["当前任务", "业务对象", "负责人", "内部截止", "处理状态", ""]}
      renderSummary={(value) => (
        <>
          <strong>筛选结果 {value.total} 项</strong>
          <span>逾期 {value.summary.overdue}</span>
          <span>今日到期 {value.summary.dueToday}</span>
          <span>需要核对 {value.summary.attention}</span>
          <span>未分配 {value.summary.unassigned}</span>
          <span>资料不可用 {value.summary.unavailable}</span>
        </>
      )}
      renderRow={(item, query) => (
        <tr key={item.id} className="wi-row" data-task-id={item.id}>
          <td data-label="当前任务">
            <strong>{item.title}</strong>
            {!item.available && <small>资料不可用 请核对原业务记录</small>}
            {item.issueCount > 0 && <small>待核对 {item.issueCount} 项</small>}
            {item.responsibilityRevision === 0 && <small>尚未设置跟进安排</small>}
          </td>
          <td data-label="业务对象">
            <span>{item.label}</span>
            <small>{label(followupContext(source, item.contextLabel))}</small>
          </td>
          <td data-label="负责人">
            {item.assignedUserName ?? (item.assignedUserId ? "原成员不可用" : "未分配")}
          </td>
          <td data-label="内部截止" data-overdue={item.isOverdue}>
            {item.dueAt ? (
              <>
                <time dateTime={item.dueAt}>{formatTaskDate(item.dueAt, query.timeZone)}</time>
                {item.isOverdue ? (
                  <small>已逾期</small>
                ) : item.isDueToday ? (
                  <small>今日到期</small>
                ) : null}
              </>
            ) : (
              "未设置"
            )}
            {item.businessDueAt && (
              <small>预计到货 {formatTaskDate(item.businessDueAt, query.timeZone)}</small>
            )}
          </td>
          <td data-label="处理状态">
            <span className="wi-state" data-attention={item.needsAttention}>
              {followupStatus(source, item.status)}
            </span>
            {item.isClosed && <small>当前跟进已结束</small>}
          </td>
          <td data-label="操作">
            <Link
              className="wi-open"
              prefetch={false}
              href={`/business-tasks?${new URLSearchParams({ object: source, target: item.id, ...Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)])) })}`}
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
