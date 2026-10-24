import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
export const dynamic = "force-dynamic";
export const maxDuration = 45;
const id = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const read = new RegExp(`^${id}(/records/${id}/label)?$`, "i");
const write = new RegExp(`^${id}/(connection|test|sync)$`, "i");
type Context = { params: Promise<{ path: string[] }> };
export async function GET(request: Request, context: Context) { return proxy(request, context, "GET"); }
export async function POST(request: Request, context: Context) { return proxy(request, context, "POST"); }
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const { path } = await context.params, target = path.join("/");
  if (!(method === "GET" ? read : write).test(target)) return failure(404);
  if (new URL(request.url).search) return failure(400);
  if (method === "POST" && (!isSameOriginRequest(request) || !request.headers.get("content-type")?.startsWith("application/json"))) return failure(403);
  const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
  let body: string | undefined;
  if (method === "POST") {
    const reader = request.body?.getReader(); if (!reader) return failure(400);
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > 16 * 1024) { await reader.cancel(); return failure(413); } chunks.push(next.value); }
    body = Buffer.concat(chunks).toString("utf8"); try { JSON.parse(body); } catch { return failure(400); }
  }
  try {
    const [supplier, ...operation] = path;
    const response = await apiFetch(`${base}/v1/sourcing/suppliers/${supplier}/shipos${operation.length ? `/${operation.join("/")}` : ""}`, {
      method, body, headers: body ? { "content-type": "application/json" } : undefined, cache: "no-store", signal: AbortSignal.timeout(40_000),
    });
    if (!response.ok) {
      const data = [409, 422].includes(response.status) ? await response.json().catch(() => null) : null;
      return failure(response.status, typeof data?.message === "string" && data.message.length < 400 ? data.message : undefined);
    }
    const headers = new Headers({ "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-type": response.headers.get("content-type") ?? "application/json" });
    if (path.at(-1) === "label") { headers.set("content-disposition", response.headers.get("content-disposition") ?? "attachment; filename=shipos.pdf"); headers.set("content-security-policy", "default-src 'none'; sandbox"); }
    return new Response(response.body, { status: response.status, headers });
  } catch { return failure(502); }
}
function failure(status: number, message?: string) {
  return Response.json({ message: message ?? (status === 403 ? "当前账号没有此操作权限" : status === 401 ? "登录已失效，请重新登录" : status === 413 ? "请求内容过大" : "ShipOS 操作未完成，请检查输入或稍后重试") }, { status, headers: { "cache-control": "private, no-store" } });
}
