import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
const id = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const getPath = new RegExp(
  `^(workspace|options|assets/${id}/preview|skus/${id}|packages/${id}/export)$`,
  "i",
);
const postPath = new RegExp(
  `^(spus(?:/${id})?|artworks(?:/${id}/archive)?|specifications(?:/batch)?|combinations|listings|packages|channels|skus/${id}/revisions|recipes/${id}/actions)$`,
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
    const limit = 1024 * 1024;
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
    const response = await apiFetch(`${base}/v1/product-development/${target}${query}`, {
      method,
      body,
      cache: "no-store",
      headers: body ? { "content-type": "application/json" } : undefined,
      signal: AbortSignal.timeout(110000),
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
    if (path[2] === "export")
      headers.set(
        "content-disposition",
        response.headers.get("content-disposition") ?? "attachment",
      );
    if (path[2] === "preview")
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
                : "操作未完成，请检查输入或稍后重试"),
    },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}
