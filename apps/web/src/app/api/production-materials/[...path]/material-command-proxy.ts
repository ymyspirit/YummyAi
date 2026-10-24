import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { RecordProductionMaterialSchema } from "@yummyai/contracts/order/material-execution";
import { MaterialCommandListSchema, MaterialCommandViewSchema } from "@yummyai/contracts/order/material-command";
import { compareStockQuantity } from "@yummyai/contracts/inventory/quantity";
import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";

const Id = EntityIdSchema.transform(value => value.toLowerCase());
const Empty = z.object({}).strict();
const actions = new Set(["execute", "cancel", "acknowledge"]);
export async function proxyMaterialCommand(request: Request, path: string[], method: "GET" | "POST") {
  const production = Id.safeParse(path[0]), commandId = path.length >= 3 ? Id.safeParse(path[2]) : null;
  const valid = production.success && path[1] === "commands" && (method === "GET" ? path.length === 2 || path.length === 3 && commandId?.success :
    path.length === 2 || path.length === 4 && commandId?.success && actions.has(path[3]!));
  if (!valid || !production.success) return failure(404);
  if (new URL(request.url).searchParams.size) return failure(400);
  let body: unknown, input: ReturnType<typeof RecordProductionMaterialSchema.parse> | undefined;
  if (method === "POST") {
    if (!isSameOriginRequest(request) || !request.headers.get("content-type")?.startsWith("application/json")) return failure(403);
    const reader = request.body?.getReader(); if (!reader) return failure(400);
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.byteLength; if (length > 16_384) { await reader.cancel(); return failure(413); } chunks.push(next.value);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (path.length === 2) { input = RecordProductionMaterialSchema.parse(value); body = input; }
      else body = Empty.parse(value);
    } catch { return failure(400); }
  }
  const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
  const suffix = commandId?.success ? "/" + commandId.data + (path[3] ? "/" + path[3] : "") : "";
  try {
    const response = await apiFetch(`${base}/v1/production-orders/${production.data}/materials/commands${suffix}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      signal: method === "GET" ? AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(45_000),
    });
    if (!response.ok) {
      const error = [400, 409, 422].includes(response.status) ? await response.json().catch(() => null) : null;
      return failure(response.status, typeof error?.message === "string" && error.message.length < 400 ? error.message : undefined,
        error?.code === "authority_changed" ? "authority_changed" : undefined);
    }
    const raw = await response.json();
    if (method === "GET" && path.length === 2) {
      const parsed = MaterialCommandListSchema.safeParse(raw);
      if (!parsed.success || parsed.data.items.some(row => row.productionOrderId !== production.data || row.contextAuthority !== parsed.data.contextAuthority || row.acknowledged)) return failure(502);
      return success(parsed.data, response.status);
    }
    const parsed = MaterialCommandViewSchema.safeParse(raw); if (!parsed.success) return failure(502);
    const row = parsed.data;
    if (row.productionOrderId !== production.data || commandId?.success && row.id !== commandId.data) return failure(502);
    if (input) {
      if (row.bindingId !== input.bindingId || row.requestKey !== input.idempotencyKey || row.input && canonicalJson(row.input) !== canonicalJson(input)) return failure(502);
      if (row.receipt && (row.receipt.kind !== input.kind || row.receipt.idempotencyKey !== input.idempotencyKey ||
        "quantity" in input && compareStockQuantity(row.receipt.quantity, input.quantity) !== 0)) return failure(502);
    }
    if (path[3] && row.status === "prepared" || path[3] === "acknowledge" && !row.acknowledged) return failure(502);
    return success(row, response.status);
  } catch { return failure(502); }
}
function success(value: unknown, status: number) {
  return Response.json(value, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
}
function failure(status: number, message?: string, code?: string) {
  return Response.json({ code: code ?? (status >= 500 ? "material_result_unconfirmed" : undefined), message: message ??
    (status === 401 ? "登录已失效 请重新登录" : status === 403 ? "当前账号没有原物料提交的操作权限" : status === 404 ? "本人的原物料提交不存在" :
      status === 400 ? "请保留原物料提交编号及填写 核对操作参数" : "物料提交结果暂时无法确认 请重新核对原记录") },
  { status, headers: { "cache-control": "private, no-store" } });
}
