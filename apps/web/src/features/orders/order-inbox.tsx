import { CircleAlert, ClipboardCheck, ClipboardList, Factory, MapPin, PackageCheck, PackageOpen, RadioTower, RotateCcw, Siren } from "lucide-react";
import type { OrderCustomizationSummaryView, OrderExceptionView, OrderIngestionRunView, OrderView, OrderWorkflowState } from "@yummyai/contracts";

export interface ProductionQueueItem {
  id: string; orderId: string; status: string; source: string; projectionVersion: number;
  currentVersionNumber: number; expectedCompletionAt: string; updatedAt: string;
}

export interface ShipmentQueueItem {
  id: string; orderId: string; status: string; currentVersionNumber: number;
  approvedVersionNumber: number | null; updatedAt: string;
}

export interface AfterSalesQueueItem {
  id: string; orderId: string; type: string; status: string; reasonCode: string;
  currentDecisionVersion: number; updatedAt: string;
}

export interface OperationalQueues {
  production: ProductionQueueItem[]; shipments: ShipmentQueueItem[];
  exceptions: OrderExceptionView[]; afterSales: AfterSalesQueueItem[];
  errors?: Partial<Record<"production" | "shipments" | "exceptions" | "afterSales", string>>;
}

const workflowStages: ReadonlyArray<{ label: string; state: OrderWorkflowState }> = [
  { label: "待处理", state: "pending" },
  { label: "待定制", state: "awaiting_customization" },
  { label: "待设计", state: "awaiting_design" },
  { label: "待确认", state: "awaiting_customer_approval" },
  { label: "待路由", state: "awaiting_routing" },
  { label: "生产中", state: "in_production" },
  { label: "待质检", state: "awaiting_quality_control" },
  { label: "待发货", state: "awaiting_shipment" },
  { label: "已发货", state: "shipped" },
  { label: "已完成", state: "completed" },
];

export function OrderInbox({
  items, runs = [], syncError, customizations = [], customizationError, operations,
}: {
  items: OrderView[];
  runs?: OrderIngestionRunView[];
  syncError?: string;
  customizations?: OrderCustomizationSummaryView[];
  customizationError?: string;
  operations?: OperationalQueues;
}) {
  const counts = new Map<OrderWorkflowState, number>();
  for (const order of items) counts.set(order.workflowState, (counts.get(order.workflowState) ?? 0) + 1);

  return (
    <>
      <IngestionEvidence runs={runs} error={syncError} />
      <section className="order-pipeline" aria-labelledby="order-pipeline-title">
        <header>
          <div>
            <p className="section-code">WORKFLOW SIGNAL</p>
            <h2 id="order-pipeline-title">订单流水线</h2>
          </div>
          <span>主状态与暂停/取消状态分离</span>
        </header>
        <ol>
          {workflowStages.map((stage, index) => {
            const count = counts.get(stage.state) ?? 0;
            return (
              <li className={count > 0 ? "has-orders" : undefined} key={stage.state}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{stage.label}</strong>
                <b>{count}</b>
              </li>
            );
          })}
        </ol>
      </section>

      <CustomizationQueue items={items} requirements={customizations} error={customizationError} />

      <OperationsWorkspace items={items} operations={operations} />

      <section className="order-ledger" aria-labelledby="order-ledger-title">
        <header>
          <div>
            <p className="section-code">PUBLIC ORDER PROJECTION</p>
            <h2 id="order-ledger-title">订单队列</h2>
          </div>
          <span>{items.length} ORDERS</span>
        </header>
        {items.length === 0 ? (
          <div className="order-empty">
            <ClipboardList size={25} />
            <strong>暂无订单</strong>
            <span>订单连接器写入首个不可变来源快照后，订单会出现在这里。</span>
          </div>
        ) : (
          <div className="order-table-scroll">
            <table className="order-table">
              <thead>
                <tr>
                  <th>渠道 / 订单</th>
                  <th>商品行</th>
                  <th>订单金额</th>
                  <th>履约状态</th>
                  <th>目的地</th>
                  <th>事件序号</th>
                  <th>下单时间</th>
                </tr>
              </thead>
              <tbody>
                {items.map((order) => (
                  <tr id={`order-${order.id}`} key={order.id}>
                    <td>
                      <span className={`platform-stamp platform-${order.platform}`}>{order.platform}</span>
                      <strong>{order.externalOrderId}</strong>
                      <code>{order.providerStatus}</code>
                    </td>
                    <td>
                      <details className="order-lines">
                        <summary><PackageOpen size={14} />{order.lineCount} 个商品行</summary>
                        <ol>
                          {order.lines.map((line) => (
                            <li key={line.id}>
                              <span>{line.title}</span>
                              <small>{line.skuCode ?? "无 SKU"} · ×{line.quantity}</small>
                            </li>
                          ))}
                        </ol>
                      </details>
                    </td>
                    <td className="order-money">{formatMoney(order.orderTotal.amountMinor, order.orderTotal.currency)}</td>
                    <td>
                      <span className={`order-state state-${order.workflowState}`}>{workflowLabel(order.workflowState)}</span>
                      {order.sideState ? <span className={`order-side-state ${order.sideState}`}><CircleAlert size={12} />{sideStateLabel(order.sideState)}</span> : null}
                    </td>
                    <td><span className={`order-address address-${order.address.status}`}><MapPin size={13} />{addressLabel(order)}</span></td>
                    <td className="order-sequence">#{String(order.latestEventSequence).padStart(3, "0")}</td>
                    <td><time dateTime={order.placedAt}>{formatDate(order.placedAt)}</time></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function OperationsWorkspace({ items, operations }: { items: OrderView[]; operations?: OperationalQueues }) {
  const orders = new Map(items.map((order) => [order.id, order.externalOrderId]));
  const data = operations ?? { production: [], shipments: [], exceptions: [], afterSales: [] };
  const lanes = [
    {
      key: "production" as const, label: "生产", code: "PRODUCTION", icon: Factory,
      items: data.production, render: (item: ProductionQueueItem) => <>
        <div><strong>{orders.get(item.orderId) ?? shortId(item.orderId)}</strong><span className={`ops-status state-${item.status}`}>{productionStatusLabel(item.status)}</span></div>
        <p>{item.source === "remake" ? "重做工单" : "初始工单"} · 预计 {formatDate(item.expectedCompletionAt)}</p>
        <code>v{item.currentVersionNumber} · projection {item.projectionVersion}</code>
      </>,
    },
    {
      key: "shipments" as const, label: "物流", code: "LOGISTICS", icon: PackageCheck,
      items: data.shipments, render: (item: ShipmentQueueItem) => <>
        <div><strong>{orders.get(item.orderId) ?? shortId(item.orderId)}</strong><span className={`ops-status state-${item.status}`}>{shipmentStatusLabel(item.status)}</span></div>
        <p>{item.approvedVersionNumber ? `已批准 v${item.approvedVersionNumber}` : "等待版本批准"}</p>
        <code>current v{item.currentVersionNumber} · {formatDate(item.updatedAt)}</code>
      </>,
    },
    {
      key: "exceptions" as const, label: "异常", code: "EXCEPTIONS", icon: Siren,
      items: data.exceptions.filter((item) => item.status === "open"), render: (item: OrderExceptionView) => <>
        <div><strong>{orders.get(item.orderId) ?? shortId(item.orderId)}</strong><span className="ops-status state-exception">待处理</span></div>
        <p>{exceptionCategoryLabel(item.category)} · {item.code}</p>
        <code>{formatDate(item.openedAt)}</code>
      </>,
    },
    {
      key: "afterSales" as const, label: "售后", code: "AFTER-SALES", icon: RotateCcw,
      items: data.afterSales.filter((item) => !["resolved", "cancelled"].includes(item.status)), render: (item: AfterSalesQueueItem) => <>
        <div><strong>{orders.get(item.orderId) ?? shortId(item.orderId)}</strong><span className={`ops-status state-${item.status}`}>{afterSalesStatusLabel(item.status)}</span></div>
        <p>{afterSalesTypeLabel(item.type)} · {item.reasonCode}</p>
        <code>decision v{item.currentDecisionVersion} · {formatDate(item.updatedAt)}</code>
      </>,
    },
  ];

  return (
    <section className="order-operations" aria-labelledby="order-operations-title">
      <header>
        <div><p className="section-code">FULFILLMENT CONTROL BOARD</p><h2 id="order-operations-title">履约工作台</h2></div>
        <span>生产、物流、异常与售后按证据状态独立排队</span>
      </header>
      <div className="order-operation-lanes">
        {lanes.map((lane) => {
          const Icon = lane.icon;
          const error = data.errors?.[lane.key];
          return (
            <section className={`order-operation-lane lane-${lane.key}`} aria-labelledby={`lane-${lane.key}`} key={lane.key}>
              <header><span><Icon size={15} /></span><div><small>{lane.code}</small><h3 id={`lane-${lane.key}`}>{lane.label}</h3></div><b>{lane.items.length}</b></header>
              {error ? <p className="operation-lane-message is-error" role="alert">{error}</p> : lane.items.length === 0 ? (
                <p className="operation-lane-message">当前没有{lane.label}待办，未提供的数据不会被补写。</p>
              ) : (
                <ol>{lane.items.slice(0, 8).map((item) => <li key={item.id}>{lane.render(item as never)}</li>)}</ol>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}

function CustomizationQueue({ items, requirements, error }: { items: OrderView[]; requirements: OrderCustomizationSummaryView[]; error?: string }) {
  const orders = new Map(items.map((order) => [order.id, order]));
  const visible = requirements.filter((requirement) => orders.has(requirement.orderId));
  const blocked = visible.filter((requirement) => ["incomplete", "quarantined", "rejected"].includes(requirement.status)).length;
  const actionable = visible.filter((requirement) => ["awaiting_design", "awaiting_customer"].includes(requirement.status)).length;
  return (
    <section className="order-customization-queue" aria-labelledby="order-customization-title">
      <header>
        <div><p className="section-code">CUSTOMIZATION / PROOF GATE</p><h2 id="order-customization-title">定制与校样</h2></div>
        <span>{visible.length} REQUIREMENTS · {blocked} BLOCKED · {actionable} ACTIONABLE</span>
      </header>
      {error ? <div className="order-customization-message is-error" role="alert">{error}</div> : visible.length === 0 ? (
        <div className="order-customization-message"><ClipboardCheck size={17} />当前筛选范围没有定制要求；系统不会为缺失资料推断完成状态。</div>
      ) : (
        <div className="order-customization-scroll">
          <table className="order-customization-table">
            <thead><tr><th>订单 / 商品行</th><th>履约路径</th><th>完整度</th><th>资料缺口</th><th>版本</th><th>客户截止</th><th>门禁状态</th></tr></thead>
            <tbody>{visible.map((requirement) => {
              const order = orders.get(requirement.orderId)!;
              const line = order.lines.find((candidate) => candidate.id === requirement.orderLineId);
              return (
                <tr key={requirement.id}>
                  <td><a href={`#order-${order.id}`}>{order.externalOrderId}</a><span>{line?.title ?? "商品行不可用"}</span></td>
                  <td>{fulfillmentPathLabel(requirement.fulfillmentPath)}</td>
                  <td><span className="customization-completeness"><progress max="100" value={requirement.completeness} aria-label={`定制资料完整度 ${requirement.completeness}%`} /><b>{requirement.completeness}%</b></span></td>
                  <td>{requirement.missingFieldKeys.length > 0 ? <code>{requirement.missingFieldKeys.join(" · ")}</code> : "—"}</td>
                  <td className="order-sequence">v{requirement.versionNumber}</td>
                  <td>{requirement.customerApprovalDueAt ? <time dateTime={requirement.customerApprovalDueAt}>{formatDate(requirement.customerApprovalDueAt)}</time> : "—"}</td>
                  <td><span className={`customization-state state-${requirement.status}`}>{customizationStatusLabel(requirement.status)}</span></td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function fulfillmentPathLabel(path: OrderCustomizationSummaryView["fulfillmentPath"]): string {
  return { template_ready: "模板直出", designer_required: "设计师处理", customer_approval_required: "客户审批" }[path];
}

function customizationStatusLabel(status: OrderCustomizationSummaryView["status"]): string {
  return {
    incomplete: "资料不完整", ready: "可生成校样", awaiting_design: "待设计", awaiting_customer: "待客户确认",
    approved: "已批准", rejected: "已拒绝", quarantined: "文件隔离中",
  }[status];
}

function IngestionEvidence({ runs, error }: { runs: OrderIngestionRunView[]; error?: string }) {
  const latest = runs[0];
  const risks = latest?.risks ?? [];
  return (
    <section className="order-ingestion-evidence" aria-labelledby="order-ingestion-title">
      <header>
        <div><p className="section-code">INGESTION EVIDENCE</p><h2 id="order-ingestion-title">同步证据</h2></div>
        <span><RadioTower size={13} />{latest ? `${latest.platform.toUpperCase()} · ${latest.stream}` : "NO CHECKPOINT"}</span>
      </header>
      {error ? <div className="order-ingestion-message is-error" role="alert">{error}</div> : !latest ? (
        <div className="order-ingestion-message">尚无真实摄取批次；连接器写入检查点后才会显示同步状态。</div>
      ) : (
        <>
          <dl className="order-ingestion-metrics">
            <div><dt>批次状态</dt><dd data-status={latest.status}>{ingestionStatus(latest.status)}</dd></div>
            <div className={latest.reportedCount !== null && latest.reportedCount !== latest.collectedCount ? "has-drift" : undefined}><dt>已收集 / 平台报告</dt><dd>{latest.collectedCount} / {latest.reportedCount ?? "未提供"}</dd></div>
            <div><dt>重复事件</dt><dd>{latest.duplicateCount}</dd></div>
            <div><dt>风险</dt><dd>{latest.riskCount}</dd></div>
            <div><dt>检查点新鲜度</dt><dd>{latest.highWaterAt ? formatDate(latest.highWaterAt) : "尚未完成"}</dd></div>
          </dl>
          {risks.length > 0 ? (
            <ul className="order-risk-list" aria-label="最新同步风险">
              {risks.slice(0, 6).map((risk) => (
                <li key={risk.id} data-severity={risk.severity}>
                  <span>{risk.severity}</span><strong>{riskCodeLabel(risk.code)}</strong><p>{risk.message}</p><code>{risk.externalOrderId}{risk.externalLineId ? ` / ${risk.externalLineId}` : ""}</code>
                </li>
              ))}
            </ul>
          ) : <div className="order-ingestion-clear">当前批次没有风险诊断。</div>}
        </>
      )}
    </section>
  );
}

function ingestionStatus(status: OrderIngestionRunView["status"]): string {
  return { running: "同步中", completed: "已完成", partial: "部分完成", failed: "失败" }[status];
}

function riskCodeLabel(code: OrderIngestionRunView["risks"][number]["code"]): string {
  return {
    duplicate_delivery: "重复事件", address_gap: "地址缺失", customization_missing: "定制资料缺失",
    unsupported_mapping: "目录映射缺失", cancellation_requested: "取消请求", stale_provider_data: "数据陈旧",
  }[code];
}

function workflowLabel(state: OrderWorkflowState): string {
  return workflowStages.find((stage) => stage.state === state)?.label ?? state;
}

function sideStateLabel(state: NonNullable<OrderView["sideState"]>): string {
  return state === "on_hold" ? "已暂停" : "已取消";
}

function productionStatusLabel(status: string): string {
  return ({ planned: "待提交", submitted: "已提交", acknowledged: "已接单", in_production: "生产中", quality_hold: "质检暂停", completed: "已完成", cancel_requested: "申请取消", cancelled: "已取消", failed: "失败" } as Record<string, string>)[status] ?? status;
}

function shipmentStatusLabel(status: string): string {
  return ({ draft: "草稿", approved: "已批准", writeback_pending: "待回传", shipped: "已发货", in_transit: "运输中", delivered: "已送达", exception: "异常", cancelled: "已取消" } as Record<string, string>)[status] ?? status;
}

function exceptionCategoryLabel(category: OrderExceptionView["category"]): string {
  return ({ address: "地址", customization_missing: "定制资料", design_overdue: "设计逾期", customer_timeout: "客户超时", sourcing: "采购", production: "生产", quality: "质检", logistics: "物流", cancellation_requested: "取消", refund: "退款", remake: "重做", reshipment: "补发" } as Record<OrderExceptionView["category"], string>)[category];
}

function afterSalesTypeLabel(type: string): string {
  return ({ customer_contact: "客户联系", refund_request: "退款申请", return_request: "退货申请", replacement_request: "补发申请", delivery_issue: "配送问题", quality_issue: "质量问题" } as Record<string, string>)[type] ?? type;
}

function afterSalesStatusLabel(status: string): string {
  return ({ open: "新建", awaiting_customer: "待客户", awaiting_internal: "待处理", approved: "已批准", rejected: "已拒绝", resolved: "已解决", cancelled: "已取消" } as Record<string, string>)[status] ?? status;
}

function shortId(value: string): string { return value.slice(0, 8); }

function addressLabel(order: OrderView): string {
  if (order.address.status === "anonymized") return "已匿名化";
  if (order.address.status === "missing") return "未提供";
  return order.address.countryCode ?? "已保护";
}

function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency }).format(amountMinor / 100);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", hour12: false }).format(new Date(value));
}
