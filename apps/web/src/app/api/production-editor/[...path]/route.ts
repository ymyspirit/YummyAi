import { apiFetch } from "../../../../server-api";

import { isSameOriginRequest } from "../../../../same-origin-request";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const entityId = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeKey = /^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$/;
type RouteContext = { params: Promise<{ path: string[] }> };
type Method = "GET" | "POST" | "DELETE";

export async function GET(request: Request, context: RouteContext) { return proxy(request, context, "GET"); }
export async function POST(request: Request, context: RouteContext) { return proxy(request, context, "POST"); }
export async function DELETE(request: Request, context: RouteContext) { return proxy(request, context, "DELETE"); }

function routeType(path: string[], method: Method): "json" | "file" | null {
  if (path[0] !== "projects") return null;
  if (path.length === 1) return method === "DELETE" ? null : "json";
  if (!entityId.test(path[1] ?? "")) return null;
  if (path.length === 2) return method === "GET" || method === "DELETE" ? "json" : null;
  if (path.length === 5 && path[2] === "images" && entityId.test(path[3] ?? "")) return path[4] === "cutout" && (method === "GET" || method === "POST") || ["segment", "refine"].includes(path[4] ?? "") && method === "POST" ? "json" : null;
  if (method === "POST") return path.length === 3 && ["versions", "review", "images", "fonts", "preflight", "renders"].includes(path[2] ?? "") ? "json" : null;
  if (method !== "GET") return null;
  if (path.length === 3 && ["images", "fonts"].includes(path[2] ?? "")) return "json";
  if (path.length === 4) {
    if (path[2] === "images" && entityId.test(path[3] ?? "")) return "file";
    if (path[2] === "fonts" && safeKey.test(path[3] ?? "")) return "file";
    if (path[2] === "renders" && entityId.test(path[3] ?? "")) return "json";
  }
  if (path.length === 6 && path[2] === "renders" && entityId.test(path[3] ?? "") && path[4] === "files" && safeKey.test(path[5] ?? "")) return "file";
  return null;
}

async function proxy(request: Request, context: RouteContext, method: Method): Promise<Response> {
  const { path } = await context.params;
  const type = routeType(path, method);
  if (!type) return failure(404);
  const url = new URL(request.url);
  if (method !== "GET" && !isSameOriginRequest(request)) return failure(403);
  if (method === "POST" && !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return failure(415);
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return failure(503);
  const upstream = new URL(`${base}/v1/production-editor/${path.map(encodeURIComponent).join("/")}`);
  if (method === "GET" && path.length === 2) {
    const versionId = url.searchParams.get("versionId");
    if (versionId && !entityId.test(versionId)) return failure(400);
    if (versionId) upstream.searchParams.set("versionId", versionId);
  }
  if (method === "GET" && path.length === 4 && path[2] === "images") {
    const kind = url.searchParams.get("kind") ?? "preview";
    if (kind !== "preview" && kind !== "original") return failure(400);
    upstream.searchParams.set("kind", kind);
  }
  try {
    let body: string | undefined;
    if (method === "POST") {
      const maximum = (path.length === 5 ? 3 : path[2] === "images" ? 90 : path[2] === "fonts" ? 14 : 2) * 1024 * 1024;
      if (Number(request.headers.get("content-length")) > maximum) return failure(413);
      const reader = request.body?.getReader();
      if (!reader) return failure(400);
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > maximum) { await reader.cancel(); return failure(413); }
        chunks.push(chunk.value);
      }
      body = Buffer.concat(chunks).toString("utf8");
      try { JSON.parse(body); } catch { return failure(400); }
    }
    const response = await apiFetch(upstream, { method, body, cache: "no-store", headers: method === "POST" ? { "content-type": "application/json" } : undefined, signal: AbortSignal.timeout(110_000) });
    if (!response.ok) return failure(response.status);
    const headers = new Headers({ "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    if (type === "file") {
      headers.set("content-type", response.headers.get("content-type") ?? "application/octet-stream");
      headers.set("content-security-policy", "default-src 'none'; sandbox");
      const disposition = response.headers.get("content-disposition");
      if (disposition) headers.set("content-disposition", disposition);
      return new Response(response.body, { status: response.status, headers });
    }
    if (response.status === 204) return new Response(null, { status: 204, headers });
    headers.set("content-type", "application/json");
    return new Response(response.body, { status: response.status, headers });
  } catch { return failure(503); }
}

function failure(status: number): Response {
  const messages: Record<number, string> = {
    400: "参数无效，请检查输入内容。", 401: "登录已失效，请重新登录。", 403: "当前账号没有执行此操作的权限。",
    404: "项目或文件不存在，可能已经删除或到期。", 409: "项目或订单来源已变化，请重新打开后再保存。",
    410: "订单资料已到保存期限。", 413: "文件超过允许的大小。", 415: "上传格式不受支持。",
    422: "未满足处理条件，请查看预检结果并核对文件。", 503: "作图服务暂时不可用，请稍后重试。",
  };
  return Response.json({ message: messages[status] ?? "操作未完成，请检查文件或稍后重试。" }, { status: status >= 400 && status <= 599 ? status : 502, headers: { "cache-control": "private, no-store" } });
}
