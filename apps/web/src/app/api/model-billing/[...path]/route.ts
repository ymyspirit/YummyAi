import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";

export const dynamic = "force-dynamic";
const id = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const readPath = new RegExp(`^(workspace|(assist|pod|order_design)/${id})$`, "i");
const writePath = new RegExp(`^(assist|pod)/${id}/confirm$`, "i");
type Context = { params: Promise<{ path: string[] }> };

export const GET = (request: Request, context: Context) => proxy(request, context, "GET");
export const POST = (request: Request, context: Context) => proxy(request, context, "POST");

async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const path = (await context.params).path.join("/");
  if (!(method === "GET" ? readPath : writePath).test(path)) return failure(404);
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
    const reader = request.body?.getReader();
    if (!reader) return failure(400);
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 16 * 1024) {
        await reader.cancel();
        return failure(413);
      }
      chunks.push(part.value);
    }
    body = Buffer.concat(chunks).toString("utf8");
    try {
      JSON.parse(body);
    } catch {
      return failure(400);
    }
  }
  try {
    const query = method === "GET" && path === "workspace" ? new URL(request.url).search : "";
    const response = await apiFetch(`${base}/v1/model-billing/${path}${query}`, {
      method,
      body,
      cache: "no-store",
      headers: body ? { "content-type": "application/json" } : undefined,
      signal:
        method === "GET"
          ? AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const data = [400, 409].includes(response.status)
        ? await response.json().catch(() => null)
        : null;
      return failure(
        response.status,
        typeof data?.message === "string" && data.message.length < 400 ? data.message : undefined,
      );
    }
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return failure(502);
  }
}
function failure(status: number, message?: string) {
  return Response.json(
    {
      message:
        message ??
        (status === 403
          ? "当前账号没有模型费用核对权限"
          : status === 401
            ? "登录已失效 请重新登录"
            : status === 400
              ? "核对资料格式不正确"
              : status === 404
                ? "费用记录不存在"
                : status === 503
                  ? "模型费用核对尚未启用"
                  : "费用服务暂时不可用 请重试"),
    },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}
