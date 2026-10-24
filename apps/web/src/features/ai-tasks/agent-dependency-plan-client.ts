"use client";
import type { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { agentTransportTextHash } from "@yummyai/contracts/ai/agent-transport";
import { AGENT_COMMAND_VERSION, canonicalAgentCommandOriginal, canonicalAgentCommandRequest } from "@yummyai/contracts/ai/agent-command";
import {
  AGENT_DEPENDENCY_PLAN_INTENT_PREFIX,
  CreateAgentDependencyPlanSchema, PrepareAgentDependencyPlanSchema, CancelAgentDependencyPlanSchema,
  AgentDependencyPlanWorkspaceSchema, AgentDependencyPlanViewSchema, AgentDependencyPlanPageSchema,
  AgentDependencyPlanListQuerySchema, AgentDependencyPlanReceiptQuerySchema, AgentDependencyPlanReceiptSchema,
  AgentDependencyPlanIntentSchema, canonicalAgentDependencyPlanRequest, agentDependencyPlanSourcePayload,
  type CreateAgentDependencyPlan, type AgentDependencyPlanView, type AgentDependencyPlanIntent,
} from "@yummyai/contracts/ai/agent-dependency-plan";

export const AGENT_DEPENDENCY_PLAN_INTENT_EVENT = "yummyai.agent-dependency-plan-intents-changed";
export type DependencyPlanReadOptions = { signal?: AbortSignal; isCurrent?(): boolean };
export class AgentDependencyPlanRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: "authority_changed" | null = null) { super(message); }
}
export const agentDependencyPlanDenied = (error: unknown) => error instanceof AgentDependencyPlanRequestError
  && ([401, 403, 404].includes(error.status) || error.code === "authority_changed");
export const agentDependencyPlanError = (error: unknown) => error instanceof AgentDependencyPlanRequestError
  ? error.message : "原计划响应尚未核对 请只读原回执 不重复登记或准备";
function failureText(status: number, changed = false) {
  return changed ? "当前本人身份或权限已变化 原计划私文已隐藏 请重新核对当前授权"
    : status === 401 ? "请先登录自己的 ERP 账户"
      : status === 403 || status === 404 ? "当前无法读取或处理这笔本人原计划 请核对原任务与权限"
        : status === 400 || status === 422 ? "固定原请求未通过核对 请检查原目标和到期时间"
          : status === 409 ? "原依赖 来源或版本已变化 请只读原计划 不替换原请求"
            : "本次响应无法确认 原计划或准备可能已经登记 请只读取原请求";
}
function assertCurrent(options: DependencyPlanReadOptions) {
  if (options.isCurrent && !options.isCurrent()) throw new AgentDependencyPlanRequestError(409, failureText(409, true), "authority_changed");
}
const id = (value: string) => {
  const result = EntityIdSchema.safeParse(value);
  if (!result.success) throw new AgentDependencyPlanRequestError(400, "请填写真实有效的原计划 ID");
  return result.data.toLowerCase();
};
async function request<T extends { contextAuthority: string }>(path: string, schema: z.ZodType<T>, authority: string,
  expectedStatus: number, options: DependencyPlanReadOptions, body?: unknown): Promise<T> {
  if (!authority) throw new AgentDependencyPlanRequestError(401, failureText(401));
  assertCurrent(options);
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(30_000)]);
  let response: Response;
  try {
    response = await fetch("/api/agent-dependency-plans" + path, { method: body === undefined ? "GET" : "POST",
      credentials: "same-origin", cache: "no-store", redirect: "error", signal,
      headers: { "x-yummyai-context-authority": authority, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { assertCurrent(options); throw new AgentDependencyPlanRequestError(0, failureText(0)); }
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
  if (!reader) throw new AgentDependencyPlanRequestError(response.ok ? 502 : response.status, failureText(response.ok ? 502 : response.status));
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > (response.ok ? 8 * 1024 * 1024 : 8192)) { await reader.cancel(); throw new Error("size"); }
      chunks.push(part.value);
    }
  } catch { assertCurrent(options); throw new AgentDependencyPlanRequestError(response.ok ? 502 : response.status, failureText(response.ok ? 502 : response.status)); }
  finally { reader.releaseLock(); }
  assertCurrent(options);
  let raw: unknown;
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error("type");
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new AgentDependencyPlanRequestError(response.ok ? 502 : response.status, failureText(response.ok ? 502 : response.status)); }
  if (!response.ok) {
    const changed = response.status === 409 && raw !== null && typeof raw === "object" && "code" in raw && raw.code === "authority_changed";
    throw new AgentDependencyPlanRequestError(response.status, failureText(response.status, changed), changed ? "authority_changed" : null);
  }
  const parsed = schema.safeParse(raw);
  if (response.status !== expectedStatus || !parsed.success) throw new AgentDependencyPlanRequestError(502, "原计划响应结构或状态无法核对 请保留原编号并重新读取");
  if (response.headers.get("x-yummyai-context-authority") !== authority || parsed.data.contextAuthority !== authority)
    throw new AgentDependencyPlanRequestError(409, failureText(409, true), "authority_changed");
  assertCurrent(options); return parsed.data;
}
async function verifyView(value: AgentDependencyPlanView, options: DependencyPlanReadOptions) {
  if (value.source && await agentTransportTextHash(canonicalJson(agentDependencyPlanSourcePayload(value.source))) !== value.source.sourceChecksum)
    throw new AgentDependencyPlanRequestError(502, "原采购发票来源校验值不一致 未采用该来源");
  if (value.childDraft) {
    const originalChecksum = await agentTransportTextHash(canonicalAgentCommandOriginal(value.childDraft));
    const preparationChecksum = await agentTransportTextHash(canonicalAgentCommandRequest("prepare", {
      version: AGENT_COMMAND_VERSION, requestId: value.childRequestId, original: value.childDraft,
    }));
    if (value.childOriginalChecksum !== null && value.childOriginalChecksum !== originalChecksum
      || value.childPreparationRequestChecksum !== null && value.childPreparationRequestChecksum !== preparationChecksum)
      throw new AgentDependencyPlanRequestError(502, "后继原准备与固定草稿校验值不一致 请只读原回执");
  }
  assertCurrent(options);
}
export const readAgentDependencyPlanWorkspace = (authority: string, options: DependencyPlanReadOptions = {}) =>
  request("/workspace", AgentDependencyPlanWorkspaceSchema, authority, 200, options);
export async function readAgentDependencyPlanPage(raw: unknown, authority: string, options: DependencyPlanReadOptions = {}) {
  const query = AgentDependencyPlanListQuerySchema.parse(raw), parameters = new URLSearchParams({ limit: String(query.limit) });
  if (query.before) parameters.set("before", query.before); if (query.upperId) parameters.set("upperId", query.upperId);
  const page = await request("/requests?" + parameters.toString(), AgentDependencyPlanPageSchema, authority, 200, options);
  if (page.limit !== query.limit || query.upperId && page.upperId !== query.upperId || page.items.some((item, index) =>
    page.upperId !== null && item.id > page.upperId || query.before && item.id >= query.before || index > 0 && item.id >= page.items[index - 1]!.id)
    || page.hasMore && (!page.items.length || page.nextBefore !== page.items.at(-1)!.id))
    throw new AgentDependencyPlanRequestError(502, "原计划分页范围或顺序无法核对 未拼接替代记录");
  return page;
}
export async function readAgentDependencyPlan(value: string, authority: string, options: DependencyPlanReadOptions = {}) {
  const expected = id(value), result = await request("/requests/" + expected, AgentDependencyPlanViewSchema, authority, 200, options);
  if (result.id !== expected) throw new AgentDependencyPlanRequestError(502, "响应对应另一笔原计划 未采用替代任务");
  await verifyView(result, options); return result;
}
export async function readAgentDependencyPlanReceipt(raw: unknown, authority: string, options: DependencyPlanReadOptions = {}) {
  const input = AgentDependencyPlanReceiptQuerySchema.parse(raw);
  const result = await request("/receipts?" + new URLSearchParams(input), AgentDependencyPlanReceiptSchema, authority, 200, options);
  if (result.requestId !== input.requestId || result.requestChecksum !== input.requestChecksum)
    throw new AgentDependencyPlanRequestError(502, "原回执与请求 ID 或校验值不同 未采用替代计划");
  return result;
}
export async function createAgentDependencyPlan(raw: unknown, authority: string, options: DependencyPlanReadOptions = {}) {
  const input = CreateAgentDependencyPlanSchema.parse(raw), checksum = await agentTransportTextHash(canonicalAgentDependencyPlanRequest(input));
  assertCurrent(options);
  const result = await request("/requests", AgentDependencyPlanViewSchema, authority, 201, options, input);
  if (result.requestId !== input.requestId || result.requestChecksum !== checksum || result.parentAgentCommandId !== input.parentAgentCommandId || result.dueAt !== input.dueAt)
    throw new AgentDependencyPlanRequestError(502, "计划回执未绑定本次固定父命令与到期时间 请只读原请求");
  await verifyView(result, options); return result;
}
export async function actOnAgentDependencyPlan(value: AgentDependencyPlanView, action: "prepare" | "cancel", authority: string, options: DependencyPlanReadOptions = {}) {
  if (action === "prepare" && !value.source) throw new AgentDependencyPlanRequestError(409, "尚无可核对的原发票来源 不准备后继命令");
  const input = action === "prepare"
    ? PrepareAgentDependencyPlanSchema.parse({ version: value.version, requestId: value.requestId, sourceChecksum: value.source?.sourceChecksum })
    : CancelAgentDependencyPlanSchema.parse({ version: value.version, requestId: value.requestId });
  const result = await request("/requests/" + id(value.id) + "/" + action, AgentDependencyPlanViewSchema, authority, action === "prepare" ? 201 : 200, options, input);
  if (result.id !== value.id || result.requestId !== value.requestId || result.requestChecksum !== value.requestChecksum || result.parentAgentCommandId !== value.parentAgentCommandId)
    throw new AgentDependencyPlanRequestError(502, "处理回执与这笔原计划不一致 请只读原任务 不重复提交");
  await verifyView(result, options); return result;
}

const intentKey = (intent: Pick<AgentDependencyPlanIntent, "ownerScope" | "requestId">) => AGENT_DEPENDENCY_PLAN_INTENT_PREFIX + intent.ownerScope + ":" + intent.requestId;
function changed() { window.dispatchEvent(new Event(AGENT_DEPENDENCY_PLAN_INTENT_EVENT)); }
export function readAgentDependencyPlanIntents(ownerScope: string): AgentDependencyPlanIntent[] {
  if (!/^[a-f0-9]{64}$/.test(ownerScope)) throw new AgentDependencyPlanRequestError(400, "本人请求作用域无效 本次不登记计划");
  const values: AgentDependencyPlanIntent[] = [];
  try {
    const names = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
      .filter((name): name is string => Boolean(name?.startsWith(AGENT_DEPENDENCY_PLAN_INTENT_PREFIX + ownerScope + ":")));
    for (const name of names) {
      const text = sessionStorage.getItem(name), parsed = AgentDependencyPlanIntentSchema.safeParse(text && text.length <= 4096 ? JSON.parse(text) : null);
      if (!parsed.success || parsed.data.ownerScope !== ownerScope || intentKey(parsed.data) !== name
        || ["known", "prepare_unknown", "cancel_unknown"].includes(parsed.data.state) && parsed.data.planId === null)
        throw new Error("invalid");
      values.push(parsed.data);
    }
  } catch { throw new AgentDependencyPlanRequestError(0, "本人原请求标识暂不可核对 不登记新的计划 请保留浏览器原标识"); }
  return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.requestId.localeCompare(b.requestId));
}
function persist(intent: AgentDependencyPlanIntent) {
  try { const key = intentKey(intent), text = JSON.stringify(intent); sessionStorage.setItem(key, text); if (sessionStorage.getItem(key) !== text) throw new Error("storage"); }
  catch { throw new AgentDependencyPlanRequestError(0, "原请求标识未能可靠保存 本次不提交 请核对浏览器存储"); }
  changed(); return intent;
}
export async function prepareAgentDependencyPlanIntent(raw: unknown, preferenceScope: string) {
  const input: CreateAgentDependencyPlan = CreateAgentDependencyPlanSchema.parse(raw);
  const [ownerScope, requestChecksum] = await Promise.all([agentTransportTextHash(preferenceScope), agentTransportTextHash(canonicalAgentDependencyPlanRequest(input))]);
  if (readAgentDependencyPlanIntents(ownerScope).some(value => value.state !== "known"))
    throw new AgentDependencyPlanRequestError(409, "本人仍有原提交或准备待核对 请先只读原回执 不更换请求键");
  return { input, intent: AgentDependencyPlanIntentSchema.parse({ version: 1, ownerScope, requestId: input.requestId, requestChecksum, planId: null, state: "prepared", createdAt: new Date().toISOString() }) };
}
export function saveAgentDependencyPlanIntent(raw: AgentDependencyPlanIntent) {
  const value = AgentDependencyPlanIntentSchema.parse(raw), prior = readAgentDependencyPlanIntents(value.ownerScope);
  if (value.state !== "prepared" || value.planId !== null || prior.some(item => item.state !== "known" || item.requestId === value.requestId))
    throw new AgentDependencyPlanRequestError(409, "本人仍有未核对的原请求 不保存替代计划标识");
  return persist(value);
}
export function updateAgentDependencyPlanIntent(raw: AgentDependencyPlanIntent) {
  const value = AgentDependencyPlanIntentSchema.parse(raw), prior = readAgentDependencyPlanIntents(value.ownerScope).find(item => item.requestId === value.requestId);
  if (!prior || prior.requestChecksum !== value.requestChecksum || prior.createdAt !== value.createdAt
    || prior.planId !== null && prior.planId !== value.planId || ["known", "prepare_unknown", "cancel_unknown"].includes(value.state) && value.planId === null)
    throw new AgentDependencyPlanRequestError(409, "原标识已清除或变化 迟到结果不能重建或替换请求");
  return persist(value);
}
export function forgetAgentDependencyPlanIntent(value: AgentDependencyPlanIntent) {
  const prior = readAgentDependencyPlanIntents(value.ownerScope).find(item => item.requestId === value.requestId);
  if (!prior || prior.state !== "known" || prior.planId !== value.planId || prior.requestChecksum !== value.requestChecksum)
    throw new AgentDependencyPlanRequestError(409, "原请求尚未核对 不清除未知标识或创建替代请求");
  try { const key = intentKey(prior); sessionStorage.removeItem(key); if (sessionStorage.getItem(key) !== null) throw new Error("storage"); }
  catch { throw new AgentDependencyPlanRequestError(0, "原恢复标识未能可靠清除 请继续保留原请求"); }
  changed();
}
