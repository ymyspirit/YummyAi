import { z } from "zod";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { CreateFactoryCapacityPoolSchema, ReviseFactoryCapacityPoolSchema, FactoryCapacityPoolViewSchema,
  FactoryCapacityQuerySchema, FactoryCapacityWorkspaceSchema, FactoryCapacityHistorySchema,
  FactoryCapacityPreviewInputSchema, FactoryCapacityPreviewSchema, ResolveFactoryLocalTimeInputSchema,
  ResolvedFactoryLocalTimeSchema, ProductionCapacityViewSchema } from "@yummyai/contracts/suppliers/factory-capacity";
import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
import { assertErpIdentityCurrent, erpAuthFailure, erpRequestIdentity } from "../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../identity/core";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const Id = EntityIdSchema.transform(value => value.toLowerCase());
class PayloadLimitError extends Error {}
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
export async function GET(request: Request, context: Context) { return proxy(request, context, "GET"); }
export async function POST(request: Request, context: Context) { return proxy(request, context, "POST"); }
async function json(response: Response, maximum: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("empty");
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
    if (size > maximum) { await reader.cancel(); throw new PayloadLimitError("size"); } chunks.push(chunk.value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const { path } = await context.params;
  const factory = path[0] === "factories" && Id.safeParse(path[1]).success ? Id.parse(path[1]) : null;
  const pool = Id.safeParse(path[3]).success ? Id.parse(path[3]) : null;
  const production = path[0] === "production-orders" && Id.safeParse(path[1]).success ? Id.parse(path[1]) : null;
  const route = method === "GET" && factory && path.length === 3 && path[2] === "capacity" ? "workspace"
    : method === "POST" && factory && path.length === 3 && path[2] === "capacity-pools" ? "create"
      : factory && pool && path.length === 5 && path[2] === "capacity-pools" && method === "POST" && path[4] === "revisions" ? "revise"
        : factory && pool && path.length === 5 && path[2] === "capacity-pools" && method === "GET" && path[4] === "history" ? "history"
          : factory && path.length === 3 && path[2] === "capacity-preview" && method === "POST" ? "preview"
            : factory && path.length === 4 && path[2] === "capacity" && path[3] === "resolve-time" && method === "POST" ? "resolve"
              : production && path.length === 3 && path[2] === "capacity" && method === "GET" ? "production" : null;
  if (!route) return failure(404);
  const params = new URL(request.url).searchParams, query = Object.fromEntries(params);
  if ([...params.keys()].some(key => params.getAll(key).length !== 1)) return failure(400);
  const parsedQuery = route === "workspace" ? FactoryCapacityQuerySchema.safeParse(query) : z.object({}).strict().safeParse(query);
  if (!parsedQuery.success) return failure(400);
  let body: unknown;
  if (method === "POST") {
    if (!isSameOriginRequest(request)) return failure(403);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure(415);
    try {
      const raw = await json(new Response(request.body), 262_144);
      body = (route === "create" ? CreateFactoryCapacityPoolSchema : route === "revise" ? ReviseFactoryCapacityPoolSchema
        : route === "resolve" ? ResolveFactoryLocalTimeInputSchema : FactoryCapacityPreviewInputSchema).parse(raw);
    } catch (error) { return failure(error instanceof PayloadLimitError ? 413 : 400); }
  }
  try {
    const identity = await erpRequestIdentity(request), authority = erpSessionAuthority(identity.view);
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    const safePath = path.map(segment => Id.safeParse(segment).success ? Id.parse(segment) : segment).map(encodeURIComponent).join("/");
    const search = route === "workspace" ? new URLSearchParams(Object.entries(parsedQuery.data).map(([key, value]) => [key, String(value)])).toString() : "";
    const response = await apiFetch(`${base}/v1/sourcing/${safePath}${search ? `?${search}` : ""}`, { method, cache: "no-store", redirect: "error",
      signal: method === "GET" ? AbortSignal.any([request.signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(60_000),
      ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    await assertErpIdentityCurrent(identity);
    if (!response.ok) {
      let changed = false;
      if (response.status === 409) { const error = await json(response, 8_192).catch(() => null); changed = !!error && typeof error === "object" && "code" in error && error.code === "authority_changed"; }
      if (changed) return failure(409, "authority_changed");
      return failure([400, 401, 403, 404, 409, 413, 422, 429, 503].includes(response.status) ? response.status : 502);
    }
    const raw = await json(response, 8_388_608);
    const value = (route === "workspace" ? FactoryCapacityWorkspaceSchema : route === "create" || route === "revise" ? FactoryCapacityPoolViewSchema
      : route === "history" ? FactoryCapacityHistorySchema : route === "preview" ? FactoryCapacityPreviewSchema
        : route === "resolve" ? ResolvedFactoryLocalTimeSchema : ProductionCapacityViewSchema).parse(raw);
    if ("contextAuthority" in value && value.contextAuthority !== authority) return failure(409, "authority_changed");
    if ("factoryId" in value && value.factoryId !== factory) return failure(502);
    if (route === "workspace") {
      const row = FactoryCapacityWorkspaceSchema.parse(value), original = FactoryCapacityQuerySchema.parse(parsedQuery.data);
      if (row.days !== original.days || original.from && row.from !== original.from) return failure(502);
      if (original.capabilityVersionId && row.pools.some(item => !item.profile.bindings.some(binding => binding.capabilityVersionId === Id.parse(original.capabilityVersionId)))) return failure(502);
      const first = Date.parse(`${row.from}T00:00:00Z`), dates = new Set(Array.from({ length: row.days }, (_, offset) => new Date(first + offset * 86_400_000).toISOString().slice(0, 10)));
      if (row.calendar.length !== row.days * row.pools.length || row.calendar.some(day => !dates.has(day.localDate))) return failure(502);
    } else if (route === "create" || route === "revise") {
      const row = FactoryCapacityPoolViewSchema.parse(value);
      if (route === "create") { const original = CreateFactoryCapacityPoolSchema.parse(body);
        if (row.versionNumber !== 1 || row.factoryVersionId !== Id.parse(original.factoryVersionId) || row.code !== original.code || row.timeZone !== original.timeZone || row.unit !== original.unit || canonicalJson(row.profile) !== canonicalProfile(original.profile)) return failure(502);
      } else { const original = ReviseFactoryCapacityPoolSchema.parse(body);
        if (row.id !== pool || row.versionNumber !== original.expectedVersion + 1 || canonicalJson(row.profile) !== canonicalProfile(original.profile)) return failure(502);
      }
    } else if (route === "history") { if (FactoryCapacityHistorySchema.parse(value).poolId !== pool) return failure(502); }
    else if (route === "resolve") { const row = ResolvedFactoryLocalTimeSchema.parse(value), original = ResolveFactoryLocalTimeInputSchema.parse(body);
      if (row.factoryVersionId !== Id.parse(original.factoryVersionId) || row.localDateTime !== original.localDateTime) return failure(502);
    } else if (route === "preview") {
      const row = FactoryCapacityPreviewSchema.parse(value), original = FactoryCapacityPreviewInputSchema.parse(body);
      if (row.items.length !== original.items.length || new Set(row.items.map(item => item.reference)).size !== row.items.length || row.items.some(item => {
        const input = original.items.find(source => source.reference === item.reference);
        return !input || input.quantity !== item.quantity || input.expectedCompletionAt !== item.expectedCompletionAt
          || new Set(item.allocations.map(allocation => allocation.selection.poolId)).size !== item.allocations.length
          || row.canReserve && item.allocations.length !== input.capacityPlan.allocations.length
          || item.allocations.some(allocation => !input.capacityPlan.allocations.some(selection => canonicalJson({ ...selection, poolId: Id.parse(selection.poolId), poolVersionId: Id.parse(selection.poolVersionId) }) === canonicalJson(allocation.selection))
            || allocation.day.poolId !== allocation.selection.poolId || allocation.day.poolVersionId !== allocation.selection.poolVersionId || allocation.day.localDate !== allocation.selection.localDate
            || allocation.requestedUnits !== input.quantity * allocation.unitsPerItem);
      })) return failure(502);
    } else if (ProductionCapacityViewSchema.parse(value).productionOrderId !== production) return failure(502);
    await assertErpIdentityCurrent(identity);
    return Response.json(value, { status: method === "POST" && ["create", "revise"].includes(route) ? 201 : 200, headers });
  } catch (error) { return error instanceof PersonalSessionError ? erpAuthFailure(error, request) : failure(502); }
}
function canonicalProfile(profile: ReturnType<typeof CreateFactoryCapacityPoolSchema.parse>["profile"]) {
  return canonicalJson({ ...profile, bindings: profile.bindings.map(binding => ({ ...binding, capabilityVersionId: Id.parse(binding.capabilityVersionId) })) });
}
function failure(status: number, code?: "authority_changed") {
  const message = code ? "当前身份或权限范围已变化 请重新核对"
    : status === 401 ? "请登录自己的运营账户" : status === 403 ? "当前账户没有此工厂产能权限" : status === 404 ? "工厂或产能记录当前不可访问"
      : status === 409 ? "固定版本 产能余额或当地时间已变化 请核对原提交" : [400, 413, 415, 422].includes(status) ? "请核对完整产能字段 工厂当地时间与工作规则"
        : "产能服务结果暂时无法确认 请保留原填写后核对";
  return Response.json({ message, ...(code ? { code } : {}) }, { status, headers });
}
