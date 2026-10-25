import type { OrderWorkspaceModule } from "@yummyai/contracts/order/workspace";
export const centers: Record<
  OrderWorkspaceModule,
  { title: string; description: string; path: string }
> = {
  orders: {
    title: "订单中心",
    description: "核对商品与定制要求，确认后推送制图。",
    path: "/orders",
  },
  artwork: {
    title: "制图中心",
    description: "按已确认的需求制作文件，跟进审核与客户校样。",
    path: "/order-artwork",
  },
  production: {
    title: "生产中心",
    description: "按整单安排工厂，统一跟进生产与质检。",
    path: "/production",
  },
  shipments: {
    title: "发货中心",
    description: "按本次数量分配包裹或整单装箱，核对运单并记录实际出库。",
    path: "/shipments",
  },
  "after-sales": {
    title: "售后中心",
    description: "跟进客户反馈、处理决定、补做和补发。",
    path: "/after-sales",
  },
};
export const labels: Record<string, string> = {
  minor: "轻微", major: "重大", critical: "严重", supplier: "供应商", internal: "内部", carrier: "承运商",
  customer: "客户", unknown: "尚未确定", accept: "按实际情况接受", rework: "返工", remake: "补做", reship: "补发", refund: "退款", cancel: "取消", scrap: "报废",
  pending_review: "待审单",
  needs_information: "待补资料",
  ready_to_push: "待推送",
  pushed: "已推送",
  not_pushed: "未推送",
  queued: "待领取",
  starting: "准备素材中",
  in_progress: "制作中",
  in_review: "待审核",
  changes_requested: "需修改",
  approved: "已通过",
  not_required: "无需确认",
  pending: "待客户确认",
  not_released: "未下达",
  planned: "待发送工厂",
  submitted: "待核对工厂进度",
  acknowledged: "跟进工厂排产与发货",
  in_production: "生产中",
  awaiting_quality: "待质检",
  quality_hold: "质检异常",
  completed: "已完工",
  partially_completed: "部分完工",
  failed: "失败",
  cancel_requested: "待确认停单",
  cancelled: "已取消",
  draft: "待审核包裹",
  writeback_pending: "待平台回传",
  shipped: "已交运",
  unshipped: "未发货",
  partial: "部分发货",
  dispatch: "记录实际交运",
  in_transit: "运输中",
  delivered: "已签收",
  exception: "物流异常",
  information_received: "已收到物流信息",
  picked_up: "已揽收",
  out_for_delivery: "派送中",
  delivery_exception: "配送异常",
  returned: "已退回",
  open: "待处理",
  awaiting_customer: "等客户回复",
  awaiting_internal: "待内部处理",
  rejected: "已拒绝",
  resolved: "已结案",
  customer_contact: "客户咨询",
  refund_request: "退款申请",
  return_request: "退货申请",
  replacement_request: "补发申请",
  delivery_issue: "物流问题",
  quality_issue: "质量问题",
  no_action: "无需补偿",
  full_refund: "全额退款方案",
  partial_refund: "部分退款方案",
  return_and_refund: "退货退款方案",
  replacement: "补做／补发方案",
  save: "保存需求",
  push: "推送制图",
  recall: "撤回制图",
  start_artwork: "领取制图任务",
  artwork_failed: "素材准备或自动排版失败",
  submit_artwork: "提交审核",
  approve_artwork: "文件审核通过",
  reject_artwork: "退回修改",
  approve_proof: "记录客户确认",
  reject_proof: "记录客户修改要求",
  hold: "暂停",
  resume: "解除暂停",
  held: "已暂停",
  archive: "归档记录",
  unarchive: "恢复记录",
  archived: "已归档",
  active: "正常",
  release_production: "下达生产",
  platform_deadline: "核对平台发货截止",
  platform_shipment_confirmed: "登记平台发货确认",
};
export const label = (value: string) => labels[value] ?? value;
export const dateTime = (value: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未设置";
export class OrderCenterRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}
export async function centerRequest(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  authority?: string,
): Promise<unknown> {
  const response = await fetch(`/api/order-centers/${path}`, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    signal,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(authority ? { "x-yummyai-context-authority": authority } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = authority ? await stampedOrderJson(response).catch(() => null) : await response.json().catch(() => null);
  if (!response.ok)
    throw new OrderCenterRequestError(
      response.status,
      response.status >= 500 ? body === undefined ? "记录暂时无法读取，请重试；无需修改填写内容。" : "服务器暂时无法完成操作，请保留填写内容后重试。"
      : authority ? response.status === 409 ? "当前身份或资料已变化 请重新核对" : "当前无法读取这笔订单资料"
      : data && typeof data === "object" && "message" in data && typeof data.message === "string"
        ? data.message
        : "操作失败，请刷新后重试",
      data && typeof data === "object" && "code" in data && data.code === "authority_changed" ? "authority_changed" : null,
    );
  if (authority && response.headers.get("x-yummyai-context-authority") !== authority)
    throw new OrderCenterRequestError(409, "当前身份或授权范围已变化 原订单资料已隐藏", "authority_changed");
  if (data === null) throw new Error("返回的数据无法读取，请刷新后重试");
  return data;
}

async function stampedOrderJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("empty_order_payload");
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
      if (size > (response.ok ? 8 * 1024 * 1024 : 8192)) { await reader.cancel(); throw new Error("order_payload_limit"); } parts.push(next.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { reader.releaseLock(); }
}

export function orderCommandUncertain(cause: unknown) {
  return !(cause instanceof OrderCenterRequestError) || cause.status >= 500 ||
    cause.status === 409 && cause.code === "authority_changed";
}

// Only list/options reads may retry. Order writes keep their existing explicit replay flow.
export async function centerRead(
  path: "options" | `workspace?${string}` | "deliveries" | `deliveries?${string}`,
  signal: AbortSignal,
): Promise<unknown> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 15_000);
  const combined = AbortSignal.any([signal, deadline.signal]);
  try {
    for (let attempt = 0; ; attempt += 1) {
      combined.throwIfAborted();
      try {
        return await centerRequest(path, undefined, combined);
      } catch (cause) {
        combined.throwIfAborted();
        const transient =
          cause instanceof TypeError ||
          (cause instanceof OrderCenterRequestError && [502, 503, 504].includes(cause.status));
        if (!transient) throw cause;
        if (attempt > 0) throw new Error("订单服务暂时无法连接，请重试。");
        await new Promise<void>((resolve, reject) => {
          const stop = () => {
            clearTimeout(delay);
            reject(combined.reason);
          };
          const delay = setTimeout(() => {
            combined.removeEventListener("abort", stop);
            resolve();
          }, 300);
          combined.addEventListener("abort", stop, { once: true });
        });
      }
    }
  } catch (cause) {
    if (signal.aborted) throw cause;
    if (deadline.signal.aborted) throw new Error("订单读取超时，请重试或切换筛选。");
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}
export async function fileBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
