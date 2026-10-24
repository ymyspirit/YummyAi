import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { OrderExceptionViewSchema } from "@yummyai/contracts/order/order";
import {
  OpenReviewedOrderExceptionSchema,
  ResolveReviewedOrderExceptionSchema,
  OrderExceptionOperationsQuerySchema,
  OrderExceptionOperationsViewSchema,
} from "@yummyai/contracts/order/exception-operations";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const headers = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
export function GET(request: Request, context: Context) {
  return proxy(request, context, "GET");
}
export function POST(request: Request, context: Context) {
  return proxy(request, context, "POST");
}
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const { path } = await context.params,
    [orderId, exceptionId, action] = path;
  const read = method === "GET" && path.length === 1,
    create = method === "POST" && path.length === 1,
    resolve =
      method === "POST" &&
      path.length === 3 &&
      action === "resolve" &&
      EntityIdSchema.safeParse(exceptionId).success;
  if (!EntityIdSchema.safeParse(orderId).success || (!read && !create && !resolve))
    return fail(404);
  const params = new URL(request.url).searchParams;
  if (
    [...params.keys()].some((key) => params.getAll(key).length !== 1) ||
    (read
      ? !OrderExceptionOperationsQuerySchema.safeParse(Object.fromEntries(params)).success
      : params.size > 0)
  )
    return fail(400);
  let body: string | undefined;
  if (!read) {
    if (
      !isSameOriginRequest(request) ||
      request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json"
    )
      return fail(403);
    const reader = request.body?.getReader();
    if (!reader) return fail(400);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 8192) {
          await reader.cancel();
          return fail(413);
        }
        chunks.push(next.value);
      }
      const value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
        ),
        parsed = (
          create ? OpenReviewedOrderExceptionSchema : ResolveReviewedOrderExceptionSchema
        ).safeParse(value);
      if (!parsed.success) return fail(400);
      body = JSON.stringify(parsed.data);
    } catch {
      return fail(400);
    }
  }
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return fail(503);
  const target = read
    ? `${orderId}/exception-operations${params.size ? "?" + params : ""}`
    : create
      ? `${orderId}/exceptions`
      : `${orderId}/exceptions/${exceptionId}/resolve`;
  try {
    const response = await apiFetch(`${base}/v1/orders/${target}`, {
      method,
      body,
      headers: body ? { "content-type": "application/json" } : undefined,
      cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(12000)]),
    });
    if (!response.ok) {
      const value = response.status === 409 ? await response.json().catch(() => null) : null;
      return fail(
        response.status,
        typeof value?.message === "string" && value.message.length < 400
          ? value.message
          : undefined,
      );
    }
    const parsed = (read ? OrderExceptionOperationsViewSchema : OrderExceptionViewSchema).safeParse(
      await response.json(),
    );
    return parsed.success ? Response.json(parsed.data, { headers }) : fail(502);
  } catch {
    return fail(502);
  }
}
function fail(status: number, message?: string) {
  return Response.json(
    {
      message:
        message ??
        (status === 401
          ? "登录已失效 请重新登录"
          : status === 403
            ? "当前没有查看或处理订单异常的权限"
            : status === 404
              ? "订单或异常不存在或不在当前范围内"
              : status === 410
                ? "订单资料已过期或已清理"
                : status === 409
                  ? "订单或异常依据已变化 请重新核对"
                  : status === 413
                    ? "提交内容过大"
                    : status >= 500
                      ? "操作结果暂未确认 请先重新读取异常记录 后续重试会沿用本次请求编号"
                      : "请核对输入与筛选条件"),
    },
    { status, headers },
  );
}
