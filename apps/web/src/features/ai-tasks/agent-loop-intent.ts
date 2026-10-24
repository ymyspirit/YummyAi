"use client";
import { useCallback, useEffect, useState } from "react";
import {
  AGENT_LOOP_INTENT_CLEAR_EVENT, AGENT_LOOP_INTENT_PREFIX, AgentLoopIntentSchema,
  CreateAgentLoopSchema, type AgentLoopIntent, type CreateAgentLoop,
} from "@yummyai/contracts/ai/agent-loop";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AgentLoopRequestError } from "./agent-loop-client";

export { AGENT_LOOP_INTENT_CLEAR_EVENT, AGENT_LOOP_INTENT_PREFIX };
export const AGENT_LOOP_INTENT_EVENT = "yummyai.agent-loop-intents-changed";
export async function agentLoopHash(text: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
export const agentLoopOwnerScope = (preferenceScope: string) => agentLoopHash(preferenceScope);
export const agentLoopRequestChecksum = (input: CreateAgentLoop) => agentLoopHash(canonicalJson(CreateAgentLoopSchema.parse(input)));
const storageKey = (value: Pick<AgentLoopIntent, "ownerScope" | "requestId">) => AGENT_LOOP_INTENT_PREFIX + value.ownerScope + ":" + value.requestId;
function changed() { window.dispatchEvent(new Event(AGENT_LOOP_INTENT_EVENT)); }
export function readAgentLoopIntents(ownerScope: string): AgentLoopIntent[] {
  if (!/^[a-f0-9]{64}$/.test(ownerScope)) throw new AgentLoopRequestError(400, "本人原请求作用域无效 本次不发起新任务");
  const values: AgentLoopIntent[] = [];
  try {
    const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).filter((key): key is string => Boolean(key?.startsWith(AGENT_LOOP_INTENT_PREFIX + ownerScope + ":")));
    for (const key of keys) {
      const text = sessionStorage.getItem(key); let raw: unknown;
      try { raw = text && text.length <= 4096 ? JSON.parse(text) : null; } catch { raw = null; }
      const parsed = AgentLoopIntentSchema.safeParse(raw);
      if (!parsed.success || parsed.data.ownerScope !== ownerScope || storageKey(parsed.data) !== key || parsed.data.state === "known" && !parsed.data.runId) {
        sessionStorage.removeItem(key); continue;
      }
      values.push(parsed.data);
    }
  } catch { throw new AgentLoopRequestError(0, "浏览器无法核对原请求标识 本次不发起新的付费任务"); }
  return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.requestId.localeCompare(b.requestId));
}
function persist(value: AgentLoopIntent) {
  try {
    const key = storageKey(value), text = JSON.stringify(value);
    sessionStorage.setItem(key, text);
    if (sessionStorage.getItem(key) !== text) throw new Error("storage");
  } catch { throw new AgentLoopRequestError(0, "原请求标识未能可靠保存 本次不发送 请检查浏览器存储"); }
  changed(); return value;
}
/** New paid requests must first establish exactly one verified, scalar marker. */
export function saveAgentLoopIntent(raw: AgentLoopIntent) {
  const parsed = AgentLoopIntentSchema.safeParse(raw);
  if (!parsed.success || parsed.data.state !== "prepared" || parsed.data.runId !== null)
    throw new AgentLoopRequestError(400, "新的原请求标识无效 本次未发送");
  const prior = readAgentLoopIntents(parsed.data.ownerScope);
  if (prior.length) throw new AgentLoopRequestError(409, "本人仍有原 Agent 请求待核对 请先读取原回执或明确另起任务");
  return persist(parsed.data);
}
/** A late response must never recreate a marker already removed on logout. */
export function updateAgentLoopIntent(raw: AgentLoopIntent) {
  const parsed = AgentLoopIntentSchema.safeParse(raw);
  if (!parsed.success || parsed.data.state === "known" && !parsed.data.runId)
    throw new AgentLoopRequestError(400, "原请求标识结构无效 未记录替代回执");
  const current = readAgentLoopIntents(parsed.data.ownerScope).find(item => item.requestId === parsed.data.requestId);
  if (!current || current.requestChecksum !== parsed.data.requestChecksum || current.createdAt !== parsed.data.createdAt ||
    current.runId !== null && current.runId !== parsed.data.runId || current.state === "known" && parsed.data.state !== "known")
    throw new AgentLoopRequestError(409, "原请求标识已清除或变化 迟到响应不重建标识 请核对原回执");
  return persist(parsed.data);
}
export function forgetAgentLoopIntent(value: AgentLoopIntent) {
  const current = readAgentLoopIntents(value.ownerScope).find(item => item.requestId === value.requestId);
  if (current && (current.requestChecksum !== value.requestChecksum || current.createdAt !== value.createdAt))
    throw new AgentLoopRequestError(409, "原请求标识已变化 请重新核对后再明确另起任务");
  try {
    const key = storageKey(value); sessionStorage.removeItem(key);
    if (sessionStorage.getItem(key) !== null) throw new Error("storage");
  } catch { throw new AgentLoopRequestError(0, "原请求标识尚未清除 本次不创建第二笔任务"); }
  changed();
}
export async function prepareAgentLoopIntent(raw: CreateAgentLoop, preferenceScope: string) {
  const input = CreateAgentLoopSchema.parse(raw);
  const [ownerScope, requestChecksum] = await Promise.all([agentLoopOwnerScope(preferenceScope), agentLoopRequestChecksum(input)]);
  if (readAgentLoopIntents(ownerScope).length)
    throw new AgentLoopRequestError(409, "本人仍有原 Agent 请求待核对 不以新编号重复付费");
  const intent = AgentLoopIntentSchema.parse({ version: 1, ownerScope, requestId: input.requestId, requestChecksum, runId: null, state: "prepared", createdAt: new Date().toISOString() });
  return { input, intent };
}
export function useAgentLoopIntents(preferenceScope: string | null) {
  const [revision, setRevision] = useState(0), [state, setState] = useState<{ scope: string; ownerScope: string; markers: AgentLoopIntent[]; error: string } | null>(null);
  useEffect(() => {
    const reload = () => setRevision(value => value + 1);
    window.addEventListener(AGENT_LOOP_INTENT_EVENT, reload); window.addEventListener("storage", reload); window.addEventListener(AGENT_LOOP_INTENT_CLEAR_EVENT, reload);
    return () => { window.removeEventListener(AGENT_LOOP_INTENT_EVENT, reload); window.removeEventListener("storage", reload); window.removeEventListener(AGENT_LOOP_INTENT_CLEAR_EVENT, reload); };
  }, []);
  useEffect(() => {
    let cancelled = false; if (!preferenceScope) return;
    void agentLoopOwnerScope(preferenceScope).then(ownerScope => {
      if (cancelled) return;
      try { setState({ scope: preferenceScope, ownerScope, markers: readAgentLoopIntents(ownerScope), error: "" }); }
      catch { setState({ scope: preferenceScope, ownerScope, markers: [], error: "原请求标识暂不可核对 本次不发起新的付费任务" }); }
    }).catch(() => { if (!cancelled) setState({ scope: preferenceScope, ownerScope: "", markers: [], error: "本人原请求摘要无法核对 本次不发起新的付费任务" }); });
    return () => { cancelled = true; };
  }, [preferenceScope, revision]);
  const current = state?.scope === preferenceScope ? state : null;
  return { markers: current?.markers ?? [], ownerScope: current?.ownerScope ?? "", ready: Boolean(current && !current.error), error: current?.error ?? "",
    reload: useCallback(() => setRevision(value => value + 1), []) };
}
