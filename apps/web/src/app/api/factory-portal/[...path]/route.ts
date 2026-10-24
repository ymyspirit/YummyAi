import { FactoryTaskQuerySchema } from "@yummyai/contracts/suppliers/factory-portal";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import {
  FactoryPortalSessionViewSchema, FactoryQuantityHistoryQuerySchema, FactoryQuantityReportInputSchema,
  FactoryQuantityWorkspaceSchema, FactoryQuantityReportResultSchema, FactoryQuantityAccessViewSchema,
  type FactoryQuantityReportInput,
} from "@yummyai/contracts/suppliers/factory-quantity";
import { factoryPortalOnly } from "../../../../factory-portal-mode";
import {
  factoryUserFetch,
  factoryIdentity,
  factoryWriteOrigin,
  factoryAuthFailure,
} from "../../../../factory-auth/server";
const id = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
  reads = new RegExp(`^(session|work-items(/${id}(/file)?)?)$`, "i"),
  writes = new RegExp(`^work-items/${id}/feedback$`, "i");
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const quantityPath = new RegExp("^work-items/(" + id + ")/quantity(/(reports|access))?$", "i");
const privateHeaders = {
  "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
};
class QuantityProxyError extends Error {
  constructor(readonly status: number, readonly code?: "factory_authority_changed") { super("Factory quantity request unavailable"); }
}
class QuantityBodyLimit extends Error {}
export async function GET(request: Request, context: Context) {
  return proxy(request, context, "GET");
}
export async function POST(request: Request, context: Context) {
  return proxy(request, context, "POST");
}
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  if (!factoryPortalOnly()) return new Response(null, { status: 404 });
  const path = (await context.params).path.join("/"),
    query = new URL(request.url).searchParams;
  const quantity = quantityPath.exec(path);
  if (quantity) {
    if (!(method === "GET" && quantity[3] !== "reports" || method === "POST" && quantity[3] === "reports")) return quantityFailure(404);
    return quantityProxy(request, quantity[1]!.toLowerCase(), quantity[3] ?? "", query, method);
  }
  if (!(method === "GET" ? reads : writes).test(path)) return failure(404);
  if (
    path === "work-items"
      ? [...query.keys()].some((key) => query.getAll(key).length !== 1) ||
        !FactoryTaskQuerySchema.safeParse(Object.fromEntries(query)).success
      : query.size > 0
  )
    return failure(400);
  try {
    let body: string | undefined;
    if (method === "POST") {
      factoryWriteOrigin(request, factoryIdentity().configuration.origin);
      if (!request.headers.get("content-type")?.startsWith("application/json")) return failure(400);
      const reader = request.body?.getReader();
      if (!reader) return failure(400);
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 32768) return failure(413);
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      body = Buffer.concat(chunks).toString("utf8");
      try {
        JSON.parse(body);
      } catch {
        return failure(400);
      }
    }
    const response = await factoryUserFetch(request, `${path}${query.size ? `?${query}` : ""}`, {
      method,
      body,
      headers: body ? { "content-type": "application/json" } : {},
      signal: request.signal,
    });
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    for (const name of ["content-type", "content-disposition"])
      if (response.headers.has(name)) headers.set(name, response.headers.get(name)!);
    if (path.endsWith("/file"))
      headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    return factoryAuthFailure(error, request);
  }
}
async function quantityJson(response: Response, maximum: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("empty");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new QuantityBodyLimit(); }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}
async function quantityUpstream(request: Request, path: string, method: "GET" | "POST", input?: FactoryQuantityReportInput) {
  const response = await factoryUserFetch(request, path, {
    method, cache: "no-store", redirect: "error",
    signal: method === "GET" ? AbortSignal.any([request.signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(60_000),
    ...(input ? { headers: { "content-type": "application/json" }, body: JSON.stringify(input) } : {}),
  });
  if (!response.ok) {
    const raw = response.status === 409 ? await quantityJson(response, 8_192).catch(() => null) : null;
    if (raw && typeof raw === "object" && "code" in raw && raw.code === "factory_authority_changed")
      throw new QuantityProxyError(409, "factory_authority_changed");
    if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
    throw new QuantityProxyError([400, 401, 403, 404, 409, 413, 415, 422, 429, 503].includes(response.status) ? response.status : 502);
  }
  if (response.status !== (method === "GET" ? 200 : 201) ||
    response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    await response.body?.cancel().catch(() => {}); throw new QuantityProxyError(502);
  }
  return quantityJson(response, 1_048_576);
}
async function quantityProxy(request: Request, assignmentId: string, action: string, query: URLSearchParams, method: "GET" | "POST") {
  if (!EntityIdSchema.safeParse(assignmentId).success ||
    [...query.keys()].some(key => query.getAll(key).length !== 1) ||
    (method === "POST" || action === "access") && query.size > 0) return quantityFailure(400);
  const history = FactoryQuantityHistoryQuerySchema.safeParse(Object.fromEntries(query));
  if (!history.success) return quantityFailure(400);
  let input: FactoryQuantityReportInput | undefined;
  try {
    if (method === "POST") {
      factoryWriteOrigin(request, factoryIdentity().configuration.origin);
      if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return quantityFailure(415);
      try { input = FactoryQuantityReportInputSchema.parse(await quantityJson(new Response(request.body), 32_768)); }
      catch (error) { return quantityFailure(error instanceof QuantityBodyLimit ? 413 : 400); }
    }
    const before = FactoryPortalSessionViewSchema.parse(await quantityUpstream(request, "session", "GET"));
    if (!before.canRead || method === "POST" && !before.canRespond) return quantityFailure(403);
    const base = "work-items/" + assignmentId + "/quantity";
    const params = method === "GET" && action === "" ? new URLSearchParams({
      limit: String(history.data.limit), ...(history.data.before ? { before: history.data.before.toLowerCase() } : {}),
    }).toString() : "";
    const raw = await quantityUpstream(request, base + (action ? "/" + action : "") + (params ? "?" + params : ""), method, input);
    const value = method === "POST" ? FactoryQuantityReportResultSchema.parse(raw) :
      action === "access" ? FactoryQuantityAccessViewSchema.parse(raw) : FactoryQuantityWorkspaceSchema.parse(raw);
    if (value.assignmentId !== assignmentId) throw new QuantityProxyError(502);
    if (value.contextAuthority !== before.contextAuthority) throw new QuantityProxyError(409, "factory_authority_changed");

    // Check scope after the entire bounded body arrives. A changing quantity basis
    // must not hide an already successful receipt with the same task permission.
    const access = FactoryQuantityAccessViewSchema.parse(await quantityUpstream(request, base + "/access", "GET"));
    const after = FactoryPortalSessionViewSchema.parse(await quantityUpstream(request, "session", "GET"));
    if (before.contextAuthority !== after.contextAuthority || value.contextAuthority !== access.contextAuthority ||
      after.contextAuthority !== access.contextAuthority || value.taskFingerprint !== access.taskFingerprint)
      throw new QuantityProxyError(409, "factory_authority_changed");
    if (access.assignmentId !== assignmentId) throw new QuantityProxyError(502);
    if (!after.canRead || method === "POST" && (!after.canRespond || !access.access.canReport)) throw new QuantityProxyError(403);
    if (access.access.canReport && !after.canRespond) throw new QuantityProxyError(502);

    if (method === "POST") {
      const result = FactoryQuantityReportResultSchema.parse(value);
      if (canonicalJson(quantityInputIdentity(result.report.input)) !== canonicalJson(quantityInputIdentity(input!)))
        throw new QuantityProxyError(502);
    } else if (action !== "access") {
      const page = FactoryQuantityWorkspaceSchema.parse(value), beforeId = history.data.before?.toLowerCase();
      if (page.reports.length > history.data.limit ||
        new Set(page.reports.map(row => row.reportId)).size !== page.reports.length ||
        page.reports.some((row, index) => row.assignmentId !== assignmentId ||
          beforeId !== undefined && row.reportId >= beforeId || index > 0 && page.reports[index - 1]!.reportId <= row.reportId) ||
        page.nextCursor !== null && (page.reports.length !== history.data.limit || page.nextCursor !== page.reports.at(-1)?.reportId))
        throw new QuantityProxyError(502);
    }
    return Response.json(value, { status: method === "POST" ? 201 : 200, headers: privateHeaders });
  } catch (error) {
    if (error instanceof QuantityProxyError) return quantityFailure(error.status, error.code);
    const response = factoryAuthFailure(error, request);
    Object.entries(privateHeaders).forEach(([key, value]) => response.headers.set(key, value));
    return response;
  }
}
function quantityInputIdentity(input: FactoryQuantityReportInput) {
  const fraction = /\.(\d+)/.exec(input.observedAt)?.[1];
  return { ...input, idempotencyKey: input.idempotencyKey.toLowerCase(), acceptedFeedbackId: input.acceptedFeedbackId.toLowerCase(),
    observedAt: fraction && /[1-9]/.test(fraction.slice(3)) ? input.observedAt : new Date(input.observedAt).toISOString() };
}
function quantityFailure(status: number, code?: "factory_authority_changed") {
  const message = code ? "当前本人或任务授权已变化 请重新核对" :
    status === 401 ? "请登录自己的工厂协作账户" : status === 403 ? "当前任务授权不足 请联系运营核对" :
      status === 404 ? "当前任务或清点入口不可访问" : status === 409 ? "原文件 接受回执或数量依据已变化 请保留原报告后核对" :
        [400, 413, 415, 422].includes(status) ? "请核对完整清点数量 实际时间和原凭据" :
          "清点服务结果尚未确认 请保留原报告和原请求编号";
  return Response.json({ message, ...(code ? { code } : {}) }, { status, headers: privateHeaders });
}
function failure(status: number) {
  return Response.json(
    { message: status === 404 ? "未找到此入口" : "请求无效 请重新核对" },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}
