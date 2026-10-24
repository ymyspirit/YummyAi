import { verifyAgentNativeV3Transport } from "@yummyai/contracts/ai/agent-native-v3-transport";
import { z } from "zod";
import { agentTransportTextHash } from "@yummyai/contracts/ai/agent-transport";
import {
  AGENT_NATIVE_V3_VERSION, AgentNativeV3WorkspaceSchema, AgentNativeV3ViewSchema, AgentNativeV3ReceiptQuerySchema, AgentNativeV3ReceiptSchema,
  CreateAgentNativeV3Schema, StopAgentNativeV3Schema, PrepareAgentNativeV3ItemSchema, AgentNativeV3ItemReceiptSchema,
  canonicalAgentNativeV3Request,
  type AgentNativeV3View, type AgentNativeV3Receipt, type CreateAgentNativeV3, type AgentNativeV3ItemReceipt,
} from "@yummyai/contracts/ai/agent-native-v3";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { verifyAgentFulfillmentDefinition } from "@yummyai/contracts/ai/agent-fulfillment-transport";

export class AgentNativeV3RequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: "authority_changed" | null = null) { super(message); }
}
export const agentNativeV3ReadDenied = (failure: unknown): failure is AgentNativeV3RequestError => failure instanceof AgentNativeV3RequestError && ([401, 403, 404].includes(failure.status) || failure.code === "authority_changed");
function message(status: number, changed = false) {
  return changed ? "当前身份或原业务范围已变化 私有目标 步骤与来源已隐藏" : status === 401 ? "请重新登录自己的运营账户" :
    status === 403 || status === 404 ? "当前不能读取这笔原任务或固定业务资料" : status === 400 || status === 422 ? "请核对原填写与固定对象范围 未发送替代请求" :
      status === 409 ? "原任务或来源依据有冲突 请先读取原回执 不替换原请求" :
        "响应尚未核对 原请求可能已登记 请只读取原回执 不换编号重复付费或准备";
}
async function json(response: Response) {
  const reader = response.body?.getReader(); if (!reader) throw new AgentNativeV3RequestError(response.ok ? 502 : response.status, message(response.ok ? 502 : response.status));
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > (response.ok ? 8 * 1024 * 1024 : 8192)) { await reader.cancel(); throw new Error("size"); } chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch { throw new AgentNativeV3RequestError(response.ok ? 502 : response.status, message(response.ok ? 502 : response.status)); }
  finally { reader.releaseLock(); }
}
async function request<T extends { contextAuthority: string }>(path: string, schema: z.ZodType<T>, authority: string, status: number,
  body?: unknown, signal?: AbortSignal, readPost = false): Promise<T> {
  if (!authority) throw new AgentNativeV3RequestError(401, message(401));
  let response: Response;
  try {
    response = await fetch("/api/agent-native-v3/" + path, { method: body === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin", redirect: "error",
      headers: { accept: "application/json", "x-yummyai-context-authority": authority, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([...(signal && (body === undefined || readPost) ? [signal] : []), AbortSignal.timeout(120_000)]) });
  } catch (failure) { if (signal?.aborted && (body === undefined || readPost)) throw failure; throw new AgentNativeV3RequestError(0, message(0)); }
  const raw = await json(response);
  if (!response.ok) {
    const code = response.status === 409 && raw && typeof raw === "object" && "code" in raw && raw.code === "authority_changed" ? "authority_changed" : null;
    throw new AgentNativeV3RequestError(response.status, message(response.status, code !== null), code);
  }
  if (response.headers.get("x-yummyai-context-authority") !== authority) throw new AgentNativeV3RequestError(409, message(409, true), "authority_changed");
  const result = schema.safeParse(raw);
  if (response.status !== status || !result.success) throw new AgentNativeV3RequestError(502, "原任务响应结构或状态无法核对 不采用替代任务");
  if (result.data.contextAuthority !== authority) throw new AgentNativeV3RequestError(409, message(409, true), "authority_changed");
  return result.data;
}
const textHash = agentTransportTextHash;
const id = (value: string) => { const result = z.uuidv7().safeParse(value); if (!result.success) throw new AgentNativeV3RequestError(400, "请填写真实有效的原任务 ID"); return result.data.toLowerCase(); };
const invalid = () => new AgentNativeV3RequestError(502, "原任务的固定输入 来源或提案校验无法核对 不采用替代原文");
export async function readAgentNativeV3Workspace(authority: string, signal?: AbortSignal) {
  const value = await request("workspace", AgentNativeV3WorkspaceSchema, authority, 200, undefined, signal);
  if (value.resourceWorkspace.contextAuthority !== authority || value.toolWorkspace.contextAuthority !== authority || value.fulfillmentWorkspace.contextAuthority !== authority || value.fulfillmentWorkspace.definition.contextAuthority !== authority)
    throw new AgentNativeV3RequestError(409, message(409, true), "authority_changed");
  if (value.resourceWorkspace.tools.length !== 6 || new Set(value.toolWorkspace.tools.map(tool => tool.key)).size !== 5 || new Set(value.toolWorkspace.commands.map(command => command.domain + "/" + command.kind)).size !== 37) throw invalid();
  try { await verifyAgentFulfillmentDefinition(value.fulfillmentWorkspace.definition); } catch { throw invalid(); }
  signal?.throwIfAborted();
  return value;
}
export async function readAgentNativeV3Run(runId: string, authority: string, signal?: AbortSignal) {
  const expected = id(runId), value = await request("runs/" + expected, AgentNativeV3ViewSchema, authority, 200, undefined, signal);
  if (value.id.toLowerCase() !== expected) throw invalid(); await verifyAgentNativeV3View(value); return value;
}
export async function readAgentNativeV3Receipt(raw: { requestId: string; requestChecksum: string }, authority: string, signal?: AbortSignal) {
  const query = AgentNativeV3ReceiptQuerySchema.safeParse(raw); if (!query.success) throw new AgentNativeV3RequestError(400, "原请求标识无效 不读取替代回执");
  const value = await request("receipt?" + new URLSearchParams(query.data), AgentNativeV3ReceiptSchema, authority, 200, undefined, signal);
  if (value.requestId !== query.data.requestId || value.requestChecksum !== query.data.requestChecksum) throw invalid(); return value;
}
export async function createAgentNativeV3(raw: CreateAgentNativeV3, authority: string) {
  const parsed = CreateAgentNativeV3Schema.safeParse(raw); if (!parsed.success) throw new AgentNativeV3RequestError(400, message(400));
  const checksum = textHash(canonicalAgentNativeV3Request(parsed.data));
  const [value, digest] = await Promise.all([request("runs", AgentNativeV3ViewSchema, authority, 201, parsed.data), checksum]);
  if (value.requestId !== parsed.data.requestId || value.requestChecksum !== digest || value.privateAvailable && canonicalJson(value.bindings) !== canonicalJson(parsed.data.bindings) ||
    canonicalJson(value.allowedCommands) !== canonicalJson(parsed.data.allowedCommands) || canonicalJson(value.limits) !== canonicalJson(parsed.data.limits) || canonicalJson(value.executionContract) !== canonicalJson(parsed.data.executionContract)) throw invalid();
  await verifyAgentNativeV3View(value); return value;
}
export async function stopAgentNativeV3(runId: string, raw: z.infer<typeof StopAgentNativeV3Schema>, authority: string) {
  const expected = id(runId), parsed = StopAgentNativeV3Schema.safeParse(raw); if (!parsed.success) throw new AgentNativeV3RequestError(400, message(400));
  const value = await request("runs/" + expected + "/stop", AgentNativeV3ReceiptSchema, authority, 200, parsed.data);
  if (value.disposition !== "known" || value.runId?.toLowerCase() !== expected || value.requestId !== parsed.data.requestId) throw invalid(); return value;
}
type Item = AgentNativeV3View["items"][number];
function itemRequest(run: Pick<AgentNativeV3View, "id" | "requestId">, item: Pick<Item, "id" | "proposalChecksum">) {
  return { path: "runs/" + id(run.id) + "/items/" + id(item.id), input: PrepareAgentNativeV3ItemSchema.parse({ version: AGENT_NATIVE_V3_VERSION, requestId: run.requestId, proposalChecksum: item.proposalChecksum }) };
}
function checkItem(value: AgentNativeV3ItemReceipt, run: Pick<AgentNativeV3View, "id">, item: Item) {
  if (value.runId.toLowerCase() !== run.id.toLowerCase() || value.itemId.toLowerCase() !== item.id.toLowerCase() || value.proposalChecksum !== item.proposalChecksum || value.preparationRequestChecksum !== item.preparationRequestChecksum ||
    item.agentCommandId && value.agentCommandId !== item.agentCommandId || item.ownerCommandId && value.ownerCommandId !== item.ownerCommandId) throw invalid();
}
export async function readAgentNativeV3ItemReceipt(run: Pick<AgentNativeV3View, "id" | "requestId">, item: Item, authority: string, signal?: AbortSignal) {
  const { path, input } = itemRequest(run, item), value = await request(path + "/receipt", AgentNativeV3ItemReceiptSchema, authority, 200, input, signal, true);
  checkItem(value, run, item); return value;
}
export async function prepareAgentNativeV3Item(run: Pick<AgentNativeV3View, "id" | "requestId">, item: Item, authority: string) {
  const { path, input } = itemRequest(run, item), value = await request(path + "/prepare", AgentNativeV3ItemReceiptSchema, authority, 201, input);
  checkItem(value, run, item); return value;
}
export async function verifyAgentNativeV3View(value: AgentNativeV3View) {
  try { await verifyAgentNativeV3Transport(value); } catch { throw invalid(); }
}
export function assertAgentNativeV3RunReceipt(run: AgentNativeV3View, receipt: AgentNativeV3Receipt) {
  if (receipt.disposition !== "known" || receipt.runId !== run.id || receipt.requestId !== run.requestId || receipt.requestChecksum !== run.requestChecksum) throw invalid();
}
