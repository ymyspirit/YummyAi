import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
import {
  FollowupSourceSchema,
  FollowupTaskInboxQuerySchema,
  FollowupTaskInboxViewSchema,
  FollowupDetailViewSchema,
  FollowupResponsibilityInputSchema,
  FollowupResponsibilityViewSchema,
} from "@yummyai/contracts/operations/followup";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
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
    [source, target, action] = path;
  const tasks = method === "GET" && path.length === 2 && target === "tasks";
  const detail = method === "GET" && path.length === 2 && EntityIdSchema.safeParse(target).success;
  const write =
    method === "POST" &&
    path.length === 3 &&
    EntityIdSchema.safeParse(target).success &&
    ["responsibility", "resume"].includes(action!);
  if (!FollowupSourceSchema.safeParse(source).success || (!tasks && !detail && !write))
    return fail(404);
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) return fail(400);
  if (
    tasks
      ? !FollowupTaskInboxQuerySchema.safeParse(Object.fromEntries(params)).success
      : detail
        ? [...params.keys()].some((key) => key !== "q") || (params.get("q") ?? "").length > 100
        : params.size > 0
  )
    return fail(400);
  let body: string | undefined;
  if (write) {
    if (
      !isSameOriginRequest(request) ||
      !request.headers.get("content-type")?.startsWith("application/json")
    )
      return fail(403);
    const reader = request.body?.getReader();
    if (!reader) return fail(400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 8192) {
          await reader.cancel();
          return fail(413);
        }
        chunks.push(next.value);
      }
      const input = FollowupResponsibilityInputSchema.safeParse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))),
      );
      if (!input.success) return fail(400);
      body = JSON.stringify(input.data);
    } catch {
      return fail(400);
    }
  }
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return fail(503);
  try {
    const response = await apiFetch(
      `${base}/v1/business-followups/${path.join("/")}${params.size ? "?" + params : ""}`,
      {
        method,
        body,
        headers: body ? { "content-type": "application/json" } : undefined,
        cache: "no-store",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(12000)]),
      },
    );
    if (!response.ok) {
      const error = response.status === 409 ? await response.json().catch(() => null) : null;
      return fail(
        response.status,
        typeof error?.message === "string" && error.message.length < 400
          ? error.message
          : undefined,
      );
    }
    const value = (
      tasks
        ? FollowupTaskInboxViewSchema
        : detail
          ? FollowupDetailViewSchema
          : FollowupResponsibilityViewSchema
    ).safeParse(await response.json());
    return value.success ? Response.json(value.data, { headers }) : fail(502);
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
            ? "当前账号没有此操作权限"
            : status === 404
              ? "该业务跟进暂未启用或对象不可用"
              : status === 409
                ? "业务依据已更新 请载入最新记录"
                : status === 413
                  ? "提交内容过大"
                  : status >= 500
                    ? "业务跟进暂时无法连接 请重试"
                    : "请核对输入与筛选条件"),
    },
    { status, headers },
  );
}
