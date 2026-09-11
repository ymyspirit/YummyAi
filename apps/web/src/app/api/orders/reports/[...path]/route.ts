import { apiFetch } from "../../../../../server-api";

import { isSameOriginRequest } from "../../../../../same-origin-request";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(request: Request, context: RouteContext) { return proxy(request, context, "GET"); }
export async function POST(request: Request, context: RouteContext) { return proxy(request, context, "POST"); }

async function proxy(request: Request, context: RouteContext, method: "GET" | "POST"): Promise<Response> {
  const { path } = await context.params;
  const isLine = path[0] === "lines" && idPattern.test(path[1] ?? "");
  const isFile = isLine && path.length === 4 && path[2] === "files" && /^[A-Za-z0-9._-]{1,200}$/.test(path[3] ?? "");
  const valid = method === "GET"
    ? (path.length === 1 && path[0] === "workspace") || (isLine && path.length === 2) || isFile
    : (path.length === 1 && path[0] === "import") || (isLine && path.length === 3 && ["process", "upload", "review"].includes(path[2] ?? ""));
  if (!valid) return failure(404);
  const url = new URL(request.url);
  if (method === "POST" && (!isSameOriginRequest(request) || !request.headers.get("content-type")?.startsWith("application/json"))) return failure(403);
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return failure(503);
  const upstream = new URL(`${base}/v1/orders/reports/${path.map(encodeURIComponent).join("/")}`);
  if (isFile) {
    const versionId = url.searchParams.get("versionId");
    if (!versionId || !idPattern.test(versionId)) return failure(400);
    upstream.searchParams.set("versionId", versionId);
  }
  if (path[0] === "workspace") {
    for (const key of ["accountId", "batchId"]) {
      const value = url.searchParams.get(key);
      if (value && !idPattern.test(value)) return failure(400);
      if (value) upstream.searchParams.set(key, value);
    }
  }
  try {
    let body: string | undefined;
    if (method === "POST") {
      const maxBytes = path[2] === "upload" ? 29 * 1024 * 1024 : 16 * 1024 * 1024;
      const announcedSize = Number(request.headers.get("content-length"));
      if (announcedSize > maxBytes) return failure(413);
      // Cap the stream before parsing, including requests without Content-Length.
      const reader = request.body?.getReader();
      if (!reader) return failure(400);
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        byteLength += chunk.value.byteLength;
        if (byteLength > maxBytes) { await reader.cancel(); return failure(413); }
        chunks.push(chunk.value);
      }
      body = Buffer.concat(chunks).toString("utf8");
      try { JSON.parse(body); } catch { return failure(400); }
    }
    const response = await apiFetch(upstream, { method, body, cache: "no-store", headers: method === "POST" ? { "content-type": "application/json" } : undefined, signal: AbortSignal.timeout(110_000) });
    if (!response.ok) return failure(response.status);
    const headers = new Headers({ "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    if (isFile) {
      const mediaType = response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
      headers.set("content-type", mediaType);
      headers.set("content-security-policy", "default-src 'none'; sandbox");
      const disposition = response.headers.get("content-disposition");
      if (disposition) headers.set("content-disposition", disposition);
      return new Response(response.body, { status: response.status, headers });
    }
    headers.set("content-type", "application/json");
    return new Response(response.body, { status: response.status, headers });
  } catch { return failure(503); }
}

function failure(status: number) {
  return Response.json({ message: status === 401 ? "登录已失效，请重新登录。" : status === 403 ? "当前账号没有执行此操作的权限。" : status === 409 ? "内容已更新，请重新打开订单后再操作。" : status === 413 ? "文件超过允许的大小。" : "操作未完成，请检查文件或稍后重试。" }, { status: status >= 400 && status <= 599 ? status : 502, headers: { "cache-control": "private, no-store" } });
}
