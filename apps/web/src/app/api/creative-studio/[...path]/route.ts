import { apiFetch } from "../../../../server-api";
import { StudioRpcSchema } from "@yummyai/contracts/pod/creative-studio";
import { ConfigurationRpcSchema } from "@yummyai/contracts/ai/model-configuration";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Context = { params: Promise<{ path: string[] }> };
export async function GET(request: Request, context: Context) { return proxy(request, context, "GET"); }
export async function POST(request: Request, context: Context) { return proxy(request, context, "POST"); }
export async function PATCH(request: Request, context: Context) { return proxy(request, context, "PATCH"); }
async function proxy(request: Request, context: Context, method: string) {
  const url = new URL(request.url), incoming = new URL(`${url.protocol}//${request.headers.get("host") ?? url.host}`);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "[::1]"].includes(incoming.hostname)) return fail(403, "创作接入目前用于本地 ERP，部署需接入用户 OIDC 会话");
  if (request.headers.get("sec-fetch-site") === "cross-site" || method !== "GET" && request.headers.get("origin") !== incoming.origin) return fail(403);
  const { path } = await context.params;
  const route = path.join("/");
  const target = route === "rpc" && method === "POST" ? "creative-studio/rpc"
    : route === "configuration" && method === "POST" ? "ai/configuration"
    : route === "models" && method === "POST" ? "creative-studio/models"
      : route === "providers" && ["GET", "POST"].includes(method) ? "ai/model-configs"
        : /^providers\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(route) && method === "PATCH" ? `ai/model-configs/${path[1]}` : null;
  if (!target) return fail(404);
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return fail(503);
  try {
    let body: string | undefined;
    if (method !== "GET") {
      if (!request.headers.get("content-type")?.startsWith("application/json")) return fail(415);
      const limit = route === "rpc" ? 28 * 1024 * 1024 : 128 * 1024;
      if (Number(request.headers.get("content-length")) > limit) return fail(413);
      const reader = request.body?.getReader(); if (!reader) return fail(400);
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) { await reader.cancel(); return fail(413); } chunks.push(part.value); }
      body = Buffer.concat(chunks).toString("utf8");
      let value: unknown; try { value = JSON.parse(body); } catch { return fail(400); }
      if (route === "rpc" && !StudioRpcSchema.safeParse(value).success) return fail(400);
      if (route === "configuration" && !ConfigurationRpcSchema.safeParse(value).success) return fail(400);
    }
    const response = await apiFetch(`${base}/v1/${target}`, { method, body, headers: body ? { "content-type": "application/json" } : undefined, cache: "no-store", signal: AbortSignal.timeout(100_000) });
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as { message?: unknown };
      // Only deliberate short Chinese business messages cross the BFF. Provider responses and credentials never do.
      const message = typeof result.message === "string" && /^[\u3400-\u9fff]/.test(result.message) && result.message.length <= 200 ? result.message : undefined;
      return fail(response.status, message);
    }
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch { return fail(502); }
}
function fail(status: number, message?: string) {
  const messages: Record<number, string> = { 400: "请求格式无效，请核对输入", 401: "ERP 登录已失效", 403: "没有权限执行此操作", 404: "记录不存在", 409: "记录或状态已变化，请刷新后重试", 413: "单个素材不能超过 20 MiB", 415: "请求格式不受支持", 422: "素材未通过安全检查", 503: "ERP 服务未就绪" };
  return Response.json({ error: message ?? messages[status] ?? "连接 ERP 失败，当前内容尚未保存" }, { status, headers: { "cache-control": "private, no-store" } });
}
