import { verifyAgentNativeTransport } from "@yummyai/contracts/ai/agent-transport";
import { z } from "zod";
import {
  AGENT_NATIVE_VERSION, AgentNativeWorkspaceSchema, AgentNativeViewSchema, AgentNativeReceiptQuerySchema, AgentNativeReceiptSchema,
  CreateAgentNativeSchema, StopAgentNativeSchema, PrepareAgentNativeItemSchema, AgentNativeItemReceiptSchema,
  canonicalAgentNativeRequest,
  type AgentNativeView, type AgentNativeReceipt, type CreateAgentNative, type AgentNativeItemReceipt,
} from "@yummyai/contracts/ai/agent-native";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";

export class AgentNativeRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: "authority_changed" | null = null) { super(message); }
}
export const agentNativeReadDenied = (failure: unknown): failure is AgentNativeRequestError => failure instanceof AgentNativeRequestError && ([401, 403, 404].includes(failure.status) || failure.code === "authority_changed");
function message(status: number, changed = false) {
  return changed ? "当前身份或原业务范围已变化 私有目标 步骤与来源已隐藏" : status === 401 ? "请重新登录自己的运营账户" :
    status === 403 || status === 404 ? "当前不能读取这笔原任务或固定业务资料" : status === 400 || status === 422 ? "请核对原填写与固定对象范围 未发送替代请求" :
      status === 409 ? "原任务或来源依据有冲突 请先读取原回执 不替换原请求" :
        "响应尚未核对 原请求可能已登记 请只读取原回执 不换编号重复付费或准备";
}
async function json(response: Response) {
  const reader = response.body?.getReader(); if (!reader) throw new AgentNativeRequestError(response.ok ? 502 : response.status, message(response.ok ? 502 : response.status));
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > (response.ok ? 8 * 1024 * 1024 : 8192)) { await reader.cancel(); throw new Error("size"); } chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch { throw new AgentNativeRequestError(response.ok ? 502 : response.status, message(response.ok ? 502 : response.status)); }
  finally { reader.releaseLock(); }
}
async function request<T extends { contextAuthority: string }>(path: string, schema: z.ZodType<T>, authority: string, status: number,
  body?: unknown, signal?: AbortSignal, readPost = false): Promise<T> {
  if (!authority) throw new AgentNativeRequestError(401, message(401));
  let response: Response;
  try {
    response = await fetch("/api/agent-native/" + path, { method: body === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin", redirect: "error",
      headers: { accept: "application/json", "x-yummyai-context-authority": authority, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([...(signal && (body === undefined || readPost) ? [signal] : []), AbortSignal.timeout(120_000)]) });
  } catch (failure) { if (signal?.aborted && (body === undefined || readPost)) throw failure; throw new AgentNativeRequestError(0, message(0)); }
  const raw = await json(response);
  if (!response.ok) {
    const code = response.status === 409 && raw && typeof raw === "object" && "code" in raw && raw.code === "authority_changed" ? "authority_changed" : null;
    throw new AgentNativeRequestError(response.status, message(response.status, code !== null), code);
  }
  if (response.headers.get("x-yummyai-context-authority") !== authority) throw new AgentNativeRequestError(409, message(409, true), "authority_changed");
  const result = schema.safeParse(raw);
  if (response.status !== status || !result.success) throw new AgentNativeRequestError(502, "原任务响应结构或状态无法核对 不采用替代任务");
  if (result.data.contextAuthority !== authority) throw new AgentNativeRequestError(409, message(409, true), "authority_changed");
  return result.data;
}
async function textHash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
const id = (value: string) => { const result = z.uuidv7().safeParse(value); if (!result.success) throw new AgentNativeRequestError(400, "请填写真实有效的原任务 ID"); return result.data.toLowerCase(); };
const invalid = () => new AgentNativeRequestError(502, "原任务的固定输入 来源或提案校验无法核对 不采用替代原文");
export async function readAgentNativeWorkspace(authority: string, signal?: AbortSignal) {
  const value = await request("workspace", AgentNativeWorkspaceSchema, authority, 200, undefined, signal);
  if (value.toolWorkspace.contextAuthority !== authority || new Set(value.toolWorkspace.tools.map(tool => tool.key)).size !== 5 || new Set(value.toolWorkspace.commands.map(command => command.domain + "/" + command.kind)).size !== 37) throw invalid();
  return value;
}
export async function readAgentNativeRun(runId: string, authority: string, signal?: AbortSignal) {
  const expected = id(runId), value = await request("runs/" + expected, AgentNativeViewSchema, authority, 200, undefined, signal);
  if (value.id.toLowerCase() !== expected) throw invalid(); await verifyAgentNativeView(value); return value;
}
export async function readAgentNativeReceipt(raw: { requestId: string; requestChecksum: string }, authority: string, signal?: AbortSignal) {
  const query = AgentNativeReceiptQuerySchema.safeParse(raw); if (!query.success) throw new AgentNativeRequestError(400, "原请求标识无效 不读取替代回执");
  const value = await request("receipt?" + new URLSearchParams(query.data), AgentNativeReceiptSchema, authority, 200, undefined, signal);
  if (value.requestId !== query.data.requestId || value.requestChecksum !== query.data.requestChecksum) throw invalid(); return value;
}
export async function createAgentNative(raw: CreateAgentNative, authority: string) {
  const parsed = CreateAgentNativeSchema.safeParse(raw); if (!parsed.success) throw new AgentNativeRequestError(400, message(400));
  const checksum = textHash(canonicalAgentNativeRequest(parsed.data));
  const [value, digest] = await Promise.all([request("runs", AgentNativeViewSchema, authority, 201, parsed.data), checksum]);
  if (value.requestId !== parsed.data.requestId || value.requestChecksum !== digest || canonicalJson(value.bindings) !== canonicalJson(parsed.data.bindings) ||
    canonicalJson(value.allowedCommands) !== canonicalJson(parsed.data.allowedCommands) || canonicalJson(value.limits) !== canonicalJson(parsed.data.limits) || canonicalJson(value.executionContract) !== canonicalJson(parsed.data.executionContract)) throw invalid();
  await verifyAgentNativeView(value); return value;
}
export async function stopAgentNative(runId: string, raw: z.infer<typeof StopAgentNativeSchema>, authority: string) {
  const expected = id(runId), parsed = StopAgentNativeSchema.safeParse(raw); if (!parsed.success) throw new AgentNativeRequestError(400, message(400));
  const value = await request("runs/" + expected + "/stop", AgentNativeReceiptSchema, authority, 200, parsed.data);
  if (value.disposition !== "known" || value.runId?.toLowerCase() !== expected || value.requestId !== parsed.data.requestId) throw invalid(); return value;
}
type Item = AgentNativeView["items"][number];
function itemRequest(run: Pick<AgentNativeView, "id" | "requestId">, item: Pick<Item, "id" | "proposalChecksum">) {
  return { path: "runs/" + id(run.id) + "/items/" + id(item.id), input: PrepareAgentNativeItemSchema.parse({ version: AGENT_NATIVE_VERSION, requestId: run.requestId, proposalChecksum: item.proposalChecksum }) };
}
function checkItem(value: AgentNativeItemReceipt, run: Pick<AgentNativeView, "id">, item: Item) {
  if (value.runId.toLowerCase() !== run.id.toLowerCase() || value.itemId.toLowerCase() !== item.id.toLowerCase() || value.proposalChecksum !== item.proposalChecksum || value.preparationRequestChecksum !== item.preparationRequestChecksum ||
    item.agentCommandId && value.agentCommandId !== item.agentCommandId || item.ownerCommandId && value.ownerCommandId !== item.ownerCommandId) throw invalid();
}
export async function readAgentNativeItemReceipt(run: Pick<AgentNativeView, "id" | "requestId">, item: Item, authority: string, signal?: AbortSignal) {
  const { path, input } = itemRequest(run, item), value = await request(path + "/receipt", AgentNativeItemReceiptSchema, authority, 200, input, signal, true);
  checkItem(value, run, item); return value;
}
export async function prepareAgentNativeItem(run: Pick<AgentNativeView, "id" | "requestId">, item: Item, authority: string) {
  const { path, input } = itemRequest(run, item), value = await request(path + "/prepare", AgentNativeItemReceiptSchema, authority, 201, input);
  checkItem(value, run, item); return value;
}
export async function verifyAgentNativeView(value: AgentNativeView) {
  try { await verifyAgentNativeTransport(value); } catch { throw invalid(); }
}
export function assertAgentNativeRunReceipt(run: AgentNativeView, receipt: AgentNativeReceipt) {
  if (receipt.disposition !== "known" || receipt.runId !== run.id || receipt.requestId !== run.requestId || receipt.requestChecksum !== run.requestChecksum) throw invalid();
}
