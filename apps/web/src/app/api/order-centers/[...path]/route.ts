import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
const id = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const getPath = new RegExp(
  `^(workspace|options|profiles|lines/${id}(/operations|/template-plan|/images/${id}|/artwork-materials/${id}|/revisions/${id}|/report-images/[0-9]{1,2})?)$`,
  "i",
);
const postPath = new RegExp(
  `^(selection|summaries|bulk/preview|profiles|quality-standards|recoveries|lines/${id}/(draft|actions|archive|images|release|shipments|cases)|production/${id}/(milestones|inspections)|shipments/${id}/(review|dispatch|tracking)|cases/${id}/(decisions|contacts|complete))$`,
  "i",
);
type Context = { params: Promise<{ path: string[] }> };
export async function GET(request: Request, context: Context) {
  return proxy(request, context, "GET");
}
export async function POST(request: Request, context: Context) {
  return proxy(request, context, "POST");
}
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const { path } = await context.params,
    target = path.join("/");
  if (!(method === "GET" ? getPath : postPath).test(target)) return failure(404);
  if (
    method === "POST" &&
    (!isSameOriginRequest(request) ||
      !request.headers.get("content-type")?.startsWith("application/json"))
  )
    return failure(403);
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return failure(503);
  let body: string | undefined;
  if (method === "POST") {
    const limit = path[2] === "images" ? 46 * 1024 * 1024 : 1024 * 1024;
    const reader = request.body?.getReader();
    if (!reader) return failure(400);
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        return failure(413);
      }
      chunks.push(next.value);
    }
    body = Buffer.concat(chunks).toString("utf8");
    try {
      JSON.parse(body);
    } catch {
      return failure(400);
    }
  }
  try {
    const query = target === "workspace" ? new URL(request.url).search : "";
    const listRead = method === "GET" && ["workspace", "options"].includes(target);
    const timeout = AbortSignal.timeout(listRead ? 12_000 : 110_000);
    const response = await apiFetch(`${base}/v1/order-centers/${target}${query}`, {
      method,
      body,
      cache: "no-store",
      headers: body ? { "content-type": "application/json" } : undefined,
      signal: listRead ? AbortSignal.any([request.signal, timeout]) : timeout,
    });
    if (!response.ok) {
      let message: string | undefined;
      if ([409, 422].includes(response.status)) {
        const error = await response.json().catch(() => null);
        if (typeof error?.message === "string" && error.message.length < 400)
          message = error.message;
      }
      return failure(response.status, message);
    }
    const headers = new Headers({
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-type": response.headers.get("content-type") ?? "application/json",
    });
    if (path[2] === "artwork-materials" && response.headers.has("content-disposition"))
      headers.set("content-disposition", response.headers.get("content-disposition")!);
    if (["images", "report-images"].includes(path[2] ?? ""))
      headers.set("content-security-policy", "default-src 'none'; sandbox");
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return failure(502);
  }
}
function failure(status: number, message?: string) {
  return Response.json(
    {
      message:
        message ??
        (status === 401
          ? "登录已失效，请重新登录"
          : status === 403
            ? "当前账号没有此操作权限"
            : status === 413
              ? "文件过大"
              : status === 409
                ? "资料已更新，请刷新后重试"
                : [502, 503, 504].includes(status)
                  ? "订单服务暂时无法连接，请重试"
                  : "操作未完成，请检查输入或稍后重试"),
    },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}
