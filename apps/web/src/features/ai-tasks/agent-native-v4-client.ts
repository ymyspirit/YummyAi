import { z } from "zod";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { agentTransportTextHash } from "@yummyai/contracts/ai/agent-transport";
import { verifyAgentFulfillmentDefinition } from "@yummyai/contracts/ai/agent-fulfillment-transport";
import { verifyAgentNativeV4Transport } from "@yummyai/contracts/ai/agent-native-v4-transport";
import { bindAgentFulfillmentCompletion } from "@yummyai/contracts/ai/agent-fulfillment-proposal";
import {
  AGENT_NATIVE_V4_VERSION, AgentNativeV4WorkspaceSchema, AgentNativeV4ViewSchema,
  AgentNativeV4ReceiptQuerySchema, AgentNativeV4ReceiptSchema, CreateAgentNativeV4Schema,
  StopAgentNativeV4Schema, AgentNativeV4ItemReceiptQuerySchema, PrepareAgentNativeV4ItemSchema,
  AgentNativeV4ItemReceiptSchema, canonicalAgentNativeV4Request,
  type AgentNativeV4View, type AgentNativeV4Receipt, type AgentNativeV4ItemReceipt,
} from "@yummyai/contracts/ai/agent-native-v4";
import { AGENT_FULFILLMENT_COMMAND_VERSION, canonicalAgentFulfillmentOriginal, type PrepareAgentFulfillmentCommand } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { normalizeFulfillmentCommand } from "@yummyai/contracts/order/fulfillment-command";

export type CreateAgentNativeV4 = z.infer<typeof CreateAgentNativeV4Schema>;
export class AgentNativeV4RequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: "authority_changed" | null = null) { super(message); }
}
export const agentNativeV4ReadDenied = (failure: unknown): failure is AgentNativeV4RequestError => failure instanceof AgentNativeV4RequestError
  && ([401, 403, 404].includes(failure.status) || failure.code === "authority_changed");
function message(status: number, changed = false) {
  return changed ? "当前本人身份或来源权限已变化 原提案与确认已隐藏" : status === 401 ? "请重新登录自己的运营账户" :
    status === 403 || status === 404 ? "当前不能读取这笔原任务或固定来源" : status === 400 || status === 422 ? "请核对原填写与固定对象 不发送替代请求" :
      status === 409 ? "原任务或填写依据有冲突 请先只读核对原回执" : "原响应尚未核对 本次可能已保存 请读取原回执 不换编号再次付费或准备";
}
const invalid = () => new AgentNativeV4RequestError(502, "原任务 输入 来源或准备回执无法核对 不采用替代内容");
async function json(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) { await reader.cancel(); throw invalid(); }
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > (response.ok ? 8 * 1024 * 1024 : 8192)) { await reader.cancel(); throw invalid(); } chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch { throw new AgentNativeV4RequestError(response.ok ? 502 : response.status, message(response.ok ? 502 : response.status)); }
  finally { reader.releaseLock(); }
}
async function request<T extends { contextAuthority: string }>(path: string, schema: z.ZodType<T>, authority: string,
  expectedStatus: number, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!authority) throw new AgentNativeV4RequestError(401, message(401));
  let response: Response;
  try {
    response = await fetch("/api/agent-native-v4/" + path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin",
      cache: "no-store", redirect: "error", headers: { accept: "application/json", "x-yummyai-context-authority": authority,
        ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([...(signal && body === undefined ? [signal] : []), AbortSignal.timeout(120_000)]) });
  } catch (failure) { if (signal?.aborted && body === undefined) throw failure; throw new AgentNativeV4RequestError(0, message(0)); }
  const raw = await json(response);
  if (!response.ok) {
    const code = response.status === 409 && raw && typeof raw === "object" && "code" in raw && raw.code === "authority_changed" ? "authority_changed" : null;
    throw new AgentNativeV4RequestError(response.status, message(response.status, code !== null), code);
  }
  if (response.headers.get("x-yummyai-context-authority") !== authority) throw new AgentNativeV4RequestError(409, message(409, true), "authority_changed");
  const parsed = schema.safeParse(raw); if (response.status !== expectedStatus || !parsed.success) throw invalid();
  if (parsed.data.contextAuthority !== authority) throw new AgentNativeV4RequestError(409, message(409, true), "authority_changed");
  signal?.throwIfAborted(); return parsed.data;
}
function id(value: string) { const parsed = z.uuidv7().safeParse(value); if (!parsed.success) throw new AgentNativeV4RequestError(400, "原任务或提案编号无效"); return parsed.data.toLowerCase(); }
export async function readAgentNativeV4Workspace(authority: string, signal?: AbortSignal) {
  const value = await request("workspace", AgentNativeV4WorkspaceSchema, authority, 200, undefined, signal);
  if ([value.resourceWorkspace, value.toolWorkspace, value.fulfillmentWorkspace, value.fulfillmentWorkspace.definition, value.commandWorkspace]
    .some(part => part.contextAuthority !== authority)) throw new AgentNativeV4RequestError(409, message(409, true), "authority_changed");
  if (new Set(value.commandWorkspace.capabilities.map(item => item.domain + "/" + item.kind)).size !== 51) throw invalid();
  try { await verifyAgentFulfillmentDefinition(value.fulfillmentWorkspace.definition); } catch { throw invalid(); }
  signal?.throwIfAborted(); return value;
}
export async function verifyAgentNativeV4View(value: AgentNativeV4View) { try { await verifyAgentNativeV4Transport(value); } catch { throw invalid(); } }
export async function readAgentNativeV4Run(runId: string, authority: string, signal?: AbortSignal) {
  const expected = id(runId), value = await request("runs/" + expected, AgentNativeV4ViewSchema, authority, 200, undefined, signal);
  if (id(value.id) !== expected) throw invalid(); await verifyAgentNativeV4View(value); signal?.throwIfAborted(); return value;
}
export async function readAgentNativeV4Receipt(raw: { requestId: string; requestChecksum: string }, authority: string, signal?: AbortSignal) {
  const query = AgentNativeV4ReceiptQuerySchema.parse({ requestId: raw.requestId, requestChecksum: raw.requestChecksum });
  const value = await request("receipt?" + new URLSearchParams(query), AgentNativeV4ReceiptSchema, authority, 200, undefined, signal);
  if (value.requestId !== query.requestId || value.requestChecksum !== query.requestChecksum) throw invalid(); return value;
}
export async function createAgentNativeV4(raw: CreateAgentNativeV4, authority: string) {
  const input = CreateAgentNativeV4Schema.parse(raw), digest = await agentTransportTextHash(canonicalAgentNativeV4Request(input));
  const value = await request("runs", AgentNativeV4ViewSchema, authority, 201, input);
  if (value.requestId !== input.requestId || value.requestChecksum !== digest || value.privateAvailable &&
    (canonicalJson(value.bindings) !== canonicalJson(input.bindings) || canonicalJson(value.allowedCommands) !== canonicalJson(input.allowedCommands)
      || canonicalJson(value.limits) !== canonicalJson(input.limits) || canonicalJson(value.executionContract) !== canonicalJson(input.executionContract))) throw invalid();
  await verifyAgentNativeV4View(value); return value;
}
export async function stopAgentNativeV4(runId: string, raw: z.infer<typeof StopAgentNativeV4Schema>, authority: string) {
  const expected = id(runId), input = StopAgentNativeV4Schema.parse(raw), value = await request("runs/" + expected + "/stop", AgentNativeV4ReceiptSchema, authority, 200, input);
  if (value.disposition !== "known" || value.runId?.toLowerCase() !== expected || value.requestId !== input.requestId) throw invalid(); return value;
}
type Item = AgentNativeV4View["items"][number];
function coordinates(run: Pick<AgentNativeV4View, "id" | "requestId">, item: Pick<Item, "id" | "proposalChecksum">) {
  return { path: "runs/" + id(run.id) + "/items/" + id(item.id), query: AgentNativeV4ItemReceiptQuerySchema.parse({
    version: AGENT_NATIVE_V4_VERSION, requestId: run.requestId, proposalChecksum: item.proposalChecksum }) };
}
function checkItem(value: AgentNativeV4ItemReceipt, run: Pick<AgentNativeV4View, "id">, item: Item) {
  if (id(value.runId) !== id(run.id) || id(value.itemId) !== id(item.id) || value.proposalChecksum !== item.proposalChecksum
    || value.originalProtocol !== item.originalProtocol || item.preparationRequestChecksum && value.preparationRequestChecksum !== item.preparationRequestChecksum
    || item.completionChecksum && value.completionChecksum !== item.completionChecksum || item.fulfillmentIntentId && value.fulfillmentIntentId !== item.fulfillmentIntentId
    || item.agentCommandId && value.agentCommandId !== item.agentCommandId || item.ownerCommandId && value.ownerCommandId !== item.ownerCommandId) throw invalid();
}
export async function readAgentNativeV4ItemReceipt(run: Pick<AgentNativeV4View, "id" | "requestId">, item: Item, authority: string, signal?: AbortSignal) {
  const { path, query } = coordinates(run, item), value = await request(path + "/receipt?" + new URLSearchParams(query), AgentNativeV4ItemReceiptSchema, authority, 200, undefined, signal);
  checkItem(value, run, item); return value;
}
export async function prepareAgentNativeV4Item(run: AgentNativeV4View, item: Item, authority: string, completion: PrepareAgentFulfillmentCommand | null = null, current?: () => boolean) {
  const { path, query } = coordinates(run, item);
  let completed: PrepareAgentFulfillmentCommand | null = null, completionChecksum: string | null = null, originalChecksum: string | null = null;
  if (item.originalProtocol === AGENT_FULFILLMENT_COMMAND_VERSION) {
    const suggestion = run.result?.proposals.find(proposal => proposal.id === item.id)?.draft.fulfillment;
    if (!suggestion || !completion) throw new AgentNativeV4RequestError(400, "请在原表单补齐实际填写并本人核对 不用模型建议代替确认");
    completed = bindAgentFulfillmentCompletion(suggestion, item.id, { ...completion, original: normalizeFulfillmentCommand(completion.original) });
    completionChecksum = await agentTransportTextHash(canonicalJson(completed));
    originalChecksum = await agentTransportTextHash(canonicalAgentFulfillmentOriginal(completed.original));
  } else if (completion !== null) throw invalid();
  const input = PrepareAgentNativeV4ItemSchema.parse({ ...query, completion: completed });
  if (current && !current()) throw new AgentNativeV4RequestError(409, message(409, true), "authority_changed");
  const value = await request(path + "/prepare", AgentNativeV4ItemReceiptSchema, authority, 201, input);
  checkItem(value, run, item);
  if (value.disposition === "known" && completionChecksum && (value.completionChecksum !== completionChecksum || value.preparationRequestChecksum !== originalChecksum)) throw invalid();
  return value;
}
export function assertAgentNativeV4RunReceipt(run: AgentNativeV4View, receipt: AgentNativeV4Receipt) {
  if (receipt.disposition !== "known" || receipt.runId !== run.id || receipt.requestId !== run.requestId || receipt.requestChecksum !== run.requestChecksum) throw invalid();
}
