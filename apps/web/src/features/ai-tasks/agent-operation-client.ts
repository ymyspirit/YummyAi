"use client";
import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import {
  AGENT_COMMAND_MAX_BYTES, AdoptAgentCommandSchema, AgentCommandIntentSchema, AgentCommandReceiptQuerySchema,
  AgentCommandReceiptSchema, AgentCommandViewSchema, AgentCommandWorkspaceSchema, CancelAgentCommandSchema,
  ConfirmAgentCommandSchema, canonicalAgentCommandOriginal, canonicalAgentCommandRequest,
  type AdoptAgentCommand, type AgentCommandIntent, type AgentCommandView,
} from "@yummyai/contracts/ai/agent-command";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";

export { ASSIST_INTENT_CLEAR_EVENT as AGENT_OPERATION_CLEAR_EVENT };
export const AGENT_OPERATION_INTENT_PREFIX = "yummyai.agent-operation.intent.v1:";
export const AGENT_OPERATION_INTENT_EVENT = "yummyai.agent-operation-intents-changed";
export class AgentOperationRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: "authority_changed" | null = null) { super(message); }
}
export const agentOperationDenied = (failure: unknown) => failure instanceof AgentOperationRequestError && ([401, 403, 404].includes(failure.status) || failure.code === "authority_changed");
export const agentOperationError = (failure: unknown) => failure instanceof AgentOperationRequestError ? failure.message : "原操作响应暂不可核对 请只读取原回执 不重复提交";
function errorMessage(status: number, changed = false) {
  return changed ? "当前本人身份或权限已变化 原私文和确认已隐藏 请重新核对" : status === 401 ? "请登录自己的运营账户" :
    status === 403 || status === 404 ? "当前无法读取或处理这笔本人原操作" : status === 400 || status === 422 ? "原操作或固定业务依据未通过核对 请读取原提交" :
      status === 409 ? "原版本 依据或确认凭据有冲突 请重新读取原请求 不改键重放" : "本次响应无法确认 原操作可能已登记 请只读取原请求 不重复提交";
}
async function jsonRequest<T extends { contextAuthority: string }>(path: string, schema: z.ZodType<T>, authority: string, expectedStatus: number, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!authority) throw new AgentOperationRequestError(401, errorMessage(401));
  let response: Response;
  try { response = await fetch("/api/agent-commands/" + path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
    headers: { "x-yummyai-context-authority": authority, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body),
    signal: body === undefined ? AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) }); }
  catch { throw new AgentOperationRequestError(0, errorMessage(0)); }
  const reader = response.body?.getReader(); if (!reader) throw new AgentOperationRequestError(response.ok ? 502 : response.status, errorMessage(response.ok ? 502 : response.status));
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
    if (size > (response.ok ? AGENT_COMMAND_MAX_BYTES : 8192)) { await reader.cancel(); throw new Error("size"); } chunks.push(part.value); } }
  catch { throw new AgentOperationRequestError(response.ok ? 502 : response.status, errorMessage(response.ok ? 502 : response.status)); }
  finally { reader.releaseLock(); }
  let raw: unknown;
  try { const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; } raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new AgentOperationRequestError(response.ok ? 502 : response.status, errorMessage(response.ok ? 502 : response.status)); }
  if (!response.ok) {
    const changed = response.status === 409 && !!raw && typeof raw === "object" && "code" in raw && raw.code === "authority_changed";
    throw new AgentOperationRequestError(response.status, errorMessage(response.status, changed), changed ? "authority_changed" : null);
  }
  const parsed = schema.safeParse(raw);
  if (response.status !== expectedStatus || !parsed.success) throw new AgentOperationRequestError(502, "原响应结构或状态无法核对 请保留原编号并重新读取");
  if (response.headers.get("x-yummyai-context-authority") !== authority || parsed.data.contextAuthority !== authority)
    throw new AgentOperationRequestError(409, errorMessage(409, true), "authority_changed");
  return parsed.data;
}
const id = (raw: string) => { const parsed = EntityIdSchema.safeParse(raw); if (!parsed.success) throw new AgentOperationRequestError(400, "请填写真实有效的 Agent 操作 ID"); return parsed.data.toLowerCase(); };
export const readAgentOperationWorkspace = (authority: string, signal?: AbortSignal) => jsonRequest("workspace", AgentCommandWorkspaceSchema, authority, 200, undefined, signal);
export async function readAgentOperationRequest(value: string, authority: string, signal?: AbortSignal) {
  const expected = id(value), result = await jsonRequest("requests/" + expected, AgentCommandViewSchema, authority, 200, undefined, signal);
  if (result.id !== expected) throw new AgentOperationRequestError(502, "原操作 ID 与响应不一致 未采用替代记录");
  await verifyView(result);
  return result;
}
export async function readAgentOperationReceipt(input: { requestId: string; requestChecksum: string }, authority: string, signal?: AbortSignal) {
  const query = AgentCommandReceiptQuerySchema.parse(input), result = await jsonRequest("receipts?" + new URLSearchParams(query), AgentCommandReceiptSchema, authority, 200, undefined, signal);
  if (result.requestId !== query.requestId || result.requestChecksum !== query.requestChecksum) throw new AgentOperationRequestError(502, "原请求回执与原编号或校验值不一致");
  return result;
}
export async function adoptAgentOperation(raw: AdoptAgentCommand, authority: string) {
  const input = AdoptAgentCommandSchema.parse(raw), digest = agentOperationRequestChecksum("adopt", input);
  const [value, checksum] = await Promise.all([jsonRequest("adopt", AgentCommandViewSchema, authority, 201, input), digest]);
  if (value.requestId !== input.requestId || value.requestChecksum !== checksum || value.domain !== input.reference.domain || value.ownerCommandId !== input.reference.commandId ||
    value.snapshot && value.snapshot.reference.accountId !== input.reference.accountId)
    throw new AgentOperationRequestError(502, "交接回执未绑定原请求与原业务凭据 请只读核对原请求");
  await verifyView(value);
  return value;
}
export async function actOnAgentOperation(value: AgentCommandView, action: "confirm" | "cancel" | "acknowledge", authority: string) {
  if (!value.ownerCommandId) throw new AgentOperationRequestError(409, "原业务准备凭据尚未取得 请重新读取原请求");
  const body = action === "confirm" ? ConfirmAgentCommandSchema.parse({ version: value.version, requestId: value.requestId, ownerCommandId: value.ownerCommandId,
    originalChecksum: value.originalChecksum, confirmationToken: value.confirmationToken, decision: "execute_original" }) :
    CancelAgentCommandSchema.parse({ version: value.version, requestId: value.requestId, ownerCommandId: value.ownerCommandId });
  const result = await jsonRequest("requests/" + id(value.id) + "/" + action, AgentCommandViewSchema, authority, 200, body);
  if (result.id !== value.id || result.requestId !== value.requestId || result.requestChecksum !== value.requestChecksum || result.ownerCommandId !== value.ownerCommandId || result.domain !== value.domain || result.kind !== value.kind)
    throw new AgentOperationRequestError(502, "处理回执与原操作身份不一致 请只读取原请求 不重复执行");
  await verifyView(result);
  return result;
}
async function verifyView(value: AgentCommandView) {
  if (value.snapshot && value.snapshot.native.view.kind !== value.kind || value.snapshot?.original &&
    (!value.originalChecksum || await agentOperationHash(canonicalAgentCommandOriginal(value.snapshot.original)) !== value.originalChecksum))
    throw new AgentOperationRequestError(502, "原业务类型或完整原文校验值不一致 已停止确认与采用");
}
export async function agentOperationHash(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}
export const agentOperationRequestChecksum = (operation: "adopt" | "prepare", raw: unknown) => agentOperationHash(canonicalAgentCommandRequest(operation, raw));
const storageKey = (value: Pick<AgentCommandIntent, "ownerScope" | "requestId">) => AGENT_OPERATION_INTENT_PREFIX + value.ownerScope + ":" + value.requestId;
function changed() { window.dispatchEvent(new Event(AGENT_OPERATION_INTENT_EVENT)); }
export function readAgentOperationIntents(ownerScope: string): AgentCommandIntent[] {
  if (!/^[a-f0-9]{64}$/.test(ownerScope)) throw new AgentOperationRequestError(400, "本人原请求作用域无效 本次不交接新操作");
  const values: AgentCommandIntent[] = [];
  try { const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).filter((key): key is string => Boolean(key?.startsWith(AGENT_OPERATION_INTENT_PREFIX + ownerScope + ":")));
    for (const key of keys) {
      const text = sessionStorage.getItem(key); let raw: unknown; try { raw = text && text.length <= 4096 ? JSON.parse(text) : null; } catch { raw = null; }
      const parsed = AgentCommandIntentSchema.safeParse(raw);
      if (!parsed.success || parsed.data.ownerScope !== ownerScope || storageKey(parsed.data) !== key || parsed.data.state === "known" && !parsed.data.id) { sessionStorage.removeItem(key); continue; }
      values.push(parsed.data);
    }
  } catch { throw new AgentOperationRequestError(0, "浏览器无法核对原请求标识 本次不交接新操作"); }
  return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function store(value: AgentCommandIntent) {
  try { const text = JSON.stringify(value), key = storageKey(value); sessionStorage.setItem(key, text); if (sessionStorage.getItem(key) !== text) throw new Error("storage"); }
  catch { throw new AgentOperationRequestError(0, "原请求标识未能保存并核对 本次不发送 请检查浏览器存储"); }
  changed(); return value;
}
export function saveAgentOperationIntent(raw: AgentCommandIntent) {
  const value = AgentCommandIntentSchema.parse(raw), prior = readAgentOperationIntents(value.ownerScope);
  if (value.state !== "prepared" || value.id || prior.some(row => row.state !== "known" || row.requestId === value.requestId))
    throw new AgentOperationRequestError(409, "本人仍有结果未知的原交接 请先只读核对 不换键或重复提交");
  return store(value);
}
export function updateAgentOperationIntent(raw: AgentCommandIntent) {
  const value = AgentCommandIntentSchema.parse(raw), current = readAgentOperationIntents(value.ownerScope).find(row => row.requestId === value.requestId);
  if (!current || current.createdAt !== value.createdAt || current.requestChecksum !== value.requestChecksum || current.id !== null && current.id !== value.id ||
    value.state === "known" && !value.id || current.state === "known" && value.state !== "known")
    throw new AgentOperationRequestError(409, "原标识已清除或变化 迟到响应不重建原标识");
  return store(value);
}
export function forgetAgentOperationIntent(marker: AgentCommandIntent) {
  const current = readAgentOperationIntents(marker.ownerScope).find(row => row.requestId === marker.requestId);
  if (current && current.requestChecksum !== marker.requestChecksum) throw new AgentOperationRequestError(409, "原标识已变化 请重新核对");
  try { const key = storageKey(marker); sessionStorage.removeItem(key); if (sessionStorage.getItem(key) !== null) throw new Error("storage"); }
  catch { throw new AgentOperationRequestError(0, "原恢复标识尚未清除 请保留原编号"); }
  changed();
}
export async function prepareAgentOperationIntent(raw: AdoptAgentCommand, preferenceScope: string) {
  const input = AdoptAgentCommandSchema.parse(raw), [ownerScope, requestChecksum] = await Promise.all([agentOperationHash(preferenceScope), agentOperationRequestChecksum("adopt", input)]);
  if (readAgentOperationIntents(ownerScope).some(value => value.state !== "known")) throw new AgentOperationRequestError(409, "本人有原交接结果待核对 请先只读原回执 不创建新键");
  return { input, intent: AgentCommandIntentSchema.parse({ version: 1, ownerScope, requestId: input.requestId, requestChecksum, id: null, state: "prepared", createdAt: new Date().toISOString() }) };
}
export function useAgentOperationIntents(preferenceScope: string | null) {
  const [revision, setRevision] = useState(0), [snapshot, setSnapshot] = useState<{ scope: string; ownerScope: string; markers: AgentCommandIntent[]; error: string } | null>(null);
  useEffect(() => { const reload = () => setRevision(value => value + 1); window.addEventListener(AGENT_OPERATION_INTENT_EVENT, reload); window.addEventListener("storage", reload); window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, reload);
    return () => { window.removeEventListener(AGENT_OPERATION_INTENT_EVENT, reload); window.removeEventListener("storage", reload); window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, reload); }; }, []);
  useEffect(() => { let cancelled = false; if (!preferenceScope) return;
    void agentOperationHash(preferenceScope).then(ownerScope => { if (cancelled) return; try { setSnapshot({ scope: preferenceScope, ownerScope, markers: readAgentOperationIntents(ownerScope), error: "" }); }
      catch { setSnapshot({ scope: preferenceScope, ownerScope, markers: [], error: "原恢复标识暂不可核对 本次不发送新交接" }); } }).catch(() => { if (!cancelled) setSnapshot({ scope: preferenceScope, ownerScope: "", markers: [], error: "本人原请求摘要无法计算 本次不发送新交接" }); });
    return () => { cancelled = true; }; }, [preferenceScope, revision]);
  const value = snapshot?.scope === preferenceScope ? snapshot : null;
  return { markers: value?.markers ?? [], ownerScope: value?.ownerScope ?? "", ready: Boolean(value && !value.error), error: value?.error ?? "", reload: useCallback(() => setRevision(value => value + 1), []) };
}
