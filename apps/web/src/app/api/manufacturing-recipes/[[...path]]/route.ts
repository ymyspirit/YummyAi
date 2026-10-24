import { CreateManufacturingRecipeSchema, ReviseManufacturingRecipeSchema, ReviewManufacturingRecipeSchema, ManufacturingDemandSchema } from "@yummyai/contracts/catalog/manufacturing";
import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
export const dynamic = "force-dynamic";
export const maxDuration = 45;
type Context = { params: Promise<{ path?: string[] }> };
const id = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const getPath = new RegExp(`^(?:references|material-options|${id}(?:/history|/versions/${id})?)?$`, "i");
const postPath = new RegExp(`^(?:${id}/(?:versions|reviews|material-demands))?$`, "i");
export const GET = (request: Request, context: Context) => proxy(request, context, "GET");
export const POST = (request: Request, context: Context) => proxy(request, context, "POST");
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const target = (await context.params).path?.join("/") ?? "";
  if (!(method === "GET" ? getPath : postPath).test(target)) return fail(404);
  if (method === "POST" && (!isSameOriginRequest(request) || !request.headers.get("content-type")?.startsWith("application/json"))) return fail(403);
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return fail(503);
  const query = new URL(request.url).searchParams;
  const allowed = target === "references" ? ["spuId"] : target === "material-options" ? ["spuId", "after", "limit", "search", "selected"]
    : target.endsWith("/history") ? ["before", "limit"] : !target && method === "GET" ? ["spuId", "after", "limit"] : [];
  if ([...query.keys()].some(key => !allowed.includes(key))) return fail(400);
  let body: string | undefined;
  if (method === "POST") {
    try {
      const reader = request.body?.getReader(); if (!reader) return fail(400);
      const chunks: Uint8Array[] = []; let length = 0;
      while (true) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.byteLength;
        if (length > 4 * 1024 * 1024) { await reader.cancel(); return fail(413); }
        chunks.push(part.value);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const schema = !target ? CreateManufacturingRecipeSchema : target.endsWith("/versions") ? ReviseManufacturingRecipeSchema
        : target.endsWith("/reviews") ? ReviewManufacturingRecipeSchema : ManufacturingDemandSchema;
      body = JSON.stringify(schema.parse(input));
    } catch { return fail(400, "请核对制造名称、数量及材料字段后重试"); }
  }
  try {
    const response = await apiFetch(`${base}/v1/manufacturing-recipes${target ? "/" + target : ""}${query.size ? "?" + query : ""}`, {
      method, body, cache: "no-store", headers: body ? { "content-type": "application/json" } : undefined,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(40000)]),
    });
    if (!response.ok) {
      let message: string | undefined;
      let authorityChanged = false;
      if ([409, 422].includes(response.status)) {
        const error = await response.json().catch(() => null);
        if (typeof error?.message === "string" && error.message.length <= 1000) message = error.message;
        authorityChanged = response.status === 409 && error?.code === "authority_changed";
      }
      return fail(response.status, method === "POST" && !target.endsWith("/material-demands") && response.status >= 500
        ? "提交结果尚未确认 请恢复本次提交结果后再继续" : message, authorityChanged);
    }
    return new Response(response.body, { status: response.status, headers: {
      "content-type": "application/json", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    } });
  } catch {
    return fail(502, method === "POST" && !target.endsWith("/material-demands")
      ? "提交结果尚未确认 请恢复本次提交结果后再继续" : "资料暂时无法读取 请重试");
  }
}
function fail(status: number, message?: string, authorityChanged = false) {
  return Response.json({ message: message ?? (status === 401 ? "登录已失效 请重新登录" : status === 403 ? "当前账号没有此操作权限"
    : status === 404 ? "制造记录不存在或不可读取" : status === 413 ? "内容过长 请减少说明文字后再提交" : "操作未完成 请核对资料或稍后重试"),
    ...(authorityChanged ? { code: "authority_changed" } : {}) },
    { status, headers: { "cache-control": "private, no-store" } });
}
