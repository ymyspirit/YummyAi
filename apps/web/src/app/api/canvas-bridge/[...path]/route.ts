import { apiFetch } from "../../../../server-api";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Context = { params: Promise<{ path: string[] }> };
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request, context: Context) { return proxy(request, context, "GET"); }
export async function POST(request: Request, context: Context) { return proxy(request, context, "POST"); }

async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const url = new URL(request.url), { path } = await context.params;
  const incoming = new URL(`${url.protocol}//${request.headers.get("host") ?? url.host}`);
  // The existing server API identity is local-development only. A deployed BFF must use a user's OIDC session.
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "[::1]"].includes(incoming.hostname)) return failure(403, "此接入入口仅用于本地 ERP；部署时需要用户 OIDC 会话");
  if (request.headers.get("sec-fetch-site") === "cross-site") return failure(403);
  if (method === "POST" && request.headers.get("origin") !== incoming.origin) return failure(403);
  const valid = ["options", "production-templates"].includes(path[0] ?? "") && path.length === 1 && method === "GET"
    || path[0] === "briefs" && (path.length === 1
      || path.length === 2 && id.test(path[1] ?? "") && method === "GET"
      || path.length === 3 && id.test(path[1] ?? "") && (path[2] === "results" || ["review", "continue", "production"].includes(path[2] ?? "") && method === "POST")
      || path.length === 5 && id.test(path[1] ?? "") && path[2] === "results" && id.test(path[3] ?? "") && path[4] === "preview" && method === "GET"
      || path.length === 4 && id.test(path[1] ?? "") && path[2] === "assets" && id.test(path[3] ?? "") && method === "GET");
  if (!valid) return failure(404);
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return failure(503);
  try {
    let body: string | undefined;
    if (method === "POST") {
      if (!request.headers.get("content-type")?.startsWith("application/json")) return failure(415);
      const max = (path[2] === "results" ? 28 : 1) * 1024 * 1024;
      if (Number(request.headers.get("content-length")) > max) return failure(413);
      const reader = request.body?.getReader();
      if (!reader) return failure(400);
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > max) { await reader.cancel(); return failure(413); }
        chunks.push(part.value);
      }
      body = Buffer.concat(chunks).toString("utf8");
      try { JSON.parse(body); } catch { return failure(400); }
    }
    const response = await apiFetch(`${base}/v1/canvas-bridge/${path.map(encodeURIComponent).join("/")}`, {
      method, body, cache: "no-store", headers: body ? { "content-type": "application/json" } : undefined, signal: AbortSignal.timeout(100_000),
    });
    if (!response.ok) return failure(response.status);
    return new Response(response.body, { status: response.status, headers: { "content-type": path[4] === "preview" ? "image/webp" : "application/json", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch { return failure(502); }
}
function failure(status: number, message?: string) {
  const messages: Record<number, string> = { 400: "输入或图片格式无效，请检查后重试", 401: "ERP 登录已失效，请重新登录", 403: "没有权限访问当前需求或素材", 404: "需求或素材不存在", 409: "需求状态或素材已变化，或已达到 4 个方案上限，请刷新后检查", 413: "结果图片不能超过 20 MiB", 415: "请求格式不受支持", 503: "ERP 服务尚未就绪" };
  return Response.json({ error: message ?? messages[status] ?? "连接 ERP 失败，请保留画布并重试" }, { status, headers: { "cache-control": "private, no-store" } });
}
