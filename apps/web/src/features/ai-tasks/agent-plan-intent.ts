"use client";
import { useCallback, useEffect, useState } from "react";
import {
  AGENT_PLAN_CLEAR_EVENT, AGENT_PLAN_INTENT_PREFIX, AgentPlanIntentSchema,
  AGENT_PLAN_PREPARATION_INTENT_PREFIX, AgentPlanPreparationIntentSchema, canonicalAgentPlanRequest,
  CreateAgentPlanSchema, type AgentPlanIntent, type CreateAgentPlan, type AgentPlanPreparationIntent,
} from "@yummyai/contracts/ai/agent-plan";
import { AgentPlanRequestError } from "./agent-plan-client";

export { AGENT_PLAN_CLEAR_EVENT, AGENT_PLAN_INTENT_PREFIX, AGENT_PLAN_PREPARATION_INTENT_PREFIX };
export const AGENT_PLAN_INTENT_EVENT = "yummyai.agent-plan-intents-changed";
export async function agentPlanHash(text: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
export const agentPlanOwnerScope = (preferenceScope: string) => agentPlanHash(preferenceScope);
export const agentPlanRequestChecksum = (input: CreateAgentPlan) => agentPlanHash(canonicalAgentPlanRequest(input));
const storageKey = (value: Pick<AgentPlanIntent, "ownerScope" | "requestId">) => AGENT_PLAN_INTENT_PREFIX + value.ownerScope + ":" + value.requestId;
function changed() { window.dispatchEvent(new Event(AGENT_PLAN_INTENT_EVENT)); }
export function readAgentPlanIntents(ownerScope: string): AgentPlanIntent[] {
  if (!/^[a-f0-9]{64}$/.test(ownerScope)) throw new AgentPlanRequestError(400, "本人原请求作用域无效 本次不发起新任务");
  const values: AgentPlanIntent[] = [];
  try {
    const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).filter((key): key is string => Boolean(key?.startsWith(AGENT_PLAN_INTENT_PREFIX + ownerScope + ":")));
    for (const key of keys) {
      const text = sessionStorage.getItem(key); let raw: unknown;
      try { raw = text && text.length <= 4096 ? JSON.parse(text) : null; } catch { raw = null; }
      const parsed = AgentPlanIntentSchema.safeParse(raw);
      if (!parsed.success || parsed.data.ownerScope !== ownerScope || storageKey(parsed.data) !== key || parsed.data.state === "known" && !parsed.data.runId) {
        sessionStorage.removeItem(key); continue;
      }
      values.push(parsed.data);
    }
  } catch { throw new AgentPlanRequestError(0, "浏览器无法核对原请求标识 本次不发起新的付费任务"); }
  return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.requestId.localeCompare(b.requestId));
}
function persist(value: AgentPlanIntent) {
  try {
    const key = storageKey(value), text = JSON.stringify(value);
    sessionStorage.setItem(key, text);
    if (sessionStorage.getItem(key) !== text) throw new Error("storage");
  } catch { throw new AgentPlanRequestError(0, "原请求标识未能可靠保存 本次不发送 请检查浏览器存储"); }
  changed(); return value;
}
/** New paid requests must first establish exactly one verified, scalar marker. */
export function saveAgentPlanIntent(raw: AgentPlanIntent) {
  const parsed = AgentPlanIntentSchema.safeParse(raw);
  if (!parsed.success || parsed.data.state !== "prepared" || parsed.data.runId !== null)
    throw new AgentPlanRequestError(400, "新的原请求标识无效 本次未发送");
  const prior = readAgentPlanIntents(parsed.data.ownerScope);
  if (prior.length) throw new AgentPlanRequestError(409, "本人仍有原 Agent 请求待核对 请先读取原回执或明确另起任务");
  return persist(parsed.data);
}
/** A late response must never recreate a marker already removed on logout. */
export function updateAgentPlanIntent(raw: AgentPlanIntent) {
  const parsed = AgentPlanIntentSchema.safeParse(raw);
  if (!parsed.success || parsed.data.state === "known" && !parsed.data.runId)
    throw new AgentPlanRequestError(400, "原请求标识结构无效 未记录替代回执");
  const current = readAgentPlanIntents(parsed.data.ownerScope).find(item => item.requestId === parsed.data.requestId);
  if (!current || current.requestChecksum !== parsed.data.requestChecksum || current.createdAt !== parsed.data.createdAt ||
    current.runId !== null && current.runId !== parsed.data.runId || current.state === "known" && parsed.data.state !== "known")
    throw new AgentPlanRequestError(409, "原请求标识已清除或变化 迟到响应不重建标识 请核对原回执");
  return persist(parsed.data);
}
export function forgetAgentPlanIntent(value: AgentPlanIntent) {
  const current = readAgentPlanIntents(value.ownerScope).find(item => item.requestId === value.requestId);
  if (current && (current.requestChecksum !== value.requestChecksum || current.createdAt !== value.createdAt))
    throw new AgentPlanRequestError(409, "原请求标识已变化 请重新核对后再明确另起任务");
  try {
    const key = storageKey(value); sessionStorage.removeItem(key);
    if (sessionStorage.getItem(key) !== null) throw new Error("storage");
  } catch { throw new AgentPlanRequestError(0, "原请求标识尚未清除 本次不创建第二笔任务"); }
  changed();
}
export async function prepareAgentPlanIntent(raw: CreateAgentPlan, preferenceScope: string) {
  const input = CreateAgentPlanSchema.parse(raw);
  const [ownerScope, requestChecksum] = await Promise.all([agentPlanOwnerScope(preferenceScope), agentPlanRequestChecksum(input)]);
  if (readAgentPlanIntents(ownerScope).length)
    throw new AgentPlanRequestError(409, "本人仍有原 Agent 请求待核对 不以新编号重复付费");
  const intent = AgentPlanIntentSchema.parse({ version: 1, ownerScope, requestId: input.requestId, requestChecksum, runId: null, state: "prepared", createdAt: new Date().toISOString() });
  return { input, intent };
}
const preparationKey = (value: Pick<AgentPlanPreparationIntent, "ownerScope" | "runId" | "itemId">) => AGENT_PLAN_PREPARATION_INTENT_PREFIX + value.ownerScope + ":" + value.runId + ":" + value.itemId;
export function readAgentPlanPreparationIntents(ownerScope: string): AgentPlanPreparationIntent[] {
  if (!/^[a-f0-9]{64}$/.test(ownerScope)) throw new AgentPlanRequestError(400, "本人原准备作用域无效");
  const result: AgentPlanPreparationIntent[] = [];
  try {
    const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).filter((key): key is string => Boolean(key?.startsWith(AGENT_PLAN_PREPARATION_INTENT_PREFIX + ownerScope + ":")));
    for (const key of keys) {
      const text = sessionStorage.getItem(key); let raw: unknown; try { raw = text && text.length <= 4096 ? JSON.parse(text) : null; } catch { raw = null; }
      const parsed = AgentPlanPreparationIntentSchema.safeParse(raw);
      if (!parsed.success || parsed.data.ownerScope !== ownerScope || preparationKey(parsed.data) !== key) { sessionStorage.removeItem(key); continue; }
      result.push(parsed.data);
    }
  } catch { throw new AgentPlanRequestError(0, "无法核对本人的原准备标识 本次不准备业务"); }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.itemId.localeCompare(b.itemId));
}
function persistPreparation(value: AgentPlanPreparationIntent) {
  try { const key = preparationKey(value), text = JSON.stringify(value); sessionStorage.setItem(key, text); if (sessionStorage.getItem(key) !== text) throw new Error("storage"); }
  catch { throw new AgentPlanRequestError(0, "原准备标识保存失败 本次不发送"); }
  changed(); return value;
}
export function saveAgentPlanPreparationIntent(raw: AgentPlanPreparationIntent) {
  const value = AgentPlanPreparationIntentSchema.parse(raw);
  if (value.state !== "prepared" || readAgentPlanPreparationIntents(value.ownerScope).some(item => item.runId === value.runId && item.itemId === value.itemId))
    throw new AgentPlanRequestError(409, "这项已有原准备标识 请只读取原回执 或明确核对原键重试");
  return persistPreparation(value);
}
export function updateAgentPlanPreparationIntent(raw: AgentPlanPreparationIntent) {
  const value = AgentPlanPreparationIntentSchema.parse(raw), current = readAgentPlanPreparationIntents(value.ownerScope).find(item => item.runId === value.runId && item.itemId === value.itemId);
  if (!current || current.proposalChecksum !== value.proposalChecksum || current.createdAt !== value.createdAt || current.state === "known" && value.state !== "known")
    throw new AgentPlanRequestError(409, "原准备标识已清除或变化 迟到结果不能重建或替换");
  return persistPreparation(value);
}
export function forgetAgentPlanPreparationIntent(marker: AgentPlanPreparationIntent) {
  const current = readAgentPlanPreparationIntents(marker.ownerScope).find(item => item.runId === marker.runId && item.itemId === marker.itemId);
  if (current && (current.proposalChecksum !== marker.proposalChecksum || current.createdAt !== marker.createdAt)) throw new AgentPlanRequestError(409, "原准备标识已变化 请重新核对");
  try { const key = preparationKey(marker); sessionStorage.removeItem(key); if (sessionStorage.getItem(key) !== null) throw new Error("storage"); }
  catch { throw new AgentPlanRequestError(0, "原准备标识尚未清除"); }
  changed();
}
export function useAgentPlanIntents(preferenceScope: string | null) {
  const [revision, setRevision] = useState(0), [state, setState] = useState<{ scope: string; ownerScope: string; markers: AgentPlanIntent[]; preparations: AgentPlanPreparationIntent[]; error: string } | null>(null);
  useEffect(() => {
    const reload = () => setRevision(value => value + 1);
    window.addEventListener(AGENT_PLAN_INTENT_EVENT, reload); window.addEventListener("storage", reload); window.addEventListener(AGENT_PLAN_CLEAR_EVENT, reload);
    return () => { window.removeEventListener(AGENT_PLAN_INTENT_EVENT, reload); window.removeEventListener("storage", reload); window.removeEventListener(AGENT_PLAN_CLEAR_EVENT, reload); };
  }, []);
  useEffect(() => {
    let cancelled = false; if (!preferenceScope) return;
    void agentPlanOwnerScope(preferenceScope).then(ownerScope => {
      if (cancelled) return;
      try { setState({ scope: preferenceScope, ownerScope, markers: readAgentPlanIntents(ownerScope), preparations: readAgentPlanPreparationIntents(ownerScope), error: "" }); }
      catch { setState({ scope: preferenceScope, ownerScope, markers: [], preparations: [], error: "原请求标识暂不可核对 本次不发起新的付费任务" }); }
    }).catch(() => { if (!cancelled) setState({ scope: preferenceScope, ownerScope: "", markers: [], preparations: [], error: "本人原请求摘要无法核对 本次不发起新的付费任务" }); });
    return () => { cancelled = true; };
  }, [preferenceScope, revision]);
  const current = state?.scope === preferenceScope ? state : null;
  return { markers: current?.markers ?? [], preparations: current?.preparations ?? [], ownerScope: current?.ownerScope ?? "", ready: Boolean(current && !current.error), error: current?.error ?? "",
    reload: useCallback(() => setRevision(value => value + 1), []) };
}
