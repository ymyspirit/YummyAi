"use client";

import type { z } from "zod";
import {
  AGENT_FULFILLMENT_COMMAND_VERSION, AgentFulfillmentCommandWorkspaceSchema, AgentFulfillmentCommandViewSchema,
  AgentFulfillmentCommandListSchema, AgentFulfillmentCommandListQuerySchema, AgentFulfillmentCommandGetQuerySchema,
  AgentFulfillmentCommandReceiptSchema, AgentFulfillmentCommandReceiptQuerySchema, PrepareAgentFulfillmentCommandSchema,
  ConfirmAgentFulfillmentCommandSchema, CancelAgentFulfillmentCommandSchema, AcknowledgeAgentFulfillmentCommandSchema,
  canonicalAgentFulfillmentOriginal, type AgentFulfillmentCommandView, type PrepareAgentFulfillmentCommand,
} from "@yummyai/contracts/ai/agent-fulfillment-command";
import { agentTransportTextHash } from "@yummyai/contracts/ai/agent-transport";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { normalizeFulfillmentCommand } from "@yummyai/contracts/order/fulfillment-command";
import { fulfillmentCommandReceiptMatches } from "../order-centers/fulfillment-command-intent";

export type AgentFulfillmentReadOptions = { signal?: AbortSignal; isCurrent?(): boolean };
export class AgentFulfillmentCommandRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: "authority_changed" | null = null) { super(message); }
}
export const agentFulfillmentCommandDenied = (failure: unknown) => failure instanceof AgentFulfillmentCommandRequestError
  && ([401, 403, 404].includes(failure.status) || failure.code === "authority_changed");
export const agentFulfillmentCommandError = (failure: unknown) => failure instanceof AgentFulfillmentCommandRequestError
  ? failure.message : "本次原履约响应尚不可核对 请只读取原请求 不重复提交";
const invalid = () => new AgentFulfillmentCommandRequestError(502, "原履约编号 正文或回执无法核对 未采用替代记录");
const failureText = (status: number, changed = false) => changed ? "当前本人身份或权限已变化 原文与确认已隐藏 请重新核对"
  : status === 401 ? "请登录自己的运营账户" : status === 403 || status === 404 ? "当前无法读取或处理这笔原履约操作 请核对订单与资料权限"
    : status === 400 || status === 422 ? "请核对原表单及固定业务依据 不发送替代填写"
      : status === 409 ? "原状态 版本或确认依据已变化 请只读核对原请求后再操作"
        : "原履约响应未知 请求可能已保存 请只读取原回执 不换键重复提交";
function current(options: AgentFulfillmentReadOptions) {
  if (options.signal?.aborted || options.isCurrent && !options.isCurrent())
    throw new AgentFulfillmentCommandRequestError(409, failureText(409, true), "authority_changed");
}
function id(raw: string) {
  const value = EntityIdSchema.safeParse(raw);
  if (!value.success) throw new AgentFulfillmentCommandRequestError(400, "请从原订单或原履约记录进入核对");
  return value.data.toLowerCase();
}
async function request<T extends { contextAuthority: string }>(path: string, schema: z.ZodType<T>, authority: string,
  status: number, options: AgentFulfillmentReadOptions, body?: unknown): Promise<T> {
  current(options);
  if (!authority) throw new AgentFulfillmentCommandRequestError(401, failureText(401));
  const text = body === undefined ? undefined : JSON.stringify(body);
  if (text !== undefined && new TextEncoder().encode(text).byteLength > 8 * 1024 * 1024)
    throw new AgentFulfillmentCommandRequestError(413, "原填写过大 本次未发送 请保留原业务资料");
  let response: Response;
  try {
    response = await fetch("/api/agent-fulfillment-commands/" + path, { method: body === undefined ? "GET" : "POST",
      credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { "x-yummyai-context-authority": authority, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: text,
      signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(body === undefined ? 30_000 : 120_000)]) });
  } catch { current(options); throw new AgentFulfillmentCommandRequestError(0, failureText(0)); }
  const reader = response.body?.getReader();
  if (!reader) { current(options); throw new AgentFulfillmentCommandRequestError(response.ok ? 502 : response.status, failureText(response.status)); }
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > (response.ok ? 8 * 1024 * 1024 : 8192)) { await reader.cancel(); throw invalid(); } chunks.push(part.value); }
  } catch { current(options); throw new AgentFulfillmentCommandRequestError(response.ok ? 502 : response.status, failureText(response.status)); }
  finally { reader.releaseLock(); }
  current(options);
  let raw: unknown;
  try {
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw invalid();
    const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new AgentFulfillmentCommandRequestError(response.ok ? 502 : response.status, failureText(response.status)); }
  if (!response.ok) {
    const changed = response.status === 409 && raw !== null && typeof raw === "object" && "code" in raw && raw.code === "authority_changed";
    throw new AgentFulfillmentCommandRequestError(response.status, failureText(response.status, changed), changed ? "authority_changed" : null);
  }
  const parsed = schema.safeParse(raw);
  if (response.status !== status || !parsed.success) throw invalid();
  if (response.headers.get("x-yummyai-context-authority") !== authority || parsed.data.contextAuthority !== authority)
    throw new AgentFulfillmentCommandRequestError(409, failureText(409, true), "authority_changed");
  current(options); return parsed.data;
}
async function verify(value: AgentFulfillmentCommandView, options: AgentFulfillmentReadOptions) {
  if (new Set(value.native.lineIds).size !== value.native.lineIds.length) throw invalid();
  if (value.original && (await agentTransportTextHash(canonicalAgentFulfillmentOriginal(value.original)) !== value.native.requestChecksum
    || value.native.receipt && !fulfillmentCommandReceiptMatches(value.native, value.original))) throw invalid();
  current(options);
}
export const readAgentFulfillmentCommandWorkspace = (authority: string, options: AgentFulfillmentReadOptions = {}) =>
  request("workspace", AgentFulfillmentCommandWorkspaceSchema, authority, 200, options);
export async function readAgentFulfillmentCommands(input: { orderId: string; lineId?: string }, authority: string, options: AgentFulfillmentReadOptions = {}) {
  const query = AgentFulfillmentCommandListQuerySchema.parse({ version: AGENT_FULFILLMENT_COMMAND_VERSION, ...input });
  const parameters = new URLSearchParams({ version: query.version, orderId: query.orderId }); if (query.lineId) parameters.set("lineId", query.lineId);
  const value = await request("requests?" + parameters, AgentFulfillmentCommandListSchema, authority, 200, options);
  if (new Set(value.items.map(item => item.native.id)).size !== value.items.length || value.items.some(item => item.native.orderId !== query.orderId || query.lineId && !item.native.lineIds.includes(query.lineId))) throw invalid();
  await Promise.all(value.items.map(item => verify(item, options))); current(options); return value;
}
export async function readAgentFulfillmentCommand(commandId: string, orderId: string, authority: string, options: AgentFulfillmentReadOptions = {}) {
  const expected = id(commandId), query = AgentFulfillmentCommandGetQuerySchema.parse({ version: AGENT_FULFILLMENT_COMMAND_VERSION, orderId });
  const value = await request("requests/" + expected + "?" + new URLSearchParams(query), AgentFulfillmentCommandViewSchema, authority, 200, options);
  if (value.native.id !== expected || value.native.orderId !== query.orderId) throw invalid();
  await verify(value, options); return value;
}
export async function readAgentFulfillmentCommandReceipt(input: { orderId: string; requestId: string; requestChecksum: string }, authority: string, options: AgentFulfillmentReadOptions = {}) {
  const query = AgentFulfillmentCommandReceiptQuerySchema.parse({ version: AGENT_FULFILLMENT_COMMAND_VERSION,
    orderId: input.orderId, requestId: input.requestId, requestChecksum: input.requestChecksum });
  const value = await request("receipts?" + new URLSearchParams(query), AgentFulfillmentCommandReceiptSchema, authority, 200, options);
  if (value.orderId !== query.orderId || value.requestId !== query.requestId || value.requestChecksum !== query.requestChecksum) throw invalid();
  return value;
}
export async function prepareAgentFulfillmentCommand(raw: PrepareAgentFulfillmentCommand, authority: string, options: AgentFulfillmentReadOptions = {}) {
  const parsed = PrepareAgentFulfillmentCommandSchema.parse(raw), input = { ...parsed, original: normalizeFulfillmentCommand(parsed.original) };
  const checksum = await agentTransportTextHash(canonicalAgentFulfillmentOriginal(input.original)); current(options);
  const value = await request("prepare", AgentFulfillmentCommandViewSchema, authority, 201, options, input);
  if (value.native.orderId !== input.orderId || value.native.requestId !== input.original.requestId || value.native.requestChecksum !== checksum
    || value.native.kind !== input.original.kind || value.native.targetId !== input.original.targetId) throw invalid();
  await verify(value, options); return value;
}
export async function actOnAgentFulfillmentCommand(value: AgentFulfillmentCommandView, action: "confirm" | "cancel" | "acknowledge",
  authority: string, options: AgentFulfillmentReadOptions = {}) {
  if (action === "confirm" && (!value.canConfirm || !value.confirmationExpiresAt || Date.parse(value.confirmationExpiresAt) <= Date.now() || Date.parse(value.native.expiresAt) <= Date.now())
    || action === "cancel" && !value.canCancel || action === "acknowledge" && !value.canAcknowledge)
    throw new AgentFulfillmentCommandRequestError(409, "请先只读核对当前原状态与确认依据 不复用旧操作许可");
  const control = { version: AGENT_FULFILLMENT_COMMAND_VERSION, orderId: value.native.orderId, requestId: value.native.requestId, requestChecksum: value.native.requestChecksum };
  const body = action === "confirm" ? ConfirmAgentFulfillmentCommandSchema.parse({ ...control, originalChecksum: value.originalChecksum,
    confirmationToken: value.confirmationToken, decision: value.confirmationDecision }) : action === "cancel"
    ? CancelAgentFulfillmentCommandSchema.parse({ ...control, decision: "cancel_original" })
    : AcknowledgeAgentFulfillmentCommandSchema.parse({ ...control, decision: "acknowledge_original" });
  const result = await request("requests/" + id(value.native.id) + "/" + action, AgentFulfillmentCommandViewSchema, authority, 200, options, body);
  if (result.native.id !== value.native.id || result.native.orderId !== value.native.orderId || result.native.requestId !== value.native.requestId
    || result.native.requestChecksum !== value.native.requestChecksum || result.native.kind !== value.native.kind || result.native.targetId !== value.native.targetId
    || result.native.lineIds.length !== value.native.lineIds.length || !result.native.lineIds.every(line => value.native.lineIds.includes(line))) throw invalid();
  if (action === "acknowledge" && (!result.native.acknowledged || result.native.status !== "acknowledged" || result.original !== null || result.native.summary !== null || result.native.receipt !== null)) throw invalid();
  await verify(result, options); return result;
}
