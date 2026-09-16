import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Context = { params: Promise<{ path: string[] }> };
export async function GET(request: Request, context: Context) {
  return proxy(request, context, "GET");
}
export async function POST(request: Request, context: Context) {
  return proxy(request, context, "POST");
}
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const target = (await context.params).path.join("/");
  if (
    !(
      method === "GET"
        ? /^(models|runs|runs\/[0-9a-f-]{36}(\/images\/([0-9]|1[0-5]))?)$/i
        : /^(models|runs|basis)$/
    ).test(target)
  )
    return failure(404);
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
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 128 * 1024) {
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
    const search = target === "runs" && method === "GET" ? new URL(request.url).search : "";
    const response = await apiFetch(`${base}/v1/ai-assists/${target}${search}`, {
      method,
      body,
      cache: "no-store",
      headers: body ? { "content-type": "application/json" } : undefined,
      signal: AbortSignal.timeout(110000),
    });
    if (!response.ok) {
      const data = [400, 409, 422, 503].includes(response.status)
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
        "content-type": target.includes("/images/") ? "image/jpeg" : "application/json",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        ...(target.includes("/images/")
          ? { "content-security-policy": "default-src 'none'; sandbox" }
          : {}),
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
        (status === 401
          ? "登录已失效，请重新登录"
          : status === 403
            ? "当前账号没有这项分析权限"
            : status === 413
              ? "资料过多，请减少后重试"
              : "分析服务暂不可用，请稍后刷新重试"),
    },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}
