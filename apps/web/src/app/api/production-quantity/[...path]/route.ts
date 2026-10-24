import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { ProductionQuantityHistoryQuerySchema, ProductionQuantityReportInputSchema, ProductionQuantityReviewInputSchema,
  ProductionQuantityWorkspaceSchema, ProductionQuantityReportResultSchema, ProductionQuantityReviewResultSchema,
  type ProductionQuantityReportInput, type ProductionQuantityReviewInput } from "@yummyai/contracts/order/production-quantity";
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
    while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new PayloadLimitError(); } chunks.push(chunk.value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const { path } = await context.params, id = Id.safeParse(path[1]);
  const action = path.length === 4 && ["reports", "reviews"].includes(path[3]!) ? path[3] : null;
  if (path[0] !== "orders" || !id.success || path[2] !== "quantity" ||
      !(method === "GET" && path.length === 3 || method === "POST" && action)) return failure(404);
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => params.getAll(key).length !== 1) || method === "POST" && params.size) return failure(400);
  const query = ProductionQuantityHistoryQuerySchema.safeParse(Object.fromEntries(params));
  if (!query.success) return failure(400);
  let input: ProductionQuantityReportInput | ProductionQuantityReviewInput | undefined;
  if (method === "POST") {
    if (!isSameOriginRequest(request)) return failure(403);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure(415);
    try {
      const raw = await readJson(new Response(request.body), 262_144);
      input = action === "reports" ? ProductionQuantityReportInputSchema.parse(raw) : ProductionQuantityReviewInputSchema.parse(raw);
    } catch (error) { return failure(error instanceof PayloadLimitError ? 413 : 400); }
  }
  try {
    const identity = await erpRequestIdentity(request), authority = erpSessionAuthority(identity.view);
    const hasRead = identity.view.permissions.includes("order:read") &&
      (identity.view.permissionScopes ? identity.view.permissionScopes["order:read"] : identity.view.dataScope) === "tenant";
    const canWrite = identity.view.permissions.includes("order:write") &&
      (identity.view.permissionScopes ? identity.view.permissionScopes["order:write"] : identity.view.dataScope) === "tenant";
    if (!hasRead || method === "POST" && !canWrite) return failure(403);
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    const search = method === "GET" ? new URLSearchParams(Object.entries(query.data).map(([key, value]) => [key, String(value)])).toString() : "";
    const response = await apiFetch(`${base}/v1/production/orders/${id.data}/quantity${action ? `/${action}` : ""}${search ? `?${search}` : ""}`, {
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
    const value = method === "GET" ? ProductionQuantityWorkspaceSchema.parse(raw)
      : action === "reports" ? ProductionQuantityReportResultSchema.parse(raw) : ProductionQuantityReviewResultSchema.parse(raw);
    if (value.contextAuthority !== authority) return failure(409, "authority_changed");
    if (value.access.canWrite !== canWrite) return failure(502);
    if (method === "GET") {
      const page = ProductionQuantityWorkspaceSchema.parse(value);
      if (page.basis.productionOrderId !== id.data) return failure(502);
      for (const [rows, cursor, before] of [[page.reports, page.reportsNextCursor, query.data.reportsBefore],
        [page.reviews, page.reviewsNextCursor, query.data.reviewsBefore]] as const) {
        if (rows.length > query.data.limit || new Set(rows.map(row => row.id)).size !== rows.length ||
          rows.some((row, index) => row.productionOrderId !== id.data || before && row.id >= Id.parse(before) || index > 0 && rows[index - 1]!.id <= row.id) ||
          cursor !== null && (rows.length !== query.data.limit || cursor !== rows.at(-1)?.id)) return failure(502);
      }
      if (page.reports.some(row => row.productionVersionId !== Id.parse(row.input.productionVersionId) || row.previousReviewId !== nullableId(row.input.expectedReviewId) || row.basisFingerprint !== row.input.expectedBasisFingerprint) ||
        page.reviews.some(row => row.reportId !== Id.parse(row.input.reportId) || row.previousReviewId !== nullableId(row.input.expectedReviewId) || row.cumulativeStoppedQuantity < row.input.stoppedDelta)) return failure(502);
    } else if (action === "reports") {
      const row = ProductionQuantityReportResultSchema.parse(value).report, original = ProductionQuantityReportInputSchema.parse(input);
      if (row.productionOrderId !== id.data || row.productionVersionId !== Id.parse(original.productionVersionId) || row.createdBy !== identity.view.userId ||
        row.previousReviewId !== nullableId(original.expectedReviewId) || row.basisFingerprint !== original.expectedBasisFingerprint ||
        canonicalJson(reportIdentity(row.input)) !== canonicalJson(reportIdentity(original))) return failure(502);
    } else {
      const row = ProductionQuantityReviewResultSchema.parse(value).review, original = ProductionQuantityReviewInputSchema.parse(input);
      if (row.productionOrderId !== id.data || row.reportId !== Id.parse(original.reportId) || row.createdBy !== identity.view.userId ||
        row.previousReviewId !== nullableId(original.expectedReviewId) || row.cumulativeStoppedQuantity < original.stoppedDelta ||
        canonicalJson(reviewIdentity(row.input)) !== canonicalJson(reviewIdentity(original))) return failure(502);
    }
    await assertErpIdentityCurrent(identity);
    return Response.json(value, { status: method === "GET" ? 200 : 201, headers });
  } catch (error) {
    if (error instanceof PersonalSessionError) { const response = erpAuthFailure(error, request); Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value)); return response; }
    return failure(502);
  }
}
const nullableId = (value: string | null) => value === null ? null : Id.parse(value);
function reportIdentity(input: ProductionQuantityReportInput) {
  return { ...input, productionVersionId: Id.parse(input.productionVersionId), expectedReviewId: nullableId(input.expectedReviewId),
    observedAt: new Date(input.observedAt).toISOString(), evidenceAssetIds: input.evidenceAssetIds.map(value => Id.parse(value)).sort() };
}
function reviewIdentity(input: ProductionQuantityReviewInput) {
  return { ...input, reportId: Id.parse(input.reportId), expectedReviewId: nullableId(input.expectedReviewId), occurredAt: new Date(input.occurredAt).toISOString() };
}
function failure(status: number, code?: "authority_changed") {
  const message = code ? "当前身份或权限范围已变化 请重新核对"
    : status === 401 ? "请登录自己的运营账户" : status === 403 ? "当前账户没有原生产数量权限" : status === 404 ? "原生产或数量凭证当前不可访问"
      : status === 409 ? "原生产版本 核准记录或实物依据已变化 请核对原提交" : [400, 413, 415, 422].includes(status) ? "请核对实际数量 原凭证和完整字段"
        : "数量服务结果暂时无法确认 请保留原填写和原请求编号";
  return Response.json({ message, ...(code ? { code } : {}) }, { status, headers });
}
