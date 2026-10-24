"use client";
import { useCallback } from "react";
import Link from "next/link";
import { ArrowUpRight, CalendarClock } from "lucide-react";
import {
  OrderTaskInboxViewSchema,
  type OrderTaskInboxView,
} from "@yummyai/contracts/order/task-inbox";
import type { BusinessTaskInboxQuery } from "@yummyai/contracts/common/task-inbox";
import { ORDER_LIFECYCLE_LABELS } from "@yummyai/contracts/order/workbench";
import { centerRequest, OrderCenterRequestError } from "../order-centers/order-center-model";
import { BusinessTaskInbox, formatTaskDate } from "./business-task-inbox";
import type { BusinessTaskSource } from "./business-task-source-picker";

function location(query: BusinessTaskInboxQuery, target: string) {
  return `/business-tasks?${new URLSearchParams({
    object: "order",
    target,
    ...Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)])),
  })}`;
}
export function OrderTaskInbox({
  reload,
  onChangeSource,
}: {
  reload: number;
  onChangeSource(value: BusinessTaskSource): void;
}) {
  const read = useCallback(
    async (query: string, signal: AbortSignal) =>
      OrderTaskInboxViewSchema.parse(
        await centerRequest(`tasks?${query}`, undefined, signal).catch((error: unknown) => {
          if (error instanceof OrderCenterRequestError && error.status === 404)
            throw new Error("订单跟进待办暂未启用 可先进入订单中心核对");
          throw error;
        }),
      ),
    [],
  );
  return (
    <BusinessTaskInbox<OrderTaskInboxView["items"][number], OrderTaskInboxView>
      reload={reload}
      onChangeSource={onChangeSource}
      source="order"
      title="订单履约待办"
      description="按本件跟进负责人筛选 查看原订单的实际进度"
      regionLabel="订单履约任务收件箱"
      searchPlaceholder="订单号、商品、店铺、SKU 或负责人"
      contextAction={
        <Link href="/orders" className="wi-open">
          打开订单中心
          <ArrowUpRight size={13} />
        </Link>
      }
      read={read}
      columns={["当前任务", "订单与商品", "负责人", "内部截止", "履约状态", ""]}
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
            {item.openExceptionCount > 0 ? (
              <small>订单级异常 {item.openExceptionCount} 项</small>
            ) : null}
            {!item.hasWorkRecord ? (
              <small>先在原订单核对并建立制作资料</small>
            ) : !item.sourceAvailable ? (
              <small>制作资料已到期或不可用 请核对原订单</small>
            ) : null}
            {item.responsibilityRevision === 0 ? <small>尚未设置跟进安排</small> : null}
          </td>
          <td data-label="订单与商品">
            <span>{item.externalOrderId}</span>
            <small>{item.storeName}</small>
            <small>{item.itemTitle}</small>
            <small>
              {item.skuCode ? `${item.skuCode} · ` : ""}本件数量 {item.quantity}
            </small>
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
            {item.platformShipByAt ? (
              <small>平台承诺 {formatTaskDate(item.platformShipByAt, query.timeZone)}</small>
            ) : null}
          </td>
          <td data-label="履约状态">
            <span className="wi-state" data-attention={item.needsAttention}>
              {ORDER_LIFECYCLE_LABELS[item.orderStatus]}
            </span>
            {item.taskKey === "archived" ? (
              <small>本件已归档</small>
            ) : item.taskKey === "cancelled" ? (
              <small>订单已取消</small>
            ) : item.isClosed ? (
              <small>本件履约已结束</small>
            ) : null}
          </td>
          <td data-label="操作">
            <Link prefetch={false} className="wi-open" href={location(query, item.id)}>
              打开任务
              <ArrowUpRight size={14} />
            </Link>
          </td>
        </tr>
      )}
    />
  );
}
