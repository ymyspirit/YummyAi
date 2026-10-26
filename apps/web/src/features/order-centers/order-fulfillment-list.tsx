"use client";
import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { OrderWorkListItem, OrderWorkspaceModule } from "@yummyai/contracts/order/workspace";
import { orderOperatorTask } from "@yummyai/contracts/order/workbench";
import { OrderLifecycleBadge } from "./order-lifecycle";
import { dateTime } from "./order-center-model";
import { OrderDeadlineSummary } from "./order-deadline-summary";
import { fulfillmentDeadlineRows, orderProductLabel } from "./order-operations-summary";

export function fulfillmentGroups(items: OrderWorkListItem[]) {
  const groups = new Map<string, OrderWorkListItem[]>();
  for (const item of items) groups.set(item.orderId, [...(groups.get(item.orderId) ?? []), item]);
  return [...groups].map(([orderId, lines]) => {
    const priority = ["held", "verify_source", "complete_information", "production_attention", "design_attention", "customer_changes", "after_sales", "review_order", "dispatch_design", "review_artwork", "customer_proof", "waiting_design", "waiting_production", "waiting_shipping", "confirm_shipment", "complete", "cancelled", "archived"];
    const production = ["not_released", "cancelled", "planned", "submitted", "acknowledged", "in_production", "awaiting_quality", "completed"];
    const current = lines.toSorted((a, b) => priority.indexOf(orderOperatorTask(a).key) - priority.indexOf(orderOperatorTask(b).key) || production.indexOf(a.production) - production.indexOf(b.production))[0]!;
    return { orderId, lines, current, task: orderOperatorTask(current), quantity: lines.reduce((sum, line) => sum + line.quantity, 0), shipped: lines.reduce((sum, line) => sum + line.shippedQuantity, 0) };
  });
}
export function OrderFulfillmentList({ items, module, loading, unavailable, selectedId, onDetail }: {
  items: OrderWorkListItem[]; module: "production" | "shipments" | "after-sales"; loading: boolean; unavailable: boolean;
  selectedId: string | null; onDetail(id: string, mode?: OrderWorkspaceModule): void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const groups = fulfillmentGroups(items);
  return <div className="oc-table-wrap"><table className="oc-table oc-fulfillment-list" aria-label={module === "production" ? "整单生产列表" : module === "shipments" ? "整单发货列表" : "整单售后列表"}>
    <caption>筛选决定本页订单 · 按整单展示关联商品与履约进度</caption>
    <thead><tr><th>订单 / 本单商品</th><th>订单状态 / 当前任务</th><th>商品行 / 件数</th><th>平台发货截止</th><th>人工计划（可选）</th><th>下一步</th></tr></thead>
    <tbody>{!loading && !groups.length && <tr><td colSpan={6} className="oc-empty">{unavailable ? "订单暂时无法读取，请重试。" : module === "after-sales" ? "暂无符合条件的售后订单。" : "暂无符合条件的订单。"}
      {!unavailable && module === "production" && <p>审图通过并准备正式生产文件后，再安排工厂生产。<Link href="/orders">回订单中心核对审单与图稿</Link>，也可调整当前筛选。</p>}
    </td></tr>}
      {groups.map(group => {
        const first = group.lines[0]!, open = expanded.has(group.orderId);
        const deadline = fulfillmentDeadlineRows(group.lines);
        const wholeLoaded = first.orderLineCount !== undefined && first.orderLineCount === group.lines.length;
        return <Fragment key={group.orderId}><tr className={group.lines.some(line => line.id === selectedId) ? "oc-current-order" : ""} data-order-id={group.orderId}>
          <td data-label="订单 / 本单商品"><button className="oc-text-button" onClick={() => onDetail(group.current.id, module)}>{first.externalOrderId}</button><small>{first.storeName} · 本单展示 {group.lines.length} 商品行</small>
            <button className="oc-text-button oc-expand-items" aria-expanded={open} aria-controls={`order-items-${group.orderId}`} onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(group.orderId)) next.delete(group.orderId); else next.add(group.orderId); return next; })}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{open ? "收起" : "展开"}本单商品</button></td>
          <td data-label="订单状态 / 当前任务"><OrderLifecycleBadge status={first.orderStatus} /><small>{module === "after-sales" ? first.afterSalesCount ? `${first.afterSalesCount} 个未结案问题` : "售后已结案，保留历史" : group.task.title}</small></td>
          <td data-label="商品行 / 件数"><span>整单 {first.orderLineCount === undefined ? "行数待核对" : `${first.orderLineCount} 商品行`} · {first.orderQuantity === undefined ? "件数待核对" : `${first.orderQuantity} 件`}</span>
            <small>本单展示 {group.lines.length} 商品行 · {group.quantity} 件</small>
            {module === "shipments" && <small>{wholeLoaded ? "整单" : "展示商品行"}实际出库 {group.shipped}/{group.quantity} 件</small>}</td>
          <td data-label="平台发货截止">{first.orderStatus === "voided" ? <span>已作废 · 保留原订单记录</span> : deadline.deadlineRow && <>
            <OrderDeadlineSummary row={deadline.deadlineRow} includeInternal={false} />
            {deadline.missingAmazonLineCount > 0 && <small className="oc-deadline-missing">本单 {deadline.missingAmazonLineCount} 个未出库商品行的平台交期待核对</small>}
            {!wholeLoaded && <small className="oc-deadline-missing">全部商品行的交期请打开整单核对</small>}
          </>}</td>
          <td data-label="人工计划（可选）">{deadline.internalPlanAt ? <details className="oc-internal-time"><summary>查看人工计划</summary><time dateTime={deadline.internalPlanAt}>{dateTime(deadline.internalPlanAt)}</time><small>不替代平台截止</small></details> : <span className="oc-muted">可不填</span>}<small>更新 {dateTime(first.updatedAt)}</small></td>
          <td><button className="oc-button" disabled={loading || unavailable} onClick={() => onDetail(group.current.id, module === "after-sales" ? module : group.task.module)}>{module === "after-sales" ? "处理售后" : group.task.action}</button></td>
        </tr>{open && <tr id={`order-items-${group.orderId}`} className="oc-expanded-items"><td colSpan={6}><ul>{group.lines.map(line => <li key={line.id}><strong>{orderProductLabel(line)} · {line.quantity} 件</strong><span>{line.skuCode ?? "SKU 待补充"} · {line.specificationName ?? "规格待核对"}</span><small>{orderOperatorTask(line).title} · 需求 {line.revision ? `V${line.revision}` : "待整理"}</small><details className="oc-original-title"><summary>平台原商品标题</summary><p>{line.title}</p></details></li>)}</ul></td></tr>}</Fragment>;
      })}
    </tbody></table></div>;
}
