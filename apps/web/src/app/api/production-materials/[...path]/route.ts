import { ProductionMaterialsQuerySchema, ProductionMaterialsWorkspaceSchema, ProductionMaterialReceiptSchema,
  ProductionMaterialRecordResultSchema, ProductionMaterialRequestKeySchema, RecordProductionMaterialSchema } from "@yummyai/contracts/order/material-execution";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { compareStockQuantity } from "@yummyai/contracts/inventory/quantity";
import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
import { proxyMaterialCommand } from "./material-command-proxy";
import { proxyMaterialOptions, proxyMaterialEntry } from "./material-options-proxy";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
export const GET = (request: Request, context: Context) => proxy(request, context, "GET");
export const POST = (request: Request, context: Context) => proxy(request, context, "POST");
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const path = (await context.params).path;
  if (path[1] === "commands") return proxyMaterialCommand(request, path, method);
  if (path[1] === "stock-options" || path[1] === "reservation-options") return proxyMaterialOptions(request, path, method);
  if (path[1] === "entries") return proxyMaterialEntry(request, path, method);
  const productionId = EntityIdSchema.transform(value => value.toLowerCase()).safeParse(path[0]);
  const receipt = path.length === 3 && path[1] === "receipts" && ProductionMaterialRequestKeySchema.safeParse(path[2]).success;
  if (!productionId.success || !(path.length === 1 || method === "GET" && receipt)) return failure(404);
  const url = new URL(request.url);
  if (method === "POST" || receipt) { if (url.searchParams.size) return failure(400); }
  else if ([...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1) ||
    !ProductionMaterialsQuerySchema.safeParse(Object.fromEntries(url.searchParams)).success) return failure(400);
  let command: ReturnType<typeof RecordProductionMaterialSchema.parse> | undefined;
  if (method === "POST") {
    if (!isSameOriginRequest(request) || !request.headers.get("content-type")?.startsWith("application/json")) return failure(403);
    const reader = request.body?.getReader(); if (!reader) return failure(400);
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength; if (length > 16_384) { await reader.cancel(); return failure(413); } chunks.push(next.value);
    }
    try { command = RecordProductionMaterialSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { return failure(400); }
  }
  const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
  try {
    const response = await apiFetch(`${base}/v1/production-orders/${productionId.data}/materials${receipt ? "/receipts/" + encodeURIComponent(path[2]!) : ""}${url.search}`, {
      method, body: command ? JSON.stringify(command) : undefined, cache: "no-store",
      headers: command ? { "content-type": "application/json" } : undefined,
      signal: method === "GET" ? AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(45_000),
    });
    if (!response.ok) {
      const value = [400, 409, 422].includes(response.status) ? await response.json().catch(() => null) : null;
      return failure(response.status, typeof value?.message === "string" && value.message.length <= 400 ? value.message : undefined,
        value?.code === "authority_changed" ? "authority_changed" : undefined);
    }
    const raw = await response.json();
    const parsed = command ? ProductionMaterialRecordResultSchema.safeParse(raw) : receipt ? ProductionMaterialReceiptSchema.safeParse(raw) : ProductionMaterialsWorkspaceSchema.safeParse(raw);
    if (!parsed.success) return failure(502);
    if (command) {
      const value = ProductionMaterialRecordResultSchema.parse(parsed.data), entry = value.entry;
      if (entry.productionOrderId !== productionId.data || entry.bindingId !== command.bindingId || entry.materialCode !== command.materialCode ||
        entry.kind !== command.kind || entry.idempotencyKey !== command.idempotencyKey) return failure(502);
      if ("quantity" in command && compareStockQuantity(entry.quantity, command.quantity) !== 0 ||
        Date.parse(entry.occurredAt) !== Date.parse(command.occurredAt) || entry.reason !== command.reason ||
        "originalEntryId" in command && entry.originalEntryId !== command.originalEntryId ||
        command.kind === "consume" && entry.originalEntryId !== command.reservationEntryId ||
        "locationId" in command && (entry.locationId !== command.locationId || entry.lotId !== command.lotId) ||
        command.kind === "factory_report" && entry.reportReference !== command.reportReference) return failure(502);
    } else if (receipt) {
      const value = ProductionMaterialReceiptSchema.parse(parsed.data);
      if (value.productionOrderId !== productionId.data || value.idempotencyKey !== path[2]) return failure(502);
    } else {
      const value = ProductionMaterialsWorkspaceSchema.parse(parsed.data);
      if (value.productionOrderId !== productionId.data || url.searchParams.has("bindingId") && value.bindingId !== url.searchParams.get("bindingId")!.toLowerCase() ||
        value.entries.some(entry => entry.productionOrderId !== productionId.data || entry.bindingId !== value.bindingId)) return failure(502);
    }
    return Response.json(parsed.data, { status: response.status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
  } catch { return failure(502); }
}
function failure(status: number, message?: string, code?: string) {
  return Response.json({ code: code ?? (status >= 500 ? "material_result_unconfirmed" : undefined), message: message ??
    (status === 401 ? "登录已失效 请重新登录" : status === 403 ? "当前账号没有本生产物料的操作权限" : status === 400 ? "请核对本次物料填写与原生产依据" :
      status === 404 ? "尚未找到原生产物料记录" : status === 413 ? "物料记录内容过长" : "物料服务暂时无法确认 请保留原请求编号核对结果") },
  { status, headers: { "cache-control": "private, no-store" } });
}
