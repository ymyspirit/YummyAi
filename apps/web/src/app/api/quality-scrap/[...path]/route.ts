import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AllocateQualityScrapInputSchema, QualityScrapHistoryQuerySchema, QualityScrapWorkspaceSchema, QualityScrapResultSchema,
  type AllocateQualityScrapInput, type QualityScrapReviewView } from "@yummyai/contracts/order/quality-scrap";
import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
import { assertErpIdentityCurrent, erpAuthFailure, erpRequestIdentity } from "../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../identity/core";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const Id = EntityIdSchema.transform(value => value.toLowerCase());
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
class PayloadLimitError extends Error {}
export async function GET(request: Request, context: Context) { return proxy(request, context, "GET"); }
export async function POST(request: Request, context: Context) { return proxy(request, context, "POST"); }

async function readJson(response: Response, maximum: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("empty");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new PayloadLimitError(); }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const { path } = await context.params, id = Id.safeParse(path[1]);
  if (path[0] !== "orders" || !id.success || path[2] !== "quality-scrap" ||
    !(method === "GET" && path.length === 3 || method === "POST" && path.length === 4 && path[3] === "reviews")) return failure(404);
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => params.getAll(key).length !== 1) || method === "POST" && params.size) return failure(400);
  const query = QualityScrapHistoryQuerySchema.safeParse(Object.fromEntries(params));
  if (!query.success) return failure(400);
  let input: AllocateQualityScrapInput | undefined;
  if (method === "POST") {
    if (!isSameOriginRequest(request)) return failure(403);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure(415);
    try { input = AllocateQualityScrapInputSchema.parse(await readJson(new Response(request.body), 262_144)); }
    catch (error) { return failure(error instanceof PayloadLimitError ? 413 : 400); }
  }
  try {
    const identity = await erpRequestIdentity(request), authority = erpSessionAuthority(identity.view);
    const can = (permission: string) => identity.view.permissions.includes(permission) &&
      (identity.view.permissionScopes ? identity.view.permissionScopes[permission] : identity.view.dataScope) === "tenant";
    const canRead = can("order:read"), canWrite = can("order:write");
    if (!canRead || method === "POST" && !canWrite) return failure(403);
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    const search = method === "GET" ? new URLSearchParams(Object.entries(query.data).map(([key, value]) => [key, String(value)])).toString() : "";
    const response = await apiFetch(base + "/v1/production/orders/" + id.data + "/quality-scrap" + (method === "POST" ? "/reviews" : "") + (search ? "?" + search : ""), {
      method, cache: "no-store", redirect: "error",
      signal: method === "GET" ? AbortSignal.any([request.signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(60_000),
      ...(input ? { headers: { "content-type": "application/json" }, body: JSON.stringify(input) } : {}),
    });
    await assertErpIdentityCurrent(identity);
    if (!response.ok) {
      const raw = response.status === 409 ? await readJson(response, 8_192).catch(() => null) : null;
      if (raw && typeof raw === "object" && "code" in raw && raw.code === "authority_changed") return failure(409, "authority_changed");
      return failure([400, 401, 403, 404, 409, 413, 422, 429, 503].includes(response.status) ? response.status : 502);
    }
    if (response.status !== (method === "GET" ? 200 : 201)) return failure(502);
    const raw = await readJson(response, 8_388_608);
    const value = method === "GET" ? QualityScrapWorkspaceSchema.parse(raw) : QualityScrapResultSchema.parse(raw);
    if (value.contextAuthority !== authority) return failure(409, "authority_changed");
    if (value.access.canWrite !== canWrite) return failure(502);
    if (method === "GET") {
      const page = QualityScrapWorkspaceSchema.parse(value), before = query.data.before ? Id.parse(query.data.before) : null;
      if (page.basis.productionOrderId !== id.data || page.reviews.length > query.data.limit ||
        new Set(page.basis.groups.map(row => row.qualityGroupId)).size !== page.basis.groups.length ||
        new Set(page.basis.lots.map(row => row.sourceQuantityReviewId)).size !== page.basis.lots.length ||
        new Set(page.reviews.map(row => row.id)).size !== page.reviews.length ||
        page.reviews.some((row, index) => row.productionOrderId !== id.data || !consistentReview(row) ||
          before !== null && row.id >= before || index > 0 && page.reviews[index - 1]!.id <= row.id) ||
        page.nextCursor !== null && (page.reviews.length !== query.data.limit || page.nextCursor !== page.reviews.at(-1)?.id)) return failure(502);
    } else {
      const row = QualityScrapResultSchema.parse(value).review, original = AllocateQualityScrapInputSchema.parse(input);
      if (row.productionOrderId !== id.data || row.createdBy !== identity.view.userId || !consistentReview(row) ||
        canonicalJson(requestIdentity(row.input)) !== canonicalJson(requestIdentity(original))) return failure(502);
    }
    await assertErpIdentityCurrent(identity);
    return Response.json(value, { status: method === "GET" ? 200 : 201, headers });
  } catch (error) {
    if (error instanceof PersonalSessionError) {
      const response = erpAuthFailure(error, request); Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value)); return response;
    }
    return failure(502);
  }
}
function consistentReview(row: QualityScrapReviewView) {
  return row.productionVersionId === Id.parse(row.input.productionVersionId) &&
    row.rootInspectionId === Id.parse(row.input.expectedRootInspectionId) &&
    row.quantityReviewId === Id.parse(row.input.expectedQuantityReviewId) &&
    row.previousReviewId === (row.input.expectedScrapReviewId === null ? null : Id.parse(row.input.expectedScrapReviewId));
}
function requestIdentity(input: AllocateQualityScrapInput) {
  return { ...input, productionVersionId: Id.parse(input.productionVersionId),
    expectedRootInspectionId: Id.parse(input.expectedRootInspectionId), expectedQuantityReviewId: Id.parse(input.expectedQuantityReviewId),
    expectedScrapReviewId: input.expectedScrapReviewId === null ? null : Id.parse(input.expectedScrapReviewId),
    occurredAt: canonicalInstant(input.occurredAt), evidenceAssetIds: input.evidenceAssetIds.map(value => Id.parse(value)),
    allocations: input.allocations.map(row => ({ ...row, qualityGroupId: Id.parse(row.qualityGroupId), sourceQuantityReviewId: Id.parse(row.sourceQuantityReviewId) })) };
}
function canonicalInstant(value: string) {
  const fraction = /\.(\d+)/.exec(value)?.[1];
  return fraction && /[1-9]/.test(fraction.slice(3)) ? value : new Date(value).toISOString();
}
function failure(status: number, code?: "authority_changed") {
  const message = code ? "当前身份或权限范围已变化 请重新核对"
    : status === 401 ? "请登录自己的运营账户" : status === 403 ? "当前账户没有原生产报废归属权限" : status === 404 ? "原生产或报废归属凭证当前不可访问"
      : status === 409 ? "原生产 核准批次或报废归属依据已变化 请保留原请求后核对"
        : [400, 413, 415, 422].includes(status) ? "请核对原失败组 新增报废批次 实际数量和完整凭据"
          : "报废归属结果暂时无法确认 请保留原填写和原请求编号";
  return Response.json({ message, ...(code ? { code } : {}) }, { status, headers });
}
