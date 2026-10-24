import type { z } from "zod";
import {
  AGENT_RESOURCES_VERSION, AgentResourceWorkspaceSchema, AgentResourceDefinitionRequestSchema, AgentResourceDefinitionSchema,
  AgentResourceCandidatesQuerySchema, AgentResourceCandidatesSchema, AgentResourceCallSchema, AgentResourceResultSchema,
  type AgentResourceKey, type AgentResourceCall, type AgentResourceCandidatesQuery,
} from "@yummyai/contracts/ai/agent-resources";
import { verifyAgentResourceDefinition, verifyAgentResourceCandidates, verifyAgentResourceResult } from "@yummyai/contracts/ai/agent-resource-transport";

export const agentResourceLabels: Record<AgentResourceKey, string> = {
  "research.evidence": "研究原证据", "catalog.sku": "SKU 与配方", "listing.version": "刊登原版本",
  "orders.order": "订单原事实", "finance.profit_run": "利润原计算", "advertising.analysis": "广告原分析",
};
export class AgentResourceRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null) { super(message); }
}
export const agentResourceReadDenied = (error: unknown): error is AgentResourceRequestError => error instanceof AgentResourceRequestError &&
  ([401, 403, 404].includes(error.status) || error.code === "authority_changed");
function message(status: number, changed = false) {
  return changed ? "当前本人身份或原对象读取范围已变化 私有资料已隐藏" : status === 401 ? "请重新登录自己的运营账户" :
    status === 403 || status === 404 ? "当前不能读取所选原对象 旧候选与事实已隐藏" : status === 400 || status === 422 ? "请重新核对原候选及版本输入 不使用替代编号" :
      status === 409 ? "原对象版本或读取依据已变化 请重新读取候选与定义" : "本次读取暂不可核对 请重读原资料 不使用缺失值补造事实";
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new AgentResourceRequestError(response.ok ? 502 : response.status, message(response.ok ? 502 : response.status));
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > (response.ok ? 8 * 1024 * 1024 : 8192)) { await reader.cancel(); throw new Error("bounded"); } chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new AgentResourceRequestError(response.ok ? 502 : response.status, message(response.ok ? 502 : response.status)); }
  finally { reader.releaseLock(); }
}
async function request<T extends { contextAuthority: string }>(path: string, schema: z.ZodType<T>, authority: string, input?: unknown, signal?: AbortSignal): Promise<T> {
  if (!authority) throw new AgentResourceRequestError(401, message(401));
  let response: Response;
  try { response = await fetch("/api/agent-resources/" + path, {
    method: input === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { accept: "application/json", "x-yummyai-context-authority": authority, ...(input === undefined ? {} : { "content-type": "application/json" }) },
    body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]),
  }); } catch (error) { if (signal?.aborted) throw error; throw new AgentResourceRequestError(0, message(0)); }
  const raw = await boundedJson(response);
  if (!response.ok) {
    const code = raw && typeof raw === "object" && "code" in raw && typeof raw.code === "string" &&
      (raw.code === "authority_changed" || /^agent_resources_[a-z_]{1,100}$/.test(raw.code)) ? raw.code : null;
    throw new AgentResourceRequestError(response.status, message(response.status, code === "authority_changed"), code);
  }
  if (response.headers.get("x-yummyai-context-authority") !== authority) throw new AgentResourceRequestError(409, message(409, true), "authority_changed");
  const parsed = schema.safeParse(raw);
  if (response.status !== 200 || !parsed.success) throw new AgentResourceRequestError(502, "原资源响应结构或状态无法核对 未采用替代资料");
  if (parsed.data.contextAuthority !== authority) throw new AgentResourceRequestError(409, message(409, true), "authority_changed");
  return parsed.data;
}
const integrityError = () => new AgentResourceRequestError(502, "原对象 定义 输入或来源校验未通过 本轮资料未采用");
export function readAgentResourceWorkspace(authority: string, signal?: AbortSignal) { return request("workspace", AgentResourceWorkspaceSchema, authority, undefined, signal); }
export async function readAgentResourceDefinition(tool: AgentResourceKey, authority: string, signal?: AbortSignal) {
  const input = AgentResourceDefinitionRequestSchema.parse({ version: AGENT_RESOURCES_VERSION, tool });
  const value = await request("definition", AgentResourceDefinitionSchema, authority, input, signal);
  try { await verifyAgentResourceDefinition(value, tool); } catch { throw integrityError(); } return value;
}
export async function readAgentResourceCandidates(raw: AgentResourceCandidatesQuery, authority: string, signal?: AbortSignal) {
  const input = AgentResourceCandidatesQuerySchema.parse(raw), value = await request("candidates", AgentResourceCandidatesSchema, authority, input, signal);
  try { await verifyAgentResourceCandidates(value, input); } catch { throw integrityError(); } return value;
}
export async function callAgentResource(raw: AgentResourceCall, authority: string, signal?: AbortSignal) {
  const parsed = AgentResourceCallSchema.safeParse(raw); if (!parsed.success) throw new AgentResourceRequestError(400, message(400));
  const value = await request("call", AgentResourceResultSchema, authority, parsed.data, signal);
  try { await verifyAgentResourceResult(value, parsed.data); } catch { throw integrityError(); } return value;
}
