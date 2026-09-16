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
    description: "下达已审核的生产文件，跟进工厂进度与质检。",
    path: "/production",
  },
  shipments: {
    title: "发货中心",
    description: "按可发数量安排包裹，记录交运和物流进度。",
    path: "/shipments",
  },
  "after-sales": {
    title: "售后中心",
    description: "跟进客户反馈、处理决定、补做和补发。",
    path: "/after-sales",
  },
};
export const labels: Record<string, string> = {
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
  submitted: "待工厂接单",
  acknowledged: "工厂已接单",
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
};
export const label = (value: string) => labels[value] ?? value;
export const dateTime = (value: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未设置";
class OrderCenterRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function centerRequest(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`/api/order-centers/${path}`, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    signal,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new OrderCenterRequestError(
      response.status,
      data && typeof data === "object" && "message" in data && typeof data.message === "string"
        ? data.message
        : "操作失败，请刷新后重试",
    );
  if (data === null) throw new Error("返回的数据无法读取，请刷新后重试");
  return data;
}

// Only list/options reads may retry. Order writes keep their existing explicit replay flow.
export async function centerRead(
  path: "options" | `workspace?${string}`,
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
