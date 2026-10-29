import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
import { OrderReviewQuerySchema } from "@yummyai/contracts/order/review";
import {OrderDesignAgentReadQuerySchema} from "@yummyai/contracts/order/design-agent";
import { OrderLineProductionAvailabilitySchema, OrderWorkDetailViewSchema } from "@yummyai/contracts/order/workspace";
import { ShipmentCreateWorkspaceSchema } from "@yummyai/contracts/order/shipment";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { authorize } from "@yummyai/authz/authorize";
import { Permission } from "@yummyai/authz/permissions";
import { assertErpIdentityCurrent, erpAuthFailure, erpRequestIdentity } from "../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../identity/core";
import { CreateProductionOrderInputSchema } from "@yummyai/contracts/order/production";
import { NativeProductionQuerySchema, NativeProductionSourceQuerySchema, NativeProductionFactoryQuerySchema,
  NativeProductionWorkspaceSchema, NativeProductionDetailSchema, NativeProductionReceiptSchema } from "@yummyai/contracts/order/native-production";
import { ProductionFactoryChoiceSchema } from "@yummyai/contracts/suppliers/factory-directory";
import { createHash } from "node:crypto";
import { FulfillmentCommandListSchema, FulfillmentCommandQuerySchema, FulfillmentCommandViewSchema, PrepareFulfillmentCommandSchema, fulfillmentCommandCanonicalJson } from "@yummyai/contracts/order/fulfillment-command";
import { PrepareProductionCommandSchema, ProductionCommandListSchema, ProductionCommandQuerySchema, ProductionCommandViewSchema } from "@yummyai/contracts/order/production-command";
import {
  OrderTaskInboxQuerySchema,
  OrderTaskInboxViewSchema,
} from "@yummyai/contracts/order/task-inbox";
import {
  OrderLineResponsibilityInputSchema,
  OrderLineResponsibilityViewSchema,
} from "@yummyai/contracts/order/responsibility";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
const id = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const getPath = new RegExp(
  `^(workspace|tasks|review|options|profiles|production/${id}/quality-groups|orders/${id}/(fulfillment|shipos-evidence)|shipments/${id}/source-editor|deliveries(/${id}(/file)?)?|lines/${id}(/review|/order-detail|/operations|/template-plan|/manufacturing|/production-availability|/design-agent|/images/${id}|/artwork-materials/${id}|/revisions/${id}|/report-images/[0-9]{1,2}|/source-files/[a-z0-9_-]{1,200})?)$`,
  "i",
);
const postPath = new RegExp(
  `^(selection|summaries|bulk/preview|profiles|quality-standards|recoveries|orders/${id}/(release|shipments|production-progress|quality-pass)|deliveries(/${id}/items/${id}/feedback)?|lines/${id}/(draft|actions|archive|images|release|shipments|cases|intake-check|platform-deadline|design-agent/(resume|takeover|restore-response))|production/${id}/(milestones|inspections|quality-groups)|shipments/${id}/(versions|review|dispatch|tracking|platform-confirmation)|cases/${id}/(decisions|contacts|complete))$`,
  "i",
);
type Context = { params: Promise<{ path: string[] }> };
export async function GET(request: Request, context: Context) {
  return proxy(request, context, "GET");
}
export async function POST(request: Request, context: Context) {
  return proxy(request, context, "POST");
}
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const { path } = await context.params,
    target = path.join("/");
  if (new RegExp(`^fulfillment-commands(/${id}(/(execute|cancel|acknowledge))?)?$`, "i").test(target))
    return personalFulfillmentCommand(request, path, method);
  if (method === "GET" && new RegExp(`^orders/${id}/shipment-create-workspace$`, "i").test(target))
    return personalShipmentCreateWorkspace(request, path[1]!);
  const taskRead = method === "GET" && new RegExp(`^lines/${id}/task$`, "i").test(target);
  const nativeRead = method === "GET" && (target === "native" || new RegExp(`^native/lines/${id}(/factories)?$`, "i").test(target));
  const nativeWrite = method === "POST" && new RegExp(`^native/orders/${id}/production$`, "i").test(target);
  const commandRead = method === "GET" && new RegExp(`^production-commands(/${id})?$`, "i").test(target);
  const commandWrite = method === "POST" && new RegExp(`^production-commands(/${id}/(execute|acknowledge|cancel))?$`, "i").test(target);
  const responsibility = new RegExp(`^lines/${id}/responsibility$`, "i").test(target);
  const taskWrite =
    method === "POST" && new RegExp(`^lines/${id}/task/prepare-delivery$`, "i").test(target);
  const factoryRead =
    method === "GET" &&
    path.length === 3 &&
    path[0] === "lines" &&
    path[2] === "factories" &&
    new RegExp(`^${id}$`, "i").test(path[1]!);
  if (
    !nativeRead && !nativeWrite && !commandRead && !commandWrite && !responsibility &&
    !taskRead &&
    !taskWrite &&
    !factoryRead &&
    !(method === "GET" ? getPath : postPath).test(target)
  )
    return failure(404);
  const sourceFile = method === "GET" && path[2] === "source-files";
  const params = new URL(request.url).searchParams;
  if (method === "GET" && path.length === 2 && path[0] === "lines" && request.headers.has("x-yummyai-context-authority"))
    return personalOrderDetail(request, path[1]!);
  if (commandRead || commandWrite) {
    if (commandRead && path.length === 1) {
      if ([...params.keys()].some(key => params.getAll(key).length !== 1) || !ProductionCommandQuerySchema.safeParse(Object.fromEntries(params)).success) return failure(400);
    } else if (params.size) return failure(400);
  }
  if (nativeWrite && params.size) return failure(400);
  if (nativeRead && ([...params.keys()].some(key => params.getAll(key).length !== 1) ||
    !(target === "native" ? NativeProductionQuerySchema : path[3] === "factories" ? NativeProductionFactoryQuerySchema : NativeProductionSourceQuerySchema).safeParse(Object.fromEntries(params)).success)) return failure(400);
  if (path[2] === "production-availability" && params.size) return failure(400);
  if (path[2] === "manufacturing" && (params.has("originalProductionOrderId") && params.has("nativeSpecificationVersionId") || [...params.keys()].some(key => !["originalProductionOrderId", "nativeSpecificationVersionId", "after"].includes(key) || params.getAll(key).length !== 1 || !new RegExp(`^${id}$`, "i").test(params.get(key)!)))) return failure(400);
  if ((path[0] === "shipments" || path[0] === "production") && params.size) return failure(400);
  const agentRead=method==="GET"&&path.length===3&&path[0]==="lines"&&path[2]==="design-agent";
  if(agentRead&&([...params.keys()].some(key=>params.getAll(key).length!==1)||!OrderDesignAgentReadQuerySchema.safeParse(Object.fromEntries(params)).success))return failure(400);
  if(path[2]==="design-agent"&&!agentRead&&params.size)return failure(400);
  if (
    target === "tasks" &&
    ([...params.keys()].some((key) => params.getAll(key).length !== 1) ||
      !OrderTaskInboxQuerySchema.safeParse(Object.fromEntries(params)).success)
  )
    return failure(400);
  if (
    responsibility &&
    (method === "POST"
      ? params.size > 0
      : [...params.keys()].some((key) => key !== "q") ||
        params.getAll("q").length > 1 ||
        (params.get("q") ?? "").length > 100)
  )
    return failure(400);
  if ((taskRead || taskWrite) && params.size) return failure(400);
  if ((path[0] === "orders" || path[2] === "order-detail" || path[2] === "review") && params.size)
    return failure(400);
  if (
    target === "review" &&
    ([...params.keys()].some((key) => params.getAll(key).length !== 1) ||
      !OrderReviewQuerySchema.safeParse(Object.fromEntries(params)).success)
  )
    return failure(400);
  if (
    factoryRead &&
    ([...params.keys()].some((key) => !["renderId", "quantity"].includes(key) || params.getAll(key).length !== 1) ||
      params.getAll("renderId").length !== 1 ||
      params.has("quantity") && (!/^[1-9][0-9]{0,5}$/.test(params.get("quantity")!) || Number(params.get("quantity")) > 100000) ||
      !new RegExp(`^${id}$`, "i").test(params.get("renderId") ?? ""))
  )
    return failure(400);
  if (
    path[0] === "deliveries" &&
    ([...params.keys()].some(
      (key) =>
        target !== "deliveries" ||
        !["order", "line", "supplier", "factory", "dueBefore"].includes(key),
    ) ||
      ["order", "line", "supplier", "factory", "dueBefore"].some(
        (key) => params.getAll(key).length > 1,
      ) ||
      ["order", "line", "supplier", "factory"].some(
        (key) => params.has(key) && !new RegExp(`^${id}$`, "i").test(params.get(key)!),
      ) ||
      (params.has("dueBefore") &&
        (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(params.get("dueBefore")!) ||
          !Number.isFinite(new Date(params.get("dueBefore")!).getTime()))))
  )
    return failure(400);
  if (
    sourceFile &&
    (params.getAll("revision").length !== 1 ||
      params.getAll("attempt").length > 1 ||
      [...params.keys()].some((key) => !["revision", "attempt"].includes(key)) ||
      !/^[1-9][0-9]{0,9}$/.test(params.get("revision") ?? "") ||
      Number(params.get("revision")) > 2147483647 ||
      (params.has("attempt") &&
        (!/^(0|[1-9][0-9]{0,9})$/.test(params.get("attempt")!) ||
          Number(params.get("attempt")) > 2147483647)))
  )
    return failure(400);
  if (
    method === "POST" &&
    (!isSameOriginRequest(request) ||
      !request.headers.get("content-type")?.startsWith("application/json"))
  )
    return failure(403);
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return failure(503);
  let body: string | undefined;
  if (method === "POST") {
    const limit =
      path[2] === "images"
        ? 46 * 1024 * 1024
        : path[2] === "design-agent" && path[3] === "restore-response"
          ? 28 * 1024 * 1024
          : 1024 * 1024;
    const reader = request.body?.getReader();
    if (!reader) return failure(400);
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        return failure(413);
      }
      chunks.push(next.value);
    }
    body = Buffer.concat(chunks).toString("utf8");
    try {
      const value = JSON.parse(body);
      if (commandWrite && (path.length === 1 ? !PrepareProductionCommandSchema.safeParse(value).success
        : !value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 0)) return failure(400);
      if (nativeWrite && !CreateProductionOrderInputSchema.safeParse(value).success) return failure(400);
      if (responsibility && !OrderLineResponsibilityInputSchema.safeParse(value).success)
        return failure(400);
    } catch {
      return failure(400);
    }
  }
  try {
    const query =
      commandRead && path.length === 1 ? new URL(request.url).search : nativeRead ? new URL(request.url).search : responsibility && method === "GET"
        ? `?${new URLSearchParams({ q: params.get("q") ?? "" })}`
        : agentRead&&params.size
          ? `?${new URLSearchParams({view:params.get("view")!})}`
        : path[2] === "manufacturing"
          ? new URL(request.url).search
        : factoryRead
          ? `?${params.toString()}`
          : ["workspace", "tasks", "deliveries", "review"].includes(target)
            ? new URL(request.url).search
            : sourceFile
              ? `?revision=${params.get("revision")}`
              : "";
    const listRead = method === "GET" && ["workspace", "tasks", "options"].includes(target);
    const cancellableRead = listRead || (method === "POST" && target === "summaries");
    const timeout = AbortSignal.timeout(listRead ? 12_000 : 110_000);
    const response = await apiFetch(`${base}/v1/order-centers/${target}${query}`, {
      method,
      body,
      cache: "no-store",
      headers: body ? { "content-type": "application/json" } : undefined,
      signal: cancellableRead ? AbortSignal.any([request.signal, timeout]) : timeout,
    });
    if (!response.ok) {
      let message: string | undefined, code: string | undefined;
      if ([409, 422].includes(response.status)) {
        const error = await response.json().catch(() => null);
        if (typeof error?.message === "string" && error.message.length < 400)
          message = error.message;
        if (response.status === 409 && error?.code === "authority_changed") code = "authority_changed";
      }
      return failure(response.status, message, code);
    }
    const headers = new Headers({
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-type": response.headers.get("content-type") ?? "application/json",
    });
    if (commandRead || commandWrite) {
      const raw = await response.json();
      if (commandRead && path.length === 1) {
        const value = ProductionCommandListSchema.safeParse(raw);
        return value.success && value.data.items.every(item => item.orderId === params.get("orderId") &&
          (!params.has("lineId") || item.lineIds.includes(params.get("lineId")!))) ? Response.json(value.data, { headers }) : failure(502);
      }
      const value = ProductionCommandViewSchema.safeParse(raw);
      if (!value.success) return failure(502);
      if (path.length > 1 && value.data.id.toLowerCase() !== path[1]!.toLowerCase()) return failure(502);
      if (commandWrite && path.length === 1) {
        const command = PrepareProductionCommandSchema.parse(JSON.parse(body!));
        const lineIds = command.kind === "approved_design" ? [command.input.orderLineId] : command.kind === "reviewed_line" ? [command.targetId] : command.input.items.map(item => item.lineId);
        if (value.data.kind !== command.kind || (command.kind !== "reviewed_line" && value.data.orderId !== command.targetId) ||
          value.data.lineIds.length !== lineIds.length || !lineIds.every(lineId => value.data.lineIds.includes(lineId))) return failure(502);
      }
      return Response.json(value.data, { status: response.status, headers });
    }
    if (nativeRead) {
      const raw = await response.json();
      if (target === "native") { const value = NativeProductionWorkspaceSchema.safeParse(raw); return value.success ? Response.json(value.data, { headers }) : failure(502); }
      if (path[3] === "factories") { const value = ProductionFactoryChoiceSchema.array().safeParse(raw); return value.success ? Response.json(value.data, { headers }) : failure(502); }
      const value = NativeProductionDetailSchema.safeParse(raw);
      return value.success && value.data.line.id.toLowerCase() === path[2]!.toLowerCase() &&
        (value.data.source?.specificationVersionId ?? null) === params.get("specificationVersionId") ? Response.json(value.data, { headers }) : failure(502);
    }
    if (nativeWrite) {
      const value = NativeProductionReceiptSchema.safeParse(await response.json()), input = JSON.parse(body!);
      return value.success && value.data.orderId.toLowerCase() === path[2]!.toLowerCase() && value.data.lineId === input.orderLineId ? Response.json(value.data, { status: response.status, headers }) : failure(502);
    }
    if (responsibility) {
      const value = OrderLineResponsibilityViewSchema.safeParse(await response.json());
      return value.success ? Response.json(value.data, { headers }) : failure(502);
    }
    if (target === "tasks") {
      const value = OrderTaskInboxViewSchema.safeParse(await response.json());
      return value.success ? Response.json(value.data, { headers }) : failure(502);
    }
    if (path[2] === "production-availability") {
      const value = OrderLineProductionAvailabilitySchema.safeParse(await response.json());
      return value.success && value.data.lineId.toLowerCase() === path[1]!.toLowerCase() ? Response.json(value.data, { headers }) : failure(502);
    }
    if (
      (path[2] === "artwork-materials" ||
        sourceFile ||
        (path[0] === "deliveries" && path[2] === "file")) &&
      response.headers.has("content-disposition")
    )
      headers.set("content-disposition", response.headers.get("content-disposition")!);
    if (["images", "report-images", "source-files"].includes(path[2] ?? ""))
      headers.set("content-security-policy", "default-src 'none'; sandbox");
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return failure(502);
  }
}
const personalOrderHeaders = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
async function personalOrderBytes(response: Pick<Response, "body">, maximum: number): Promise<Buffer | null> {
  const reader = response.body?.getReader(); if (!reader) return null;
  const parts: Uint8Array[] = []; let size = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
    if (size > maximum) { await reader.cancel(); throw new Error("order_payload_limit"); } parts.push(next.value); }
    return Buffer.concat(parts);
  } finally { reader.releaseLock(); }
}
async function personalOrderJson(response: Pick<Response, "body">, maximum: number): Promise<unknown> {
  const bytes = await personalOrderBytes(response, maximum); if (!bytes) throw new Error("empty_order_payload");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function personalOrderFailure(status: number, code?: "authority_changed") {
  return Response.json({ message: code ? "当前身份或授权范围已变化 请重新核对本人权限" : status === 401 ? "请重新登录自己的运营账户" :
    status === 403 || status === 404 ? "当前无法读取这笔订单资料" : status === 400 ? "订单查询格式不正确" : "订单资料暂时无法核对 请稍后重新读取", ...(code ? { code } : {}) }, { status, headers: personalOrderHeaders });
}
/** New command paths require the caller's original identity stamp before and
 * after the exact owner request. Old operational route contracts stay intact. */
async function personalFulfillmentCommand(request: Request, path: string[], method: "GET" | "POST") {
  const params = new URL(request.url).searchParams, root = path.length === 1;
  if (method === "GET" && path.length > 2 || method === "POST" && path.length === 2) return personalOrderFailure(404);
  if (method === "GET" && root) {
    if ([...params.keys()].some(key => params.getAll(key).length !== 1) || !FulfillmentCommandQuerySchema.safeParse(Object.fromEntries(params)).success)
      return personalOrderFailure(400);
  } else if (params.size) return personalOrderFailure(400);
  if (method === "POST" && !isSameOriginRequest(request))
    return personalOrderFailure(403);
  try {
    const identity = await erpRequestIdentity(request), authority = erpSessionAuthority(identity.view);
    if (request.headers.get("x-yummyai-context-authority") !== authority) throw new PersonalSessionError(409, "authority_changed");
    try {
      authorize(identity.view, Permission.OrderRead); authorize(identity.view, Permission.OrderPiiRead);
      if (method === "POST" && path[2] !== "acknowledge") authorize(identity.view, Permission.OrderWrite);
    } catch { return personalOrderFailure(403); }
    let body: unknown;
    if (method === "POST") {
      try {
        // Next may expose a non-null stream for a zero-byte POST. Decide from
        // bounded bytes, while requiring JSON for every nonempty payload.
        const bytes = await personalOrderBytes(request, 8 * 1024 * 1024);
        if (root || bytes?.byteLength) {
          if (!request.headers.get("content-type")?.startsWith("application/json")) return personalOrderFailure(403);
          body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes ?? new Uint8Array()));
        } else body = {};
      } catch { return personalOrderFailure(400); }
      if (root ? !PrepareFulfillmentCommandSchema.safeParse(body).success : !body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)
        return personalOrderFailure(400);
    }
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return personalOrderFailure(503);
    const response = await apiFetch(`${base}/v1/order-centers/${path.join("/")}${root && method === "GET" ? new URL(request.url).search : ""}`, {
      method, ...(method === "POST" ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
      cache: "no-store", redirect: "error", signal: method === "GET" ? AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(110_000),
    });
    if (!response.ok) {
      await response.body?.cancel(); await assertErpIdentityCurrent(identity);
      return personalOrderFailure([400, 401, 403, 404, 409, 413, 422, 503].includes(response.status) ? response.status : 502);
    }
    const raw = await personalOrderJson(response, 4 * 1024 * 1024);
    const headers = { ...personalOrderHeaders, "x-yummyai-context-authority": authority };
    if (method === "GET" && root) {
      const value = FulfillmentCommandListSchema.parse(raw);
      if (value.items.some(item => item.orderId !== params.get("orderId") || params.has("lineId") && !item.lineIds.includes(params.get("lineId")!) ||
        params.has("requestId") && (item.requestId !== params.get("requestId") || item.requestChecksum !== params.get("requestChecksum")))) return personalOrderFailure(502);
      await assertErpIdentityCurrent(identity); return Response.json(value, { headers });
    }
    const value = FulfillmentCommandViewSchema.parse(raw);
    if (!root && value.id.toLowerCase() !== path[1]!.toLowerCase()) return personalOrderFailure(502);
    if (root) {
      const command = PrepareFulfillmentCommandSchema.parse(body);
      if (value.kind !== command.kind || value.targetId !== command.targetId || value.requestId !== command.requestId ||
        value.requestChecksum !== createHash("sha256").update(fulfillmentCommandCanonicalJson(command)).digest("hex")) return personalOrderFailure(502);
    }
    await assertErpIdentityCurrent(identity);
    return Response.json(value, { status: response.status, headers });
  } catch (cause) { return cause instanceof PersonalSessionError ? erpAuthFailure(cause, request) : personalOrderFailure(502); }
}
/** Optional stamped read for AI entry points; existing operational commands retain their ABI. */
async function personalOrderDetail(request: Request, lineId: string) {
  if (new URL(request.url).searchParams.size) return personalOrderFailure(400);
  try {
    const identity = await erpRequestIdentity(request), authority = erpSessionAuthority(identity.view);
    if (request.headers.get("x-yummyai-context-authority") !== authority) throw new PersonalSessionError(409, "authority_changed");
    try { authorize(identity.view, Permission.OrderRead); authorize(identity.view, Permission.OrderPiiRead); } catch { return personalOrderFailure(403); }
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return personalOrderFailure(503);
    const response = await apiFetch(`${base}/v1/order-centers/lines/${lineId.toLowerCase()}`, { cache: "no-store", redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]) });
    if (!response.ok) {
      const raw = response.status === 409 ? await personalOrderJson(response, 8192).catch(() => null) : null;
      if (!response.bodyUsed) await response.body?.cancel();
      await assertErpIdentityCurrent(identity);
      return personalOrderFailure([400, 401, 403, 404, 409, 422, 503].includes(response.status) ? response.status : 502,
        response.status === 409 && raw && typeof raw === "object" && "code" in raw && raw.code === "authority_changed" ? "authority_changed" : undefined);
    }
    if (response.status !== 200) { await response.body?.cancel(); return personalOrderFailure(502); }
    const value = OrderWorkDetailViewSchema.strict().parse(await personalOrderJson(response, 8 * 1024 * 1024));
    if (value.line.id.toLowerCase() !== lineId.toLowerCase()) return personalOrderFailure(502);
    await assertErpIdentityCurrent(identity);
    return Response.json(value, { headers: { ...personalOrderHeaders, "x-yummyai-context-authority": authority } });
  } catch (cause) { return cause instanceof PersonalSessionError ? erpAuthFailure(cause, request) : personalOrderFailure(502); }
}
/** Complete original packing basis, bounded and bound to the current person. */
async function personalShipmentCreateWorkspace(request: Request, orderId: string) {
  if (new URL(request.url).searchParams.size) return personalOrderFailure(400);
  try {
    const identity = await erpRequestIdentity(request), authority = erpSessionAuthority(identity.view);
    if (request.headers.get("x-yummyai-context-authority") !== authority) throw new PersonalSessionError(409, "authority_changed");
    try { authorize(identity.view, Permission.OrderRead); authorize(identity.view, Permission.OrderPiiRead); } catch { return personalOrderFailure(403); }
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return personalOrderFailure(503);
    const response = await apiFetch(`${base}/v1/orders/${orderId.toLowerCase()}/shipment-create-workspace`, {
      cache: "no-store", redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel(); await assertErpIdentityCurrent(identity);
      return personalOrderFailure([400, 401, 403, 404, 409, 413, 422, 503].includes(response.status) ? response.status : 502);
    }
    if (response.status !== 200) { await response.body?.cancel(); return personalOrderFailure(502); }
    const value = ShipmentCreateWorkspaceSchema.parse(await personalOrderJson(response, 4 * 1024 * 1024));
    if (value.orderId.toLowerCase() !== orderId.toLowerCase()) return personalOrderFailure(502);
    if (value.contextAuthority !== authority) throw new PersonalSessionError(409, "authority_changed");
    await assertErpIdentityCurrent(identity);
    return Response.json(value, { headers: { ...personalOrderHeaders, "x-yummyai-context-authority": authority } });
  } catch (cause) { return cause instanceof PersonalSessionError ? erpAuthFailure(cause, request) : personalOrderFailure(502); }
}
function failure(status: number, message?: string, code?: string) {
  return Response.json(
    {
      ...(code === "authority_changed" ? { code } : {}),
      message:
        message ??
        (status === 401
          ? "登录已失效，请重新登录"
          : status === 403
            ? "当前账号没有此操作权限"
            : status === 413
              ? "文件过大"
              : status === 409
                ? "资料已更新，请刷新后重试"
                : [502, 503, 504].includes(status)
                  ? "订单服务暂时无法连接，请重试"
                  : "操作未完成，请检查输入或稍后重试"),
    },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}
