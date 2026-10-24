import { createHash } from "node:crypto";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import {
  FACTORY_ERP_HEADERS, FACTORY_ERP_MAX_BYTES, UploadFactoryErpImportSchema, ApplyFactoryErpImportSchema,
  FactoryErpPageQuerySchema, FactoryErpCandidatesQuerySchema, FactoryErpImportViewSchema,
  FactoryErpCandidatePageSchema, FactoryErpApplyResultSchema,
  FactoryErpImportListQuerySchema, FactoryErpImportListSchema,
  FactoryErpSourceLifecycleSchema, FactoryErpSourceLifecyclePageSchema,
  FactoryErpApplicationListQuerySchema, FactoryErpApplicationPageSchema,
  type UploadFactoryErpImport, type ApplyFactoryErpImport, type FactoryErpImportView,
} from "@yummyai/contracts/order/factory-erp-import";
import {
  ChangeFactoryErpBindingSchema, FactoryErpBindingViewSchema, FactoryErpBindingPageQuerySchema,
  FactoryErpBindingPageSchema, FactoryErpBindingChangePageQuerySchema, FactoryErpBindingChangePageSchema,
  FactoryErpBindingChangeResultSchema, type ChangeFactoryErpBinding,
} from "@yummyai/contracts/order/factory-erp-binding";
import {
  ReviewFactoryErpVoidSchema, FactoryErpVoidReviewResultSchema, FactoryErpVoidObservationPageQuerySchema,
  FactoryErpVoidObservationPageSchema, FactoryErpVoidObservationDetailSchema, FactoryErpVoidReviewPageQuerySchema,
  FactoryErpVoidReviewPageSchema, type ReviewFactoryErpVoid, type FactoryErpVoidObservationView,
} from "@yummyai/contracts/order/factory-erp-void-review";
import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
import { assertErpIdentityCurrent, erpAuthFailure, erpRequestIdentity } from "../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../identity/core";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Context = { params: Promise<{ path: string[] }> };
const Id = EntityIdSchema.transform(value => value.toLowerCase());
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const readPermissions = ["order:read", "order:pii:read", "design:read", "asset:read"];
class PayloadLimit extends Error {}
export async function GET(request: Request, context: Context) { return proxy(request, context, "GET"); }
export async function POST(request: Request, context: Context) { return proxy(request, context, "POST"); }

async function readJson(response: Response, maximum: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("empty");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new PayloadLimit(); }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}

async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const { path } = await context.params;
  const upload = method === "POST" && path.length === 1 && path[0] === "upload";
  const candidates = method === "GET" && path.length === 1 && path[0] === "candidates";
  const list = method === "GET" && path.length === 1 && path[0] === "imports";
  const lifecycleList = method === "GET" && path.length === 1 && path[0] === "lifecycle";
  const bindings = method === "GET" && path.length === 1 && path[0] === "bindings";
  const bindingId = path[0] === "bindings" ? Id.safeParse(path[1]) : null;
  const binding = method === "GET" && path.length === 2 && bindingId?.success === true;
  const changes = method === "GET" && path.length === 3 && bindingId?.success === true && path[2] === "changes";
  const changeId = path[2] === "changes" ? Id.safeParse(path[3]) : null;
  const change = method === "GET" && path.length === 4 && bindingId?.success === true && changeId?.success === true;
  const changeWrite = method === "POST" && path.length === 3 && bindingId?.success === true && path[2] === "changes";
  const voidObservations = method === "GET" && path.length === 3 && bindingId?.success === true && path[2] === "void-observations";
  const voidObservationId = path[2] === "void-observations" ? Id.safeParse(path[3]) : null;
  const voidObservation = method === "GET" && path.length === 4 && bindingId?.success === true && voidObservationId?.success === true;
  const voidReviews = method === "GET" && path.length === 3 && bindingId?.success === true && path[2] === "void-reviews";
  const voidReviewId = path[2] === "void-reviews" ? Id.safeParse(path[3]) : null;
  const voidReview = method === "GET" && path.length === 4 && bindingId?.success === true && voidReviewId?.success === true;
  const voidWrite = method === "POST" && path.length === 3 && bindingId?.success === true && path[2] === "void-reviews";
  const importId = path[0] === "imports" ? Id.safeParse(path[1]) : null;
  const detail = method === "GET" && path.length === 2 && importId?.success === true;
  const lifecycle = method === "GET" && path.length === 3 && importId?.success === true && path[2] === "lifecycle";
  const applications = method === "GET" && path.length === 3 && importId?.success === true && path[2] === "applications";
  const applicationId = path[2] === "applications" ? Id.safeParse(path[3]) : null;
  const application = method === "GET" && path.length === 4 && importId?.success === true && applicationId?.success === true;
  const apply = method === "POST" && path.length === 3 && importId?.success === true && path[2] === "apply";
  if (!upload && !candidates && !detail && !apply && !list && !lifecycleList && !lifecycle && !applications && !application &&
    !bindings && !binding && !changes && !change && !changeWrite && !voidObservations && !voidObservation && !voidReviews && !voidReview && !voidWrite) return failure(404);
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => query.getAll(key).length !== 1) || method === "POST" && query.size) return failure(400);
  const page = detail ? FactoryErpPageQuerySchema.safeParse(Object.fromEntries(query)) : null;
  const search = candidates ? FactoryErpCandidatesQuerySchema.safeParse(Object.fromEntries(query)) : null;
  const recent = list || lifecycleList ? FactoryErpImportListQuerySchema.safeParse(Object.fromEntries(query)) : null;
  const applicationPage = applications ? FactoryErpApplicationListQuerySchema.safeParse(Object.fromEntries(query)) : null;
  const bindingPage = bindings ? FactoryErpBindingPageQuerySchema.safeParse(Object.fromEntries(query)) : null;
  const changePage = changes ? FactoryErpBindingChangePageQuerySchema.safeParse(Object.fromEntries(query)) : null;
  const voidPage = voidObservations ? FactoryErpVoidObservationPageQuerySchema.safeParse(Object.fromEntries(query)) : null;
  const reviewsPage = voidReviews ? FactoryErpVoidReviewPageQuerySchema.safeParse(Object.fromEntries(query)) : null;
  if (detail && !page?.success || candidates && !search?.success || (list || lifecycleList) && !recent?.success ||
    lifecycleList && recent?.success && recent.data.cursor !== undefined && !Id.safeParse(recent.data.cursor).success ||
    applications && !applicationPage?.success || bindings && !bindingPage?.success || changes && !changePage?.success ||
    voidObservations && !voidPage?.success || voidReviews && !reviewsPage?.success ||
    (lifecycle || application || binding || change || voidObservation || voidReview) && query.size) return failure(400);
  let input: UploadFactoryErpImport | ApplyFactoryErpImport | ChangeFactoryErpBinding | ReviewFactoryErpVoid | undefined;
  if (method === "POST") {
    if (!isSameOriginRequest(request)) return failure(403);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure(415);
    try {
      const raw = await readJson(new Response(request.body), voidWrite ? 32 * 1024 : 7 * 1024 * 1024);
      input = upload ? UploadFactoryErpImportSchema.parse(raw) : changeWrite ? ChangeFactoryErpBindingSchema.parse(raw) :
        voidWrite ? ReviewFactoryErpVoidSchema.parse(raw) : ApplyFactoryErpImportSchema.parse(raw);
      if (upload) {
        const file = UploadFactoryErpImportSchema.parse(input), bytes = Buffer.from(file.contentBase64, "base64");
        if (bytes.length < 1 || bytes.length > FACTORY_ERP_MAX_BYTES || bytes.toString("base64") !== file.contentBase64 ||
          createHash("sha256").update(bytes).digest("hex") !== file.checksumSha256) return failure(400);
      }
    } catch (error) { return failure(error instanceof PayloadLimit ? 413 : 400); }
  }
  try {
    const identity = await erpRequestIdentity(request), authority = erpSessionAuthority(identity.view);
    const can = (permission: string) => identity.view.permissions.includes(permission) &&
      (identity.view.permissionScopes ? identity.view.permissionScopes[permission] : identity.view.dataScope) === "tenant";
    if (!readPermissions.every(can) || method === "POST" && !can("order:write")) return failure(403);
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    let target = "/v1/factory-erp-imports";
    if (bindings && bindingPage?.success) {
      target += "/bindings?" + new URLSearchParams({ factoryId: bindingPage.data.factoryId.toLowerCase(), limit: String(bindingPage.data.limit),
        ...(bindingPage.data.cursor ? { cursor: bindingPage.data.cursor.toLowerCase() } : {}) });
    } else if (bindingId?.success && (binding || changes || change || changeWrite || voidObservations || voidObservation || voidReviews || voidReview || voidWrite)) {
      target += "/bindings/" + bindingId.data;
      if (changes && changePage?.success) target += "/changes?" + new URLSearchParams({ limit: String(changePage.data.limit),
        ...(changePage.data.cursor ? { cursor: changePage.data.cursor.toLowerCase() } : {}) });
      else if (change && changeId?.success) target += "/changes/" + changeId.data;
      else if (changeWrite) target += "/changes";
      else if (voidObservations && voidPage?.success) target += "/void-observations?" + new URLSearchParams({ limit: String(voidPage.data.limit),
        ...(voidPage.data.cursor !== undefined ? { cursor: String(voidPage.data.cursor) } : {}) });
      else if (voidObservation && voidObservationId?.success) target += "/void-observations/" + voidObservationId.data;
      else if (voidReviews && reviewsPage?.success) target += "/void-reviews?" + new URLSearchParams({ limit: String(reviewsPage.data.limit),
        ...(reviewsPage.data.cursor ? { cursor: reviewsPage.data.cursor } : {}), ...(reviewsPage.data.observationId ? { observationId: reviewsPage.data.observationId } : {}) });
      else if (voidReview && voidReviewId?.success) target += "/void-reviews/" + voidReviewId.data;
      else if (voidWrite) target += "/void-reviews";
    } else if ((list || lifecycleList) && recent?.success) {
      target += (lifecycleList ? "/lifecycle?" : "?") + new URLSearchParams({ factoryId: recent.data.factoryId.toLowerCase(), limit: String(recent.data.limit),
        ...(recent.data.cursor ? { cursor: recent.data.cursor } : {}) });
    } else if (candidates && search?.success) {
      const params = new URLSearchParams({ factoryId: search.data.factoryId.toLowerCase(), limit: String(search.data.limit),
        ...(search.data.q !== undefined ? { q: search.data.q } : {}), ...(search.data.cursor ? { cursor: search.data.cursor } : {}) });
      target += "/candidates?" + params;
    } else if (lifecycle && importId?.success) target += "/" + importId.data + "/lifecycle";
    else if (applications && applicationPage?.success && importId?.success) {
      target += "/" + importId.data + "/applications?" + new URLSearchParams({ limit: String(applicationPage.data.limit),
        ...(applicationPage.data.cursor ? { cursor: applicationPage.data.cursor.toLowerCase() } : {}) });
    } else if (application && importId?.success && applicationId?.success) target += "/" + importId.data + "/applications/" + applicationId.data;
    else if (detail && page?.success && importId?.success) {
      target += "/" + importId.data + "?" + new URLSearchParams({ offset: String(page.data.offset), limit: String(page.data.limit) });
    } else if (apply && importId?.success) target += "/" + importId.data + "/apply";
    const response = await apiFetch(base + target, {
      method, cache: "no-store", redirect: "error",
      signal: method === "GET" ? AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(110_000),
      ...(input ? { body: JSON.stringify(input), headers: { "content-type": "application/json" } } : {}),
    });
    await assertErpIdentityCurrent(identity);
    if (!response.ok) {
      const raw = response.status === 409 ? await readJson(response, 8_192).catch(() => null) : null;
      if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
      await assertErpIdentityCurrent(identity);
      if (raw && typeof raw === "object" && "code" in raw && raw.code === "authority_changed") return failure(409, "authority_changed");
      return failure([400, 401, 403, 404, 409, 413, 415, 422, 429, 503].includes(response.status) ? response.status : 502);
    }
    if (response.status !== (method === "POST" ? 201 : 200)) { await response.body?.cancel().catch(() => {}); return failure(502); }
    const raw = await readJson(response, 8 * 1024 * 1024);
    let value: unknown;
    if (voidObservations && voidPage?.success && bindingId?.success) {
      const result = FactoryErpVoidObservationPageSchema.parse(raw), basis = result.basis;
      if (basis.bindingId !== bindingId.data || result.items.length > voidPage.data.limit ||
        new Set(result.items.map(item => item.id)).size !== result.items.length || new Set(result.items.map(item => item.sequence)).size !== result.items.length ||
        result.items.some((item, index) => !validVoidObservation(item, basis) || voidPage.data.cursor !== undefined && item.sequence >= voidPage.data.cursor ||
          index > 0 && item.sequence >= result.items[index - 1]!.sequence) ||
        result.nextCursor !== null && (result.items.length === 0 || result.nextCursor !== result.items.at(-1)!.sequence)) return failure(502);
      value = result;
    } else if (voidObservation && voidObservationId?.success && bindingId?.success) {
      const result = FactoryErpVoidObservationDetailSchema.parse(raw);
      if (result.basis.bindingId !== bindingId.data || result.observation.id !== voidObservationId.data || !validVoidObservation(result.observation, result.basis)) return failure(502);
      value = result;
    } else if (voidReviews && reviewsPage?.success && bindingId?.success) {
      const result = FactoryErpVoidReviewPageSchema.parse(raw);
      if (result.items.length > reviewsPage.data.limit || !validIdPage(result, reviewsPage.data.cursor) ||
        result.items.some(item => item.bindingId !== bindingId.data || reviewsPage.data.observationId !== undefined && item.observation.id !== reviewsPage.data.observationId ||
          item.factoryId !== result.items[0]!.factoryId)) return failure(502);
      value = result;
    } else if ((voidReview || voidWrite) && bindingId?.success) {
      const result = FactoryErpVoidReviewResultSchema.parse(raw);
      if (result.bindingId !== bindingId.data || voidReview && voidReviewId?.success && result.id !== voidReviewId.data) return failure(502);
      if (voidWrite) {
        const original = ReviewFactoryErpVoidSchema.parse(input);
        const checksum = createHash("sha256").update(canonicalJson({ version: 1, operation: "factory-erp-void-review", bindingId: bindingId.data, input: original })).digest("hex");
        if (result.originalBindingRevision !== original.expectedBindingRevision || result.originalItemsChecksum !== original.expectedItemsChecksum ||
          result.originalObservationSequence !== original.expectedObservationSequence || result.previousReviewId !== original.expectedPreviousReviewId ||
          original.expectedPreviousReviewId === null && result.reviewRevision !== 1 || result.outcome !== original.outcome || result.reasonCode !== original.reasonCode ||
          result.provenance !== original.provenance || canonicalJson(result.observation) !== canonicalJson(original.observation) ||
          canonicalJson(result.source) !== canonicalJson(original.source) || result.requestChecksum !== checksum) return failure(502);
      }
      value = result;
    } else if (bindings && bindingPage?.success) {
      const result = FactoryErpBindingPageSchema.parse(raw);
      if (result.items.length > bindingPage.data.limit || result.items.some(item => item.factoryId !== bindingPage.data.factoryId.toLowerCase()) ||
        !validIdPage(result, bindingPage.data.cursor)) return failure(502);
      value = result;
    } else if (binding && bindingId?.success) {
      const result = FactoryErpBindingViewSchema.parse(raw);
      if (result.id !== bindingId.data) return failure(502);
      value = result;
    } else if (changes && changePage?.success && bindingId?.success) {
      const result = FactoryErpBindingChangePageSchema.parse(raw);
      if (result.items.length > changePage.data.limit || result.items.some(item => item.bindingId !== bindingId.data) ||
        !validIdPage(result, changePage.data.cursor)) return failure(502);
      value = result;
    } else if ((change || changeWrite) && bindingId?.success) {
      const result = FactoryErpBindingChangeResultSchema.parse(raw);
      if (result.bindingId !== bindingId.data || change && changeId?.success && result.id !== changeId.data) return failure(502);
      if (changeWrite) {
        const original = ChangeFactoryErpBindingSchema.parse(input);
        const checksum = createHash("sha256").update(canonicalJson({ version: 1, operation: "factory-erp-binding-change", bindingId: bindingId.data, input: original })).digest("hex");
        if (result.action !== original.action || result.reasonCode !== original.reasonCode || result.originalRevision !== original.expectedRevision ||
          result.originalItemsChecksum !== original.expectedItemsChecksum || result.originalObservationSequence !== original.expectedObservationSequence ||
          canonicalJson(result.source) !== canonicalJson(original.source) || result.requestChecksum !== checksum) return failure(502);
      }
      value = result;
    } else if (lifecycleList && recent?.success) {
      const result = FactoryErpSourceLifecyclePageSchema.parse(raw);
      if (result.items.length > recent.data.limit || result.items.some(item => item.factoryId !== recent.data.factoryId.toLowerCase()) ||
        !validIdPage(result, recent.data.cursor)) return failure(502);
      value = result;
    } else if (lifecycle && importId?.success) {
      const result = FactoryErpSourceLifecycleSchema.parse(raw);
      if (result.id !== importId.data) return failure(502);
      value = result;
    } else if (applications && importId?.success && applicationPage?.success) {
      const result = FactoryErpApplicationPageSchema.parse(raw);
      if (result.items.length > applicationPage.data.limit || result.items.some(item => item.importId !== importId.data) ||
        !validIdPage(result, applicationPage.data.cursor)) return failure(502);
      value = result;
    } else if (application && importId?.success && applicationId?.success) {
      const result = FactoryErpApplyResultSchema.parse(raw);
      if (result.id !== applicationId.data || result.importId !== importId.data) return failure(502);
      value = result;
    } else if (list && recent?.success) {
      const result = FactoryErpImportListSchema.parse(raw);
      if (result.items.length > recent.data.limit || result.items.some(item => item.factoryId !== recent.data.factoryId.toLowerCase() ||
        item.byteSize > FACTORY_ERP_MAX_BYTES || item.rowCount > 5000) || new Set(result.items.map(item => item.id)).size !== result.items.length ||
        result.nextCursor !== null && (!result.items.length || result.nextCursor.length > 300 || result.nextCursor === recent.data.cursor)) return failure(502);
      value = result;
    } else if (candidates && search?.success) {
      const result = FactoryErpCandidatePageSchema.parse(raw);
      if (result.items.length > search.data.limit ||
        new Set(result.items.map(row => row.deliveryItemId)).size !== result.items.length ||
        result.nextCursor !== null && (!EntityIdSchema.safeParse(result.nextCursor).success ||
          search.data.cursor !== undefined && result.nextCursor.toLowerCase() >= search.data.cursor.toLowerCase())) return failure(502);
      value = result;
    } else if (apply && importId?.success) {
      const result = FactoryErpApplyResultSchema.parse(raw), original = ApplyFactoryErpImportSchema.parse(input);
      const expectedRows = new Set(original.rows.map(row => row.rowNumber));
      const requestChecksum = createHash("sha256").update(canonicalJson({
        version: 1, operation: "factory-erp-apply", importId: importId.data, input: original,
      })).digest("hex");
      if (result.importId !== importId.data || result.fileChecksum !== original.fileChecksum ||
        result.previewChecksum !== original.previewChecksum || result.requestChecksum !== requestChecksum || result.appliedRows !== original.rows.length ||
        result.observations.length !== original.rows.length || new Set(result.observations.map(row => row.rowNumber)).size !== original.rows.length ||
        result.observations.some(row => !expectedRows.has(row.rowNumber))) return failure(502);
      value = result;
    } else {
      const result = FactoryErpImportViewSchema.parse(raw);
      if (!validPage(result) || detail && page?.success && (result.id !== (importId?.success ? importId.data : null) ||
        result.offset !== page.data.offset || result.limit !== page.data.limit)) return failure(502);
      if (upload) {
        const original = UploadFactoryErpImportSchema.parse(input);
        if (result.factoryId !== original.factoryId.toLowerCase() || result.fileChecksum !== original.checksumSha256 ||
          result.fileName !== original.fileName || result.byteSize !== Buffer.from(original.contentBase64, "base64").length ||
          result.format !== original.fileName.toLowerCase().split(".").at(-1) || result.offset !== 0 || result.limit !== 25) return failure(502);
      }
      value = result;
    }
    await assertErpIdentityCurrent(identity);
    return Response.json(value, { status: method === "POST" ? 201 : 200, headers: { ...headers, "x-yummyai-context-authority": authority } });
  } catch (error) {
    if (error instanceof PersonalSessionError) {
      const response = erpAuthFailure(error, request);
      Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value)); return response;
    }
    return failure(502);
  }
}
function validIdPage(value: { items: Array<{ id: string }>; nextCursor: string | null }, cursor?: string) {
  return new Set(value.items.map(item => item.id)).size === value.items.length &&
    value.items.every((item, index) => (!cursor || item.id.toLowerCase() < cursor.toLowerCase()) &&
      (index === 0 || item.id.toLowerCase() < value.items[index - 1]!.id.toLowerCase())) &&
    (value.nextCursor === null || value.items.length > 0 && value.nextCursor.toLowerCase() === value.items.at(-1)!.id.toLowerCase());
}
function validVoidObservation(value: FactoryErpVoidObservationView, basis: { bindingId: string; factoryId: string; bindingRevision: number; itemsChecksum: string; observationSequence: number }) {
  return value.sequence <= basis.observationSequence && (!value.latestReview || value.latestReview.bindingId === basis.bindingId &&
    value.latestReview.factoryId === basis.factoryId && value.latestReview.originalBindingRevision === basis.bindingRevision && value.latestReview.originalItemsChecksum === basis.itemsChecksum);
}
function validPage(value: FactoryErpImportView) {
  return value.byteSize <= FACTORY_ERP_MAX_BYTES && value.rowCount <= 5000 && value.limit <= 100 &&
    value.offset <= 5000 && value.rows.length <= value.limit && value.offset + value.rows.length <= value.rowCount &&
    new Set(value.headers).size === FACTORY_ERP_HEADERS.length && FACTORY_ERP_HEADERS.every(header => value.headers.includes(header)) &&
    new Set(value.rows.map(row => row.rowNumber)).size === value.rows.length &&
    value.rows.every((row, index) => index === 0 || value.rows[index - 1]!.rowNumber < row.rowNumber);
}
function failure(status: number, code?: "authority_changed") {
  const message = code ? "当前本人或读取权限已变化 私有导入资料已隐藏" :
    status === 401 ? "请登录自己的运营账户" : status === 403 ? "当前账户没有此工厂导入操作所需权限" :
      status === 404 ? "原导入或候选当前不可访问" : status === 409 ? "原文件预览 绑定或提交依据已变化 请保留原请求后核对" :
        status === 413 ? "完整原文件或整组绑定超过支持大小 未截断提交" :
          [400, 415, 422].includes(status) ? "请核对原文件格式 固定表头 完整组绑定及确认依据" :
            "工厂导入结果尚未确认 请保留原请求编号后重试";
  return Response.json({ message, ...(code ? { code } : {}) }, { status, headers });
}
