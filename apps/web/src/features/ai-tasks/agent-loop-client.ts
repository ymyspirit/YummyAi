import { z } from "zod";
import {
  AgentLoopReceiptQuerySchema, AgentLoopReceiptSchema, AgentLoopRunViewSchema,
  AgentLoopWorkspaceSchema, CreateAgentLoopSchema, StopAgentLoopSchema,
  type AgentLoopReceipt, type AgentLoopRunView, type CreateAgentLoop,
} from "@yummyai/contracts/ai/agent-loop";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";

export class AgentLoopRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: "authority_changed" | null = null) {
    super(message);
  }
}
export function agentLoopReadDenied(error: unknown): error is AgentLoopRequestError {
  return error instanceof AgentLoopRequestError && ([401, 403, 404].includes(error.status) || error.code === "authority_changed");
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
  if (!authority) throw new AgentLoopRequestError(401, message(401));
  let response: Response;
  try {
    response = await fetch("/api/agent-loops/" + path, {
      method: body === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin",
      headers: { "x-yummyai-context-authority": authority, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Closing a view cannot establish whether a submitted write committed.
      signal: body === undefined ? AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    });
  } catch { throw new AgentLoopRequestError(0, message(0)); }
  const reader = response.body?.getReader();
  if (!reader) throw new AgentLoopRequestError(response.ok ? 502 : response.status, message(response.ok ? 502 : response.status));
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > (response.ok ? 8 * 1024 * 1024 : 8192)) { await reader.cancel(); throw new Error("size"); }
      chunks.push(part.value);
    }
  } catch { throw new AgentLoopRequestError(response.ok ? 502 : response.status, message(response.ok ? 502 : response.status)); }
  finally { reader.releaseLock(); }
  let raw: unknown;
  try {
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new AgentLoopRequestError(response.ok ? 502 : response.status, message(response.ok ? 502 : response.status)); }
  if (!response.ok) {
    const code = response.status === 409 && raw !== null && typeof raw === "object" && "code" in raw && raw.code === "authority_changed" ? "authority_changed" : null;
    throw new AgentLoopRequestError(response.status, message(response.status, code), code);
  }
  if (response.headers.get("x-yummyai-context-authority") !== authority)
    throw new AgentLoopRequestError(409, message(409, "authority_changed"), "authority_changed");
  const parsed = schema.safeParse(raw);
  if (response.status !== expectedStatus || !parsed.success)
    throw new AgentLoopRequestError(502, "原响应结构或状态无法核对 未采用替代数据 请保留原任务编号");
  if (parsed.data.contextAuthority !== authority)
    throw new AgentLoopRequestError(409, message(409, "authority_changed"), "authority_changed");
  return parsed.data;
}
const runId = (value: string) => {
  const parsed = z.uuidv7().safeParse(value);
  if (!parsed.success) throw new AgentLoopRequestError(400, "请填写真实有效的 Agent 任务 ID");
  return parsed.data.toLowerCase();
};
export async function readAgentLoopWorkspace(authority: string, signal?: AbortSignal) {
  const result = await request("workspace", AgentLoopWorkspaceSchema, authority, 200, undefined, signal);
  if (result.readWorkspace.contextAuthority !== authority)
    throw new AgentLoopRequestError(409, message(409, "authority_changed"), "authority_changed");
  return result;
}
export async function readAgentLoopRun(id: string, authority: string, signal?: AbortSignal) {
  const expected = runId(id), result = await request("runs/" + expected, AgentLoopRunViewSchema, authority, 200, undefined, signal);
  if (result.id !== expected) throw new AgentLoopRequestError(502, "原任务身份无法核对 未采用其他任务的资料");
  return result;
}
export async function readAgentLoopReceipt(input: { requestId: string; requestChecksum: string }, authority: string, signal?: AbortSignal) {
  const parsed = AgentLoopReceiptQuerySchema.safeParse(input);
  if (!parsed.success) throw new AgentLoopRequestError(400, "原请求标识无效 未读取替代请求");
  const result = await request("receipts?" + new URLSearchParams(parsed.data), AgentLoopReceiptSchema, authority, 200, undefined, signal);
  assertReceipt(result, parsed.data);
  return result;
}
function assertReceipt(result: AgentLoopReceipt, expected: { requestId: string; requestChecksum: string }) {
  if (result.requestId !== expected.requestId || result.requestChecksum !== expected.requestChecksum)
    throw new AgentLoopRequestError(502, "原请求回执身份或校验值不匹配 未登记替代结果");
}
export async function createAgentLoop(raw: CreateAgentLoop, authority: string) {
  const parsed = CreateAgentLoopSchema.safeParse(raw);
  if (!parsed.success) throw new AgentLoopRequestError(400, message(400));
  const digest = crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(parsed.data)));
  // No asynchronous gap between the caller's final identity check and fetch.
  const [result, hash] = await Promise.all([request("runs", AgentLoopRunViewSchema, authority, 201, parsed.data), digest]);
  const requestChecksum = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  if (result.requestId !== parsed.data.requestId || result.requestChecksum !== requestChecksum)
    throw new AgentLoopRequestError(502, "已提交请求的回执无法绑定 请保留原请求标识并只读核对");
  return result;
}
export async function stopAgentLoop(id: string, raw: z.infer<typeof StopAgentLoopSchema>, authority: string) {
  const expected = runId(id), parsed = StopAgentLoopSchema.safeParse(raw);
  if (!parsed.success) throw new AgentLoopRequestError(400, message(400));
  const result = await request("runs/" + expected + "/stop", AgentLoopReceiptSchema, authority, 200, parsed.data);
  if (result.disposition !== "known" || result.runId !== expected || result.requestId !== parsed.data.requestId)
    throw new AgentLoopRequestError(502, "停止请求的原任务身份无法核对 请读取原回执 不推断已停止");
  return result;
}
export function assertAgentLoopRunReceipt(run: AgentLoopRunView, receipt: AgentLoopReceipt) {
  assertReceipt(receipt, run);
  if (receipt.disposition !== "known" || receipt.runId !== run.id)
    throw new AgentLoopRequestError(502, "原回执与读取的任务不一致 未采用替代资料");
}
