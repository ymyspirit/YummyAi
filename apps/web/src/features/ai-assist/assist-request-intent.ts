"use client";
import { useCallback, useEffect, useState } from "react";
import { CreateAssistSchema, type AssistKind, type CreateAssist } from "@yummyai/contracts/ai/assist";
import { ASSIST_INTENT_PREFIX, ASSIST_INTENT_CLEAR_EVENT, AssistIntentSchema, assistRequestRecoveryText, type AssistIntent } from "@yummyai/contracts/ai/assist-recovery";
import { AssistRequestError } from "./assist-client";

export { ASSIST_INTENT_PREFIX, ASSIST_INTENT_CLEAR_EVENT };
export const ASSIST_INTENT_EVENT = "yummyai-assist-request-intents";
export async function assistIntentHash(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function assistIntentIdentity(preferenceScope: string, kind: AssistKind, scope: string) {
  const [ownerScope, taskScope] = await Promise.all([assistIntentHash(preferenceScope), assistIntentHash(kind + scope)]);
  return { ownerScope, taskScope };
}
const storageKey = (value: Pick<AssistIntent, "ownerScope" | "requestId">) => ASSIST_INTENT_PREFIX + value.ownerScope + ":" + value.requestId;
export function readAssistIntents(ownerScope: string, taskScope?: string): AssistIntent[] {
  const values: AssistIntent[] = [];
  try { for (const key of Object.keys(sessionStorage)) {
    if (!key.startsWith(ASSIST_INTENT_PREFIX + ownerScope + ":")) continue;
    const text = sessionStorage.getItem(key); let raw: unknown;
    try { raw = text && text.length <= 4096 ? JSON.parse(text) : null; } catch { raw = null; }
    const parsed = AssistIntentSchema.safeParse(raw);
    if (!parsed.success || parsed.data.ownerScope !== ownerScope || storageKey(parsed.data) !== key) { sessionStorage.removeItem(key); continue; }
    if (!taskScope || parsed.data.taskScope === taskScope) values.push(parsed.data);
  } } catch { throw new AssistRequestError(0, "浏览器无法核对原请求标识 本次不发起新的付费任务"); }
  return values;
}
export function saveAssistIntent(value: AssistIntent) {
  const parsed = AssistIntentSchema.safeParse(value); if (!parsed.success) throw new AssistRequestError(400, "原请求标识结构无效 本次未发送");
  try { const key = storageKey(parsed.data), text = JSON.stringify(parsed.data); sessionStorage.setItem(key, text);
    if (sessionStorage.getItem(key) !== text) throw new Error("storage");
  } catch { throw new AssistRequestError(0, "原请求标识未能保存 本次不发送 请检查浏览器存储后重试"); }
  window.dispatchEvent(new Event(ASSIST_INTENT_EVENT)); return parsed.data;
}
export function forgetAssistIntent(value: AssistIntent) {
  try { sessionStorage.removeItem(storageKey(value)); if (sessionStorage.getItem(storageKey(value)) !== null) throw new Error("storage"); }
  catch { throw new AssistRequestError(0, "原请求标识尚未清除 请保留原编号 不创建第二笔任务"); }
  window.dispatchEvent(new Event(ASSIST_INTENT_EVENT));
}
export function recordAssistIntentRun(value: AssistIntent, runId: string) {
  const current = readAssistIntents(value.ownerScope).find(item => item.requestId === value.requestId);
  if (!current || current.kind !== value.kind || current.taskScope !== value.taskScope || current.requestChecksum !== value.requestChecksum || current.runId !== null && current.runId !== runId)
    throw new AssistRequestError(409, "原请求标识已清除或变化 迟到响应不重建标识 请核对原回执");
  return saveAssistIntent({ ...current, runId });
}
export async function prepareAssistIntent(raw: CreateAssist, preferenceScope: string, scope: string) {
  const request = CreateAssistSchema.parse(raw);
  if (request.kind === "artwork_preflight" && request.automaticAudit)
    throw new AssistRequestError(400, "固定规则自动审稿请从订单生产稿自动核对入口处理 本处不登记新的付费请求");
  const identity = await assistIntentIdentity(preferenceScope, request.kind, scope);
  if (readAssistIntents(identity.ownerScope).some(item => item.taskScope === identity.taskScope || item.kind === request.kind && item.runId === null)) throw new AssistRequestError(409, "此对象仍有原请求待核对 请先读取原回执 不以新编号重复付费");
  const requestChecksum = await assistIntentHash(assistRequestRecoveryText(request));
  return { request, intent: AssistIntentSchema.parse({ version: 1, ...identity, kind: request.kind, requestId: request.requestId, requestChecksum, runId: null }) };
}
/** Only IDs and hashes survive refresh. All receipt reads use current authority. */
export function useAssistIntentMarkers(preferenceScope: string | null, kind?: AssistKind, scope?: string) {
  const [revision, setRevision] = useState(0), [state, setState] = useState<{ key: string; ownerScope: string; taskScope: string | null; markers: AssistIntent[]; error: string } | null>(null);
  const key = JSON.stringify([preferenceScope, kind ?? null, scope ?? null]);
  useEffect(() => {
    const changed = () => setRevision(value => value + 1); window.addEventListener(ASSIST_INTENT_EVENT, changed); window.addEventListener("storage", changed);
    return () => { window.removeEventListener(ASSIST_INTENT_EVENT, changed); window.removeEventListener("storage", changed); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (!preferenceScope) return;
    void Promise.all([assistIntentHash(preferenceScope), kind && scope !== undefined ? assistIntentHash(kind + scope) : Promise.resolve(null)]).then(([ownerScope, taskScope]) => {
      if (cancelled) return;
      try { setState({ key, ownerScope, taskScope, markers: readAssistIntents(ownerScope), error: "" }); }
      catch { setState({ key, ownerScope, taskScope, markers: [], error: "原请求恢复标识暂不可读取 本次不发起新付费任务" }); }
    }).catch(() => { if (!cancelled) setState({ key, ownerScope: "", taskScope: null, markers: [], error: "原请求摘要无法计算 本次不发起新付费任务" }); });
    return () => { cancelled = true; };
  }, [preferenceScope, kind, scope, key, revision]);
  const current = state?.key === key ? state : null;
  return { markers: current?.markers.filter(item => (!kind || item.kind === kind) && (!current.taskScope || item.taskScope === current.taskScope)) ?? [], allMarkers: current?.markers ?? [], ownerScope: current?.ownerScope ?? "", taskScope: current?.taskScope ?? null, error: current?.error ?? "",
    ready: Boolean(preferenceScope && current), reload: useCallback(() => setRevision(value => value + 1), []) };
}
