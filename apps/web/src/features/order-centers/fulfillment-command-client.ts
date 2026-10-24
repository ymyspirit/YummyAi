"use client";
import type { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import {
  FulfillmentCommandListSchema, FulfillmentCommandQuerySchema, FulfillmentCommandViewSchema,
  type FulfillmentCommandView,
} from "@yummyai/contracts/order/fulfillment-command";
import { OrderCenterRequestError } from "./order-center-model";
import {
  createFulfillmentCommandIntent, fulfillmentCommandMatches, fulfillmentCommandReceiptMatches,
  type FulfillmentCommandIntent, type FulfillmentCommandReference,
} from "./fulfillment-command-intent";

export type FulfillmentCommandReadOptions = { signal?: AbortSignal; isCurrent?(): boolean };
export class FulfillmentCommandRequestError extends OrderCenterRequestError {}
export const fulfillmentCommandDenied = (cause: unknown) => cause instanceof OrderCenterRequestError
  && ([401, 403, 404].includes(cause.status) || cause.code === "authority_changed");
export const fulfillmentCommandError = (cause: unknown) => cause instanceof FulfillmentCommandRequestError
  ? cause.message : "本次原提交尚未核对 请读取同单原记录 不重复发送";
function errorText(status: number, changed = false) {
  return changed ? "当前本人身份或授权范围已变化 原履约资料已隐藏 请重新核对当前权限"
    : status === 401 ? "请重新登录自己的运营账户"
      : status === 403 || status === 404 ? "当前无法读取或处理这笔原履约提交 请核对原订单权限"
        : status === 400 || status === 422 ? "本次原填写未通过核对 请检查原对象 版本与实际记录"
          : status === 409 ? "原依据或请求正在变化 请先只读原提交 不换键或重复发送"
            : "本次响应尚未核对 原提交可能已保存 请只读取同单原记录";
}
function current(options: FulfillmentCommandReadOptions) {
  if (options.isCurrent && !options.isCurrent()) throw new FulfillmentCommandRequestError(409, errorText(409, true), "authority_changed");
}
const id = (value: string) => EntityIdSchema.parse(value.toLowerCase());
async function request<T>(path: string, method: "GET" | "POST", schema: z.ZodType<T>, status: number,
  authority: string, options: FulfillmentCommandReadOptions, body?: unknown): Promise<T> {
  if (!authority) throw new FulfillmentCommandRequestError(401, errorText(401));
  current(options);
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(30_000)]);
  let response: Response;
  try {
    response = await fetch("/api/order-centers/fulfillment-commands" + path, { method, signal, credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { "x-yummyai-context-authority": authority, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch { current(options); throw new FulfillmentCommandRequestError(0, errorText(0)); }
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
  if (!reader) throw new FulfillmentCommandRequestError(response.ok ? 502 : response.status, errorText(response.ok ? 502 : response.status));
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
      if (size > (response.ok ? 8 * 1024 * 1024 : 8192)) { await reader.cancel(); throw new Error("size"); }
      chunks.push(next.value); }
  } catch { current(options); throw new FulfillmentCommandRequestError(response.ok ? 502 : response.status, errorText(response.ok ? 502 : response.status)); }
  finally { reader.releaseLock(); }
  current(options);
  let raw: unknown;
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error("type");
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new FulfillmentCommandRequestError(response.ok ? 502 : response.status, errorText(response.ok ? 502 : response.status)); }
  if (!response.ok) {
    const changed = response.status === 409 && raw !== null && typeof raw === "object" && "code" in raw && raw.code === "authority_changed";
    throw new FulfillmentCommandRequestError(response.status, errorText(response.status, changed), changed ? "authority_changed" : null);
  }
  const parsed = schema.safeParse(raw);
  if (response.status !== status || !parsed.success) throw new FulfillmentCommandRequestError(502, "原履约响应结构或状态无法核对 请读取原提交");
  if (response.headers.get("x-yummyai-context-authority") !== authority)
    throw new FulfillmentCommandRequestError(409, errorText(409, true), "authority_changed");
  current(options); return parsed.data;
}

export async function readFulfillmentCommands(raw: unknown, authority: string, options: FulfillmentCommandReadOptions = {}) {
  const query = FulfillmentCommandQuerySchema.parse(raw), parameters = new URLSearchParams({ orderId: query.orderId });
  if (query.lineId) parameters.set("lineId", query.lineId);
  if (query.requestId && query.requestChecksum) { parameters.set("requestId", query.requestId); parameters.set("requestChecksum", query.requestChecksum); }
  const value = await request("?" + parameters, "GET", FulfillmentCommandListSchema, 200, authority, options);
  const seen = new Set<string>(), requests = new Set<string>();
  for (const item of value.items) {
    if (item.orderId !== query.orderId || query.lineId && !item.lineIds.includes(query.lineId)
      || query.requestId && (item.requestId !== query.requestId || item.requestChecksum !== query.requestChecksum)
      || seen.has(item.id) || requests.has(item.requestId) || new Set(item.lineIds).size !== item.lineIds.length)
      throw new FulfillmentCommandRequestError(502, "原提交目录与本单或原请求不一致 未采用其他订单记录");
    seen.add(item.id); requests.add(item.requestId);
  }
  return value;
}
export async function readFulfillmentCommand(commandId: string, orderId: string, authority: string, options: FulfillmentCommandReadOptions = {}) {
  const expected = id(commandId), value = await request("/" + expected, "GET", FulfillmentCommandViewSchema, 200, authority, options);
  if (value.id !== expected || value.orderId !== id(orderId) || new Set(value.lineIds).size !== value.lineIds.length)
    throw new FulfillmentCommandRequestError(502, "原回执不属于本次同单提交");
  return value;
}
export async function prepareFulfillmentCommand(intent: FulfillmentCommandIntent, authority: string, options: FulfillmentCommandReadOptions = {}) {
  const normalized = await createFulfillmentCommandIntent(intent.orderId, intent.command);
  current(options);
  if (normalized.requestChecksum !== intent.requestChecksum) throw new FulfillmentCommandRequestError(400, "原填写与请求摘要已经变化 本次未保存替代提交");
  const value = await request("", "POST", FulfillmentCommandViewSchema, 201, authority, options, normalized.command);
  if (!fulfillmentCommandMatches(value, normalized) || value.status === "succeeded" && !fulfillmentCommandReceiptMatches(value, normalized.command))
    throw new FulfillmentCommandRequestError(502, "原提交未绑定本次原对象 完整填写与请求摘要 请只读原记录");
  return value;
}
export async function actOnFulfillmentCommand(original: FulfillmentCommandView, action: "execute" | "cancel" | "acknowledge", authority: string,
  options: FulfillmentCommandReadOptions = {}, intent?: FulfillmentCommandIntent) {
  const value = await request("/" + id(original.id) + "/" + action, "POST", FulfillmentCommandViewSchema, 200, authority, options);
  if (value.id !== original.id || value.orderId !== original.orderId || value.requestId !== original.requestId
    || value.requestChecksum !== original.requestChecksum || value.kind !== original.kind || value.targetId !== original.targetId
    || value.lineIds.length !== original.lineIds.length || new Set(value.lineIds).size !== value.lineIds.length || !value.lineIds.every(line => original.lineIds.includes(line))
    || intent && (!fulfillmentCommandMatches(value, intent) || value.status === "succeeded" && !fulfillmentCommandReceiptMatches(value, intent.command)))
    throw new FulfillmentCommandRequestError(502, "处理回执与这笔原履约提交不一致 请只读原记录");
  if (action === "acknowledge" && (!value.acknowledged || value.status !== "acknowledged" || value.summary !== null || value.receipt !== null))
    throw new FulfillmentCommandRequestError(502, "原结果确认与私有副本清理尚未核对 请只读原记录");
  return value;
}
export function fulfillmentCommandReference(value: FulfillmentCommandView): FulfillmentCommandReference {
  return { orderId: value.orderId, requestId: value.requestId, requestChecksum: value.requestChecksum, id: value.id };
}
