import { AgentTransportIntegrityError, agentTransportErrorMessages, assertAgentToolTransport, verifyAgentToolTransport, verifyAgentToolDefinitionTransport } from "@yummyai/contracts/ai/agent-transport";
import type { z } from "zod";
import {
  AGENT_TOOLS_VERSION, AgentToolCallSchema, AgentToolDefinitionRequestSchema, AgentToolDefinitionSchema,
  AgentToolResultSchema, AgentToolWorkspaceSchema, AgentToolObjectQuerySchema, AgentToolObjectsSchema, type AgentToolCall, type AgentToolDefinition,
  type AgentToolResult, type AgentToolSelection,
} from "@yummyai/contracts/ai/agent-tools";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";

type FailureCode = "authority_changed" | "agent_collection_changed" | null;
export class AgentToolRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: FailureCode = null) { super(message); }
}
export const agentToolReadDenied = (failure: unknown): failure is AgentToolRequestError =>
  failure instanceof AgentToolRequestError && ([401, 403, 404].includes(failure.status) || failure.code === "authority_changed");
export const agentToolSelectionKey = (selection: AgentToolSelection) => selection.kind === "read"
  ? "read/" + selection.tool : "command/" + selection.command.domain + "/" + selection.command.kind;
function failureMessage(status: number, code: FailureCode = null) {
  if (code === "authority_changed") return "当前身份或读取范围已变化 原工具资料已隐藏 请重新核对";
  if (code === "agent_collection_changed") return "原集合已变化 已清除旧页 请从第一页重新读取";
  return status === 401 ? "请重新登录自己的运营账户" : status === 403 || status === 404 ? "当前不能读取这项工具或原业务对象" :
    status === 400 || status === 422 ? "请核对所选原对象与完整读取条件" :
      status === 409 ? "工具定义或原读取依据已变化 请重新读取定义与原资料" :
        "本次读取暂时无法核对 请重新读取 不使用旧上下文补填";
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new AgentToolRequestError(response.ok ? 502 : response.status, failureMessage(response.ok ? 502 : response.status));
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > (response.ok ? 8 * 1024 * 1024 : 8192)) { await reader.cancel(); throw new Error("bounded response"); }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new AgentToolRequestError(response.ok ? 502 : response.status, failureMessage(response.ok ? 502 : response.status)); }
  finally { reader.releaseLock(); }
}
async function request<T extends { contextAuthority: string }>(path: string, schema: z.ZodType<T>, authority: string,
  body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!authority) throw new AgentToolRequestError(401, failureMessage(401));
  let response: Response;
  try {
    response = await fetch("/api/agent-tools/" + path, {
      method: body === undefined ? "GET" : "POST", credentials: "same-origin", redirect: "error", cache: "no-store",
      headers: { accept: "application/json", "x-yummyai-context-authority": authority, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]),
    });
  } catch (failure) {
    if (signal?.aborted) throw failure;
    throw new AgentToolRequestError(0, failureMessage(0));
  }
  const raw = await boundedJson(response);
  if (!response.ok) {
    const code: FailureCode = response.status === 409 && raw !== null && typeof raw === "object" && "code" in raw &&
      (raw.code === "authority_changed" || raw.code === "agent_collection_changed") ? raw.code : null;
    throw new AgentToolRequestError(response.status, failureMessage(response.status, code), code);
  }
  if (response.headers.get("x-yummyai-context-authority") !== authority)
    throw new AgentToolRequestError(409, failureMessage(409, "authority_changed"), "authority_changed");
  const parsed = schema.safeParse(raw);
  if (response.status !== 200 || !parsed.success) throw new AgentToolRequestError(502, "原工具响应的结构或状态无法核对 未采用替代资料");
  if (parsed.data.contextAuthority !== authority)
    throw new AgentToolRequestError(409, failureMessage(409, "authority_changed"), "authority_changed");
  return parsed.data;
}
export async function readAgentToolWorkspace(authority: string, signal?: AbortSignal) {
  const result = await request("workspace", AgentToolWorkspaceSchema, authority, undefined, signal);
  if (new Set(result.tools.map(tool => tool.key)).size !== 5 ||
    new Set(result.commands.map(command => command.domain + "/" + command.kind)).size !== 37)
    throw new AgentToolRequestError(502, "工具目录存在重复或缺失 未使用不完整目录代替");
  return result;
}
export async function readAgentToolDefinition(selection: AgentToolSelection, authority: string, signal?: AbortSignal) {
  const body = AgentToolDefinitionRequestSchema.parse({ version: AGENT_TOOLS_VERSION, selection });
  const result = await request("definition", AgentToolDefinitionSchema, authority, body, signal);
  try { await verifyAgentToolDefinitionTransport(result,selection); } catch(failure) { throw transportError(failure); }
  return result;
}
export async function readAgentToolObjects(scope: z.infer<typeof AgentToolObjectQuerySchema>["scope"], authority: string, signal?: AbortSignal) {
  const query = AgentToolObjectQuerySchema.parse({ version: AGENT_TOOLS_VERSION, kind: "creative", scope });
  const result = await request("objects", AgentToolObjectsSchema, authority, query, signal);
  if (canonicalJson(result.query) !== canonicalJson(query))
    throw new AgentToolRequestError(502, "原对象候选没有绑定所选执行范围");
  return result;
}
export async function callAgentTool(raw: AgentToolCall, authority: string, signal?: AbortSignal) {
  const parsed = AgentToolCallSchema.safeParse(raw);
  if (!parsed.success) throw new AgentToolRequestError(400, failureMessage(400));
  const input = parsed.data, result = await request("call", AgentToolResultSchema, authority, input, signal);
  try { await verifyAgentToolTransport(result,input); } catch(failure) { throw transportError(failure); }
  return result;
}
export function assertAgentToolResult(value: AgentToolResult, call: AgentToolCall) {
  try { assertAgentToolTransport(value,call); } catch(failure) { throw transportError(failure); }
}
/** A cursor is opaque. Only the native owner may interpret it. */
export function appendAgentToolPage(previous: AgentToolResult[], value: AgentToolResult, call: AgentToolCall) {
  assertAgentToolResult(value, call);
  const last = previous.at(-1);
  if (previous.some(page => page.tool !== value.tool || page.definitionChecksum !== value.definitionChecksum || page.contextAuthority !== value.contextAuthority))
    throw new AgentToolRequestError(409, failureMessage(409, "agent_collection_changed"), "agent_collection_changed");
  if (value.tool === "orders.exceptions.page" || value.tool === "inventory.balances.page") {
    const prior = last && (last.tool === "orders.exceptions.page" || last.tool === "inventory.balances.page") ? last : null;
    const cursor = call.tool === "orders.exceptions.page" || call.tool === "inventory.balances.page" ? call.input.cursor : null;
    const ids = new Set(previous.flatMap(page => page.tool === "orders.exceptions.page" || page.tool === "inventory.balances.page" ? page.data.items.map(item => item.id) : []));
    if (cursor !== (prior?.data.nextCursor ?? null) || value.data.readCount !== (prior?.data.readCount ?? 0) + value.data.items.length ||
      new Set(value.data.items.map(item => item.id)).size !== value.data.items.length ||
      prior && canonicalJson({ ...prior.data.query, cursor: null }) !== canonicalJson({ ...value.data.query, cursor: null }) ||
      prior && (prior.data.collectionFingerprint !== value.data.collectionFingerprint || prior.data.total !== value.data.total) || value.data.items.some(item => ids.has(item.id)))
      throw new AgentToolRequestError(409, failureMessage(409, "agent_collection_changed"), "agent_collection_changed");
  } else if (value.tool === "creative.history") {
    const prior = last?.tool === "creative.history" ? last : null;
    const ids = new Set(previous.flatMap(page => page.tool === "creative.history" ? page.data.entries.map(entry => entry.id) : []));
    if (call.tool !== "creative.history" || (call.input.after ?? null) !== (prior?.data.nextCursor ?? null) ||
      prior && (prior.data.scope !== value.data.scope || prior.data.ownerId.toLowerCase() !== value.data.ownerId.toLowerCase()) ||
      new Set(value.data.entries.map(entry => entry.id)).size !== value.data.entries.length || value.data.entries.some(entry => ids.has(entry.id)))
      throw new AgentToolRequestError(502, "执行历史分页不连续 请从首个有界页重新读取");
  } else if (previous.length) throw new AgentToolRequestError(400, "这项读取是独立有界结果 不支持拼成全量集合");
  return [...previous, value];
}
export function agentToolDefinitionMatches(definition: AgentToolDefinition, selection: AgentToolSelection) {
  return agentToolSelectionKey(definition.selection) === agentToolSelectionKey(selection);
}

function transportError(failure:unknown) {
  const code=failure instanceof AgentTransportIntegrityError?failure.code:null;
  return new AgentToolRequestError(502,code&&code in agentTransportErrorMessages?agentTransportErrorMessages[code as keyof typeof agentTransportErrorMessages]:"原读取结果的完整校验值不一致 未采用替代结果");
}
