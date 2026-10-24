import type { z } from "zod";
import {
  AGENT_FULFILLMENT_VERSION, AGENT_FULFILLMENT_TOOL,
  AgentFulfillmentWorkspaceSchema, AgentFulfillmentDefinitionRequestSchema, AgentFulfillmentDefinitionSchema,
  AgentFulfillmentCandidatesQuerySchema, AgentFulfillmentCandidatesSchema, AgentFulfillmentCallSchema, AgentFulfillmentResultSchema,
  type AgentFulfillmentCall, type AgentFulfillmentKind,
} from "@yummyai/contracts/ai/agent-fulfillment";
import {
  verifyAgentFulfillmentDefinition, verifyAgentFulfillmentCandidates, verifyAgentFulfillmentResult,
} from "@yummyai/contracts/ai/agent-fulfillment-transport";

export type AgentFulfillmentDefinition = z.infer<typeof AgentFulfillmentDefinitionSchema>;
export type AgentFulfillmentCandidatesQuery = z.infer<typeof AgentFulfillmentCandidatesQuerySchema>;
export const agentFulfillmentKindLabels: Record<AgentFulfillmentKind, string> = {
  production: "生产", shipments: "发货", logistics: "物流",
};
export class AgentFulfillmentRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null) { super(message); }
}
export const agentFulfillmentReadDenied = (error: unknown): error is AgentFulfillmentRequestError =>
  error instanceof AgentFulfillmentRequestError && ([401, 403, 404].includes(error.status) || error.code === "authority_changed");
function message(status: number, changed = false) {
  return changed ? "当前本人身份或原订单读取范围已变化 已隐藏原候选与履约资料" :
    status === 401 ? "请重新登录自己的运营账户" : status === 403 || status === 404 ? "当前不能读取所选原订单或来源 已隐藏旧资料" :
      status === 400 || status === 422 ? "请核对真实订单及事件修订 不使用替代编号" :
        status === 409 ? "原订单修订或分页依据已变化 请重新核对原订单后从第一页读取" :
          "本次原来源暂时无法核对 请重试读取 不把缺失资料当作空记录或零数量";
}
const invalid = () => new AgentFulfillmentRequestError(502, "原定义 输入 对象或来源校验未通过 本次资料未采用");
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new AgentFulfillmentRequestError(response.ok ? 502 : response.status, message(response.ok ? 502 : response.status));
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > (response.ok ? 8 * 1024 * 1024 : 8192)) { await reader.cancel(); throw new Error("bounded"); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch { throw new AgentFulfillmentRequestError(response.ok ? 502 : response.status, message(response.ok ? 502 : response.status)); }
  finally { reader.releaseLock(); }
}
async function request<T extends { contextAuthority: string }>(path: "workspace" | "definition" | "candidates" | "call", schema: z.ZodType<T>, authority: string, input?: unknown, signal?: AbortSignal): Promise<T> {
  if (!authority) throw new AgentFulfillmentRequestError(401, message(401));
  let response: Response;
  try {
    response = await fetch("/api/agent-fulfillment/" + path, {
      method: input === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { accept: "application/json", "x-yummyai-context-authority": authority, ...(input === undefined ? {} : { "content-type": "application/json" }) },
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]),
    });
  } catch (error) { if (signal?.aborted) throw error; throw new AgentFulfillmentRequestError(0, message(0)); }
  const raw = await boundedJson(response);
  if (!response.ok) {
    const code = raw && typeof raw === "object" && "code" in raw && typeof raw.code === "string" &&
      (response.status === 409 && raw.code === "authority_changed" || /^agent_fulfillment_[a-z_]{1,100}$/.test(raw.code)) ? raw.code : null;
    throw new AgentFulfillmentRequestError(response.status, message(response.status, code === "authority_changed"), code);
  }
  if (response.headers.get("x-yummyai-context-authority") !== authority)
    throw new AgentFulfillmentRequestError(409, message(409, true), "authority_changed");
  const parsed = schema.safeParse(raw);
  if (response.status !== 200 || !parsed.success) throw invalid();
  if (parsed.data.contextAuthority !== authority) throw new AgentFulfillmentRequestError(409, message(409, true), "authority_changed");
  signal?.throwIfAborted();
  return parsed.data;
}
export async function readAgentFulfillmentWorkspace(authority: string, signal?: AbortSignal) {
  const value = await request("workspace", AgentFulfillmentWorkspaceSchema, authority, undefined, signal);
  if (value.definition.contextAuthority !== authority) throw new AgentFulfillmentRequestError(409, message(409, true), "authority_changed");
  try { await verifyAgentFulfillmentDefinition(value.definition); } catch { throw invalid(); }
  signal?.throwIfAborted(); return value;
}
export async function readAgentFulfillmentDefinition(authority: string, signal?: AbortSignal) {
  const input = AgentFulfillmentDefinitionRequestSchema.parse({ version: AGENT_FULFILLMENT_VERSION, tool: AGENT_FULFILLMENT_TOOL });
  const value = await request("definition", AgentFulfillmentDefinitionSchema, authority, input, signal);
  try { await verifyAgentFulfillmentDefinition(value); } catch { throw invalid(); }
  signal?.throwIfAborted(); return value;
}
export async function readAgentFulfillmentCandidates(raw: AgentFulfillmentCandidatesQuery, authority: string, signal?: AbortSignal) {
  const parsed = AgentFulfillmentCandidatesQuerySchema.safeParse(raw);
  if (!parsed.success) throw new AgentFulfillmentRequestError(400, message(400));
  const value = await request("candidates", AgentFulfillmentCandidatesSchema, authority, parsed.data, signal);
  try { await verifyAgentFulfillmentCandidates(value, parsed.data); } catch { throw invalid(); }
  signal?.throwIfAborted(); return value;
}
export async function callAgentFulfillment(raw: AgentFulfillmentCall, authority: string, signal?: AbortSignal) {
  const parsed = AgentFulfillmentCallSchema.safeParse(raw);
  if (!parsed.success) throw new AgentFulfillmentRequestError(400, message(400));
  const value = await request("call", AgentFulfillmentResultSchema, authority, parsed.data, signal);
  try { await verifyAgentFulfillmentResult(value, parsed.data); } catch { throw invalid(); }
  signal?.throwIfAborted(); return value;
}
