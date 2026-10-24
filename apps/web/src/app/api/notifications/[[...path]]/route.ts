import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import {
  NotificationInboxQuerySchema,
  NotificationInboxSchema,
  NotificationViewSchema,
  NotificationReadRequestSchema,
  NotificationReadAllResultSchema,
} from "@yummyai/contracts/operations/notification";
import { apiFetch } from "../../../../server-api";

export const dynamic = "force-dynamic";
const headers = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
type Context = { params: Promise<{ path?: string[] }> };
function failure(status: number) {
  const message =
    (
      {
        400: "通知请求无效 请刷新后重试",
        401: "登录已失效 请重新登录",
        403: "当前成员没有查看通知的权限",
        404: "通知不存在或不在当前范围内",
        413: "通知请求过大",
        502: "通知服务返回内容不完整",
        503: "通知服务暂不可用 请稍后重试",
      } as Record<number, string>
    )[status] ?? "通知操作未完成 请刷新后核对";
  return Response.json(
    { message },
    { status: status >= 400 && status < 600 ? status : 502, headers },
  );
}
export async function GET(request: Request, context: Context) {
  const path = (await context.params).path ?? [];
  if (path.length) return failure(404);
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some((key) => query.getAll(key).length > 1)) return failure(400);
  const parsed = NotificationInboxQuerySchema.safeParse(Object.fromEntries(query));
  if (!parsed.success) return failure(400);
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return failure(503);
  const url = new URL(`${base}/v1/notifications/inbox`);
  url.searchParams.set("unreadOnly", String(parsed.data.unreadOnly));
  url.searchParams.set("limit", String(parsed.data.limit));
  if (parsed.data.after) url.searchParams.set("after", parsed.data.after);
  try {
    const response = await apiFetch(url, {
      cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) return failure(response.status);
    const value = NotificationInboxSchema.safeParse(await response.json());
    return value.success ? Response.json(value.data, { headers }) : failure(502);
  } catch {
    return failure(503);
  }
}
export async function PATCH(request: Request, context: Context) {
  const path = (await context.params).path ?? [];
  const all = path.length === 1 && path[0] === "read-all";
  if (
    !all &&
    !(path.length === 2 && path[1] === "read" && EntityIdSchema.safeParse(path[0]).success)
  )
    return failure(404);
  if (
    new URL(request.url).search ||
    request.headers.get("origin") !== new URL(request.url).origin ||
    request.headers.get("sec-fetch-site") === "cross-site" ||
    !request.headers.get("content-type")?.startsWith("application/json")
  )
    return failure(400);
  if (Number(request.headers.get("content-length") ?? 0) > 1024) return failure(413);
  const body = await request.text();
  if (new TextEncoder().encode(body).length > 1024) return failure(413);
  try {
    if (!NotificationReadRequestSchema.safeParse(JSON.parse(body)).success) return failure(400);
  } catch {
    return failure(400);
  }
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return failure(503);
  try {
    const response = await apiFetch(
      `${base}/v1/notifications/${path.map(encodeURIComponent).join("/")}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{}",
        cache: "no-store",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
      },
    );
    if (!response.ok) return failure(response.status);
    const value = (all ? NotificationReadAllResultSchema : NotificationViewSchema).safeParse(
      await response.json(),
    );
    return value.success ? Response.json(value.data, { headers }) : failure(502);
  } catch {
    return failure(503);
  }
}
