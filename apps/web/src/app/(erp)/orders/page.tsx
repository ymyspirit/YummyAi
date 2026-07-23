import { ClipboardList, ShieldCheck } from "lucide-react";
import type { OrderCustomizationSummaryView, OrderExceptionView, OrderIngestionRunView, OrderSideState, OrderView, OrderWorkflowState } from "@yummyai/contracts";

import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import { OrderInbox, type AfterSalesQueueItem, type OperationalQueues, type ProductionQueueItem, type ShipmentQueueItem } from "../../../features/orders/order-inbox";
import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function OrdersPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const query = buildQuery(params);
  const [result, ingestion, customizations, production, shipments, exceptions, afterSales] = await Promise.all([
    loadOrders(query), loadIngestionRuns(), loadCustomizations(),
    loadQueue("/v1/production/orders", parseProductionQueue, "生产队列"),
    loadQueue("/v1/shipments", parseShipmentQueue, "物流队列"),
    loadQueue("/v1/orders/exceptions?status=open", parseExceptionQueue, "异常队列"),
    loadQueue("/v1/after-sales-cases", parseAfterSalesQueue, "售后队列"),
  ]);
  const operations: OperationalQueues = {
    production: production.items, shipments: shipments.items, exceptions: exceptions.items, afterSales: afterSales.items,
    errors: compactErrors({ production: production.error, shipments: shipments.error, exceptions: exceptions.error, afterSales: afterSales.error }),
  };

  return (
    <div className="research-shell order-shell">
      <ErpSidebar
        active="orders"
        contextLabel="ORDER CONTROL"
        note="公开投影用于日常排队；履约 PII 只在授权目的下单独读取并留下审计记录。"
      />
      <main className="research-main order-main">
        <header className="order-header">
          <div>
            <p className="kicker">ORDER / EVENT LEDGER</p>
            <h1>订单履约</h1>
            <p>用不可变来源快照和顺序事件推进定制订单，不在队列中暴露买家信息。</p>
          </div>
          <div className="order-privacy-mark"><ShieldCheck size={18} /><span><b>PII 隔离</b>普通队列仅加载公开投影</span></div>
        </header>

        <form className="order-filters" method="get" aria-label="订单筛选">
          <label>平台<select name="platform" defaultValue={stringValue(params.platform)}><option value="">全部</option><option value="amazon">Amazon</option><option value="etsy">Etsy</option></select></label>
          <label>主状态<select name="workflowState" defaultValue={stringValue(params.workflowState)}><option value="">全部</option>{workflowOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>附加状态<select name="sideState" defaultValue={stringValue(params.sideState)}><option value="">全部</option><option value="none">正常</option><option value="on_hold">已暂停</option><option value="cancelled">已取消</option></select></label>
          <button type="submit"><ClipboardList size={15} />应用筛选</button>
        </form>

        {result.error ? (
          <section className={`order-load-state state-${result.kind}`} role="alert">
            <strong>{result.kind === "unauthorized" ? "订单访问未授权" : result.kind === "forbidden" ? "缺少订单权限" : "订单队列不可用"}</strong>
            <span>{result.error}</span>
          </section>
        ) : <OrderInbox items={result.items} runs={ingestion.items} syncError={ingestion.error} customizations={customizations.items} customizationError={customizations.error} operations={operations} />}
      </main>
    </div>
  );
}

const workflowOptions = [
  ["pending", "待处理"], ["awaiting_customization", "待定制"], ["awaiting_design", "待设计"],
  ["awaiting_customer_approval", "待客户确认"], ["awaiting_routing", "待路由"], ["in_production", "生产中"],
  ["awaiting_quality_control", "待质检"], ["awaiting_shipment", "待发货"], ["shipped", "已发货"], ["completed", "已完成"],
] as const;
const workflowStates = new Set<OrderWorkflowState>(workflowOptions.map(([state]) => state));
const platforms = new Set<OrderView["platform"]>(["amazon", "etsy"]);
const sideStates = new Set<OrderSideState | "none">(["on_hold", "cancelled", "none"]);

function buildQuery(params: Record<string, string | string[] | undefined>): URLSearchParams {
  const query = new URLSearchParams({ limit: "100" });
  const platform = stringValue(params.platform) as OrderView["platform"];
  const workflowState = stringValue(params.workflowState) as OrderWorkflowState;
  const rawSideState = stringValue(params.sideState);
  if (platforms.has(platform)) query.set("platform", platform);
  if (workflowStates.has(workflowState)) query.set("workflowState", workflowState);
  if (sideStates.has(rawSideState as OrderSideState | "none")) query.set("sideState", rawSideState);
  return query;
}

async function loadOrders(query: URLSearchParams): Promise<{ items: OrderView[]; error?: string; kind?: "unauthorized" | "forbidden" | "failed" }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { items: [], error: "尚未配置订单 API。", kind: "failed" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/orders?${query}`, { cache: "no-store" });
    if (!response.ok) {
      if (response.status === 401) return { items: [], error: "身份会话无效，请重新登录本地身份服务。", kind: "unauthorized" };
      if (response.status === 403) return { items: [], error: "当前成员没有 order:read 权限。", kind: "forbidden" };
      return { items: [], error: `订单读取失败 (${response.status})。`, kind: "failed" };
    }
    return { items: parsePublicOrderViews(await response.json()) };
  } catch (error) {
    return { items: [], error: error instanceof Error ? error.message : "订单读取失败。", kind: "failed" };
  }
}

async function loadIngestionRuns(): Promise<{ items: OrderIngestionRunView[]; error?: string }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { items: [], error: "尚未配置同步证据 API。" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/orders/ingestion/runs?limit=20`, { cache: "no-store" });
    if (!response.ok) return { items: [], error: `同步证据读取失败 (${response.status})。` };
    return { items: parseIngestionRuns(await response.json()) };
  } catch (error) {
    return { items: [], error: error instanceof Error ? error.message : "同步证据读取失败。" };
  }
}

async function loadCustomizations(): Promise<{ items: OrderCustomizationSummaryView[]; error?: string }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { items: [], error: "尚未配置定制队列 API。" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/orders/customizations`, { cache: "no-store" });
    if (!response.ok) return { items: [], error: `定制队列读取失败 (${response.status})。` };
    return { items: parseCustomizationViews(await response.json()) };
  } catch (error) {
    return { items: [], error: error instanceof Error ? error.message : "定制队列读取失败。" };
  }
}

async function loadQueue<T>(path: string, parse: (value: unknown) => T[], label: string): Promise<{ items: T[]; error?: string }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { items: [], error: `尚未配置${label} API。` };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}${path}`, { cache: "no-store" });
    if (!response.ok) return { items: [], error: `${label}读取失败 (${response.status})。` };
    return { items: parse(await response.json()) };
  } catch (error) {
    return { items: [], error: error instanceof Error ? error.message : `${label}读取失败。` };
  }
}

function stringValue(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function parsePublicOrderViews(value: unknown): OrderView[] {
  if (!Array.isArray(value)) throw new TypeError("订单 API 返回了无效的数据结构。");
  for (const [index, order] of value.entries()) {
    if (!isRecord(order) || typeof order.id !== "string" || typeof order.externalOrderId !== "string" ||
      !platforms.has(order.platform as OrderView["platform"]) || !workflowStates.has(order.workflowState as OrderWorkflowState) ||
      !Array.isArray(order.lines) || !isRecord(order.orderTotal) || !isRecord(order.address)) {
      throw new TypeError(`订单 API 第 ${index + 1} 条记录无效。`);
    }
    for (const protectedKey of ["buyer", "protectedDetails", "shippingAddress", "encryptedEnvelope"]) {
      if (protectedKey in order) throw new TypeError("订单 API 在公开投影中返回了受保护字段。");
    }
  }
  return value as OrderView[];
}

function parseIngestionRuns(value: unknown): OrderIngestionRunView[] {
  if (!Array.isArray(value)) throw new TypeError("同步证据 API 返回了无效的数据结构。");
  for (const [index, run] of value.entries()) {
    if (!isRecord(run) || typeof run.id !== "string" || typeof run.accountId !== "string" ||
      !platforms.has(run.platform as OrderView["platform"]) || typeof run.collectedCount !== "number" ||
      !Array.isArray(run.risks)) throw new TypeError(`同步证据 API 第 ${index + 1} 条记录无效。`);
    for (const protectedKey of ["buyer", "protectedDetails", "shippingAddress", "encryptedEnvelope", "credential", "token"]) {
      if (protectedKey in run) throw new TypeError("同步证据 API 返回了受保护字段。");
    }
  }
  return value as OrderIngestionRunView[];
}

function parseCustomizationViews(value: unknown): OrderCustomizationSummaryView[] {
  if (!Array.isArray(value)) throw new TypeError("定制队列 API 返回了无效的数据结构。");
  for (const [index, requirement] of value.entries()) {
    if (!isRecord(requirement) || typeof requirement.id !== "string" || typeof requirement.orderId !== "string" ||
      typeof requirement.orderLineId !== "string" || typeof requirement.versionId !== "string" ||
      typeof requirement.versionNumber !== "number" || typeof requirement.completeness !== "number" ||
      !Array.isArray(requirement.mappedFieldKeys) || !Array.isArray(requirement.missingFieldKeys) || !Array.isArray(requirement.fileFieldKeys)) {
      throw new TypeError(`定制队列 API 第 ${index + 1} 条记录无效。`);
    }
    for (const protectedKey of ["values", "encryptedValues", "fileReferences", "buyer", "shippingAddress"]) {
      if (protectedKey in requirement) throw new TypeError("定制队列 API 返回了受保护字段。");
    }
  }
  return value as OrderCustomizationSummaryView[];
}

function parseProductionQueue(value: unknown): ProductionQueueItem[] {
  return parseSafeQueue<ProductionQueueItem>(value, "生产队列", (item) => typeof item.id === "string" && typeof item.orderId === "string" &&
    typeof item.status === "string" && typeof item.source === "string" && typeof item.projectionVersion === "number" &&
    typeof item.currentVersionNumber === "number" && typeof item.expectedCompletionAt === "string" && typeof item.updatedAt === "string");
}

function parseShipmentQueue(value: unknown): ShipmentQueueItem[] {
  return parseSafeQueue<ShipmentQueueItem>(value, "物流队列", (item) => typeof item.id === "string" && typeof item.orderId === "string" &&
    typeof item.status === "string" && typeof item.currentVersionNumber === "number" &&
    (item.approvedVersionNumber === null || typeof item.approvedVersionNumber === "number") && typeof item.updatedAt === "string");
}

function parseExceptionQueue(value: unknown): OrderExceptionView[] {
  return parseSafeQueue<OrderExceptionView>(value, "异常队列", (item) => typeof item.id === "string" && typeof item.orderId === "string" &&
    typeof item.category === "string" && typeof item.code === "string" && typeof item.status === "string" && typeof item.openedAt === "string");
}

function parseAfterSalesQueue(value: unknown): AfterSalesQueueItem[] {
  return parseSafeQueue<AfterSalesQueueItem>(value, "售后队列", (item) => typeof item.id === "string" && typeof item.orderId === "string" &&
    typeof item.type === "string" && typeof item.status === "string" && typeof item.reasonCode === "string" &&
    typeof item.currentDecisionVersion === "number" && typeof item.updatedAt === "string");
}

function parseSafeQueue<T>(value: unknown, label: string, validate: (item: Record<string, unknown>) => boolean): T[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} API 返回了无效的数据结构。`);
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || !validate(item)) throw new TypeError(`${label} API 第 ${index + 1} 条记录无效。`);
    for (const protectedKey of ["buyer", "protectedDetails", "shippingAddress", "encryptedEnvelope", "encryptedSummary", "encryptedReason", "encryptedBody", "encryptedDetail", "credential", "token"]) {
      if (protectedKey in item) throw new TypeError(`${label} API 返回了受保护字段。`);
    }
  }
  return value as T[];
}

function compactErrors(errors: OperationalQueues["errors"]): OperationalQueues["errors"] {
  return Object.fromEntries(Object.entries(errors ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
