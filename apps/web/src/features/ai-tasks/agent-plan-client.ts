import { z } from "zod";
import {
  AgentPlanReceiptQuerySchema, AgentPlanReceiptSchema, AgentPlanViewSchema,
  AgentPlanWorkspaceSchema, CreateAgentPlanSchema, StopAgentPlanSchema,
  AgentPlanItemReceiptSchema, PrepareAgentPlanItemSchema, agentPlanCommandKey, canonicalAgentPlanRequest, canonicalAgentPlanDraft,
  type AgentPlanReceipt, type AgentPlanView, type CreateAgentPlan, type AgentPlanItemView,
} from "@yummyai/contracts/ai/agent-plan";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AGENT_COMMAND_VERSION, canonicalAgentCommandOriginal, canonicalAgentCommandRequest } from "@yummyai/contracts/ai/agent-command";

export class AgentPlanRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: "authority_changed" | null = null) {
    super(message);
  }
}
export function agentPlanReadDenied(error: unknown): error is AgentPlanRequestError {
  return error instanceof AgentPlanRequestError && ([401, 403, 404].includes(error.status) || error.code === "authority_changed");
}
function message(status: number, code: "authority_changed" | null = null) {
  return code === "authority_changed" ? "当前身份或授权范围已变化 原私有资料已隐藏 请重新核对" :
    status === 401 ? "请重新登录自己的运营账户" : status === 403 || status === 404 ? "当前无法读取这笔 Agent 任务或业务资料" :
      status === 400 || status === 422 ? "原填写或固定依据未通过校验 请核对原请求" :
        status === 409 ? "原任务版本或固定依据有冲突 请先读取原回执 不替换原请求" :
          "本次响应暂时无法核对 原任务可能已登记 请只读取原回执 不重复发起付费任务";
}
async function request<T extends { contextAuthority: string }>(path: string, schema: z.ZodType<T>, authority: string,
  expectedStatus: number, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!authority) throw new AgentPlanRequestError(401, message(401));
  let response: Response;
  try {
    response = await fetch("/api/agent-plans/" + path, {
      method: body === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin",
      headers: { "x-yummyai-context-authority": authority, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Closing a view cannot establish whether a submitted write committed.
      signal: body === undefined ? AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    });
  } catch { throw new AgentPlanRequestError(0, message(0)); }
  const reader = response.body?.getReader();
  if (!reader) throw new AgentPlanRequestError(response.ok ? 502 : response.status, message(response.ok ? 502 : response.status));
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > (response.ok ? 8 * 1024 * 1024 : 8192)) { await reader.cancel(); throw new Error("size"); }
      chunks.push(part.value);
    }
  } catch { throw new AgentPlanRequestError(response.ok ? 502 : response.status, message(response.ok ? 502 : response.status)); }
  finally { reader.releaseLock(); }
  let raw: unknown;
  try {
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new AgentPlanRequestError(response.ok ? 502 : response.status, message(response.ok ? 502 : response.status)); }
  if (!response.ok) {
    const code = response.status === 409 && raw !== null && typeof raw === "object" && "code" in raw && raw.code === "authority_changed" ? "authority_changed" : null;
    throw new AgentPlanRequestError(response.status, message(response.status, code), code);
  }
  if (response.headers.get("x-yummyai-context-authority") !== authority)
    throw new AgentPlanRequestError(409, message(409, "authority_changed"), "authority_changed");
  const parsed = schema.safeParse(raw);
  if (response.status !== expectedStatus || !parsed.success)
    throw new AgentPlanRequestError(502, "原响应结构或状态无法核对 未采用替代数据 请保留原任务编号");
  if (parsed.data.contextAuthority !== authority)
    throw new AgentPlanRequestError(409, message(409, "authority_changed"), "authority_changed");
  return parsed.data;
}
const runId = (value: string) => {
  const parsed = z.uuidv7().safeParse(value);
  if (!parsed.success) throw new AgentPlanRequestError(400, "请填写真实有效的 Agent 任务 ID");
  return parsed.data.toLowerCase();
};
export async function readAgentPlanWorkspace(authority: string, signal?: AbortSignal) {
  const result = await request("workspace", AgentPlanWorkspaceSchema, authority, 200, undefined, signal);
  if (result.readWorkspace.contextAuthority !== authority)
    throw new AgentPlanRequestError(409, message(409, "authority_changed"), "authority_changed");
  return result;
}
export async function readAgentPlanRun(id: string, authority: string, signal?: AbortSignal) {
  const expected = runId(id), result = await request("runs/" + expected, AgentPlanViewSchema, authority, 200, undefined, signal);
  if (result.id !== expected) throw new AgentPlanRequestError(502, "原任务身份无法核对 未采用其他任务的资料");
  await verifyView(result); return result;
}
export async function readAgentPlanReceipt(input: { requestId: string; requestChecksum: string }, authority: string, signal?: AbortSignal) {
  const parsed = AgentPlanReceiptQuerySchema.safeParse(input);
  if (!parsed.success) throw new AgentPlanRequestError(400, "原请求标识无效 未读取替代请求");
  const result = await request("receipts?" + new URLSearchParams(parsed.data), AgentPlanReceiptSchema, authority, 200, undefined, signal);
  assertReceipt(result, parsed.data);
  return result;
}
function assertReceipt(result: AgentPlanReceipt, expected: { requestId: string; requestChecksum: string }) {
  if (result.requestId !== expected.requestId || result.requestChecksum !== expected.requestChecksum)
    throw new AgentPlanRequestError(502, "原请求回执身份或校验值不匹配 未登记替代结果");
}
export async function createAgentPlan(raw: CreateAgentPlan, authority: string) {
  const parsed = CreateAgentPlanSchema.safeParse(raw);
  if (!parsed.success) throw new AgentPlanRequestError(400, message(400));
  const digest = crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalAgentPlanRequest(parsed.data)));
  // No asynchronous gap between the caller's final identity check and fetch.
  const [result, hash] = await Promise.all([request("runs", AgentPlanViewSchema, authority, 201, parsed.data), digest]);
  const requestChecksum = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  if (result.requestId !== parsed.data.requestId || result.requestChecksum !== requestChecksum)
    throw new AgentPlanRequestError(502, "已提交请求的回执无法绑定 请保留原请求标识并只读核对");
  if (canonicalJson(result.allowedReads) !== canonicalJson(parsed.data.allowedReads) || canonicalJson(result.allowedCommands) !== canonicalJson(parsed.data.allowedCommands) ||
    canonicalJson(result.limits) !== canonicalJson(parsed.data.limits) || result.executionContract.checksum !== parsed.data.executionContract.checksum)
    throw new AgentPlanRequestError(502, "原计划的允许范围或预算边界不一致 请只读核对原请求");
  await verifyView(result); return result;
}
async function checksum(text: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function verifyView(value: AgentPlanView) {
  assertView(value);
  await Promise.all((value.result?.proposals ?? []).map(async proposal => {
    if (await checksum(canonicalAgentPlanDraft(proposal.draft)) !== proposal.proposalChecksum)
      throw new AgentPlanRequestError(502, "模型提案完整原文校验值不一致 不准备替代正文");
    const original = proposal.draft.original;
    if (original && (await checksum(canonicalAgentCommandOriginal(original)) !== proposal.originalChecksum ||
      await checksum(canonicalAgentCommandRequest("prepare", { version: AGENT_COMMAND_VERSION, requestId: proposal.id, original })) !== proposal.preparationRequestChecksum))
      throw new AgentPlanRequestError(502, "提案与原业务输入或原准备请求摘要不一致 已停止准备");
  }));
}
function assertView(value: AgentPlanView) {
  if (!value.privateAvailable && (value.goal !== null || value.contextText !== null || value.result !== null || value.steps.length || value.collections.length) ||
    new Set(value.items.map(item => item.id)).size !== value.items.length || new Set(value.items.map(item => item.position)).size !== value.items.length ||
    new Set(value.allowedReads).size !== value.allowedReads.length || new Set(value.allowedCommands.map(agentPlanCommandKey)).size !== value.allowedCommands.length ||
    value.collections.some(collection => !value.allowedReads.includes(collection.tool)))
    throw new AgentPlanRequestError(502, "原计划的私文或来源范围无法核对 已停止采用");
  if (value.result && (value.result.proposals.length !== value.items.length || value.result.proposals.some(proposal => {
    const item = value.items.find(candidate => candidate.id === proposal.id);
    return !item || item.position !== proposal.position || item.proposalChecksum !== proposal.proposalChecksum || item.originalChecksum !== proposal.originalChecksum ||
      item.preparationRequestChecksum !== proposal.preparationRequestChecksum || !value.allowedCommands.some(capability => agentPlanCommandKey(capability) === agentPlanCommandKey(proposal.draft.capability));
  }))) throw new AgentPlanRequestError(502, "提案与原计划固定条目不一致 不准备替代原文");
}
function itemPath(run: Pick<AgentPlanView, "id" | "requestId">, item: Pick<AgentPlanItemView, "id" | "proposalChecksum">) {
  return { path: "runs/" + runId(run.id) + "/items/" + runId(item.id),
    body: PrepareAgentPlanItemSchema.parse({ version: "erp-agent-plan-v1", requestId: run.requestId, proposalChecksum: item.proposalChecksum }) };
}
function assertItemReceipt(value: z.infer<typeof AgentPlanItemReceiptSchema>, run: Pick<AgentPlanView, "id">, item: AgentPlanItemView) {
  if (value.runId !== run.id || value.itemId !== item.id || value.proposalChecksum !== item.proposalChecksum || value.preparationRequestChecksum !== item.preparationRequestChecksum ||
    item.agentCommandId !== null && value.agentCommandId !== item.agentCommandId || item.ownerCommandId !== null && value.ownerCommandId !== item.ownerCommandId)
    throw new AgentPlanRequestError(502, "原准备回执未绑定这笔计划及固定提案 请只读取原回执");
}
export async function prepareAgentPlanItem(run: Pick<AgentPlanView, "id" | "requestId">, item: AgentPlanItemView, authority: string) {
  const { path, body } = itemPath(run, item);
  const result = await request(path + "/prepare", AgentPlanItemReceiptSchema, authority, 201, body);
  assertItemReceipt(result, run, item); return result;
}
export async function readAgentPlanItemReceipt(run: Pick<AgentPlanView, "id" | "requestId">, item: AgentPlanItemView, authority: string, signal?: AbortSignal) {
  const { path, body } = itemPath(run, item);
  const result = await request(path + "/receipt?" + new URLSearchParams({ requestId: body.requestId, proposalChecksum: body.proposalChecksum }), AgentPlanItemReceiptSchema, authority, 200, undefined, signal);
  assertItemReceipt(result, run, item); return result;
}
export async function stopAgentPlan(id: string, raw: z.infer<typeof StopAgentPlanSchema>, authority: string) {
  const expected = runId(id), parsed = StopAgentPlanSchema.safeParse(raw);
  if (!parsed.success) throw new AgentPlanRequestError(400, message(400));
  const result = await request("runs/" + expected + "/stop", AgentPlanReceiptSchema, authority, 200, parsed.data);
  if (result.disposition !== "known" || result.runId !== expected || result.requestId !== parsed.data.requestId)
    throw new AgentPlanRequestError(502, "停止请求的原任务身份无法核对 请读取原回执 不推断已停止");
  return result;
}
export function assertAgentPlanRunReceipt(run: AgentPlanView, receipt: AgentPlanReceipt) {
  assertReceipt(receipt, run);
  if (receipt.disposition !== "known" || receipt.runId !== run.id)
    throw new AgentPlanRequestError(502, "原回执与读取的任务不一致 未采用替代资料");
}
