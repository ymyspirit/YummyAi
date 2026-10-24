"use client";
import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import {
  AGENT_NATIVE_INTENT_PREFIX, AGENT_NATIVE_PREPARATION_INTENT_PREFIX, AGENT_NATIVE_CLEAR_EVENT,
  AgentNativeIntentSchema, AgentNativePreparationIntentSchema, CreateAgentNativeSchema, canonicalAgentNativeRequest,
  type AgentNativeIntent, type AgentNativePreparationIntent, type CreateAgentNative,
} from "@yummyai/contracts/ai/agent-native";
import { AgentNativeRequestError } from "./agent-native-client";

export { AGENT_NATIVE_INTENT_PREFIX, AGENT_NATIVE_PREPARATION_INTENT_PREFIX, AGENT_NATIVE_CLEAR_EVENT };
export const AGENT_NATIVE_INTENT_EVENT = "yummyai.agent-native-intents-changed";
export async function agentNativeHash(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
export const agentNativeOwnerScope = (preferenceScope: string) => agentNativeHash(preferenceScope);
export const agentNativeRequestChecksum = (value: CreateAgentNative) => agentNativeHash(canonicalAgentNativeRequest(value));
const key = (value: Pick<AgentNativeIntent, "ownerScope" | "requestId">) => AGENT_NATIVE_INTENT_PREFIX + value.ownerScope + ":" + value.requestId;
const preparationKey = (value: Pick<AgentNativePreparationIntent, "ownerScope" | "runId" | "itemId">) => AGENT_NATIVE_PREPARATION_INTENT_PREFIX + value.ownerScope + ":" + value.runId + ":" + value.itemId;
function changed() { window.dispatchEvent(new Event(AGENT_NATIVE_INTENT_EVENT)); }
function list<T extends { ownerScope: string }>(prefix: string, ownerScope: string, schema: z.ZodType<T>, makeKey: (value: T) => string): T[] {
  if (!/^[a-f0-9]{64}$/.test(ownerScope)) throw new AgentNativeRequestError(400, "本人原请求作用域无效 本次不发送");
  const values: T[] = [];
  try {
    const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).filter((value): value is string => Boolean(value?.startsWith(prefix + ownerScope + ":")));
    for (const name of keys) {
      const text = sessionStorage.getItem(name); let raw: unknown;
      try { raw = text && text.length <= 4096 ? JSON.parse(text) : null; } catch { raw = null; }
      const parsed = schema.safeParse(raw);
      if (!parsed.success || parsed.data.ownerScope !== ownerScope || makeKey(parsed.data) !== name) { sessionStorage.removeItem(name); continue; }
      values.push(parsed.data);
    }
  } catch { throw new AgentNativeRequestError(0, "浏览器无法核对原请求标识 本次不发送新的付费任务或原准备"); }
  return values;
}
function persist<T>(value: T, name: string) {
  try { const text = JSON.stringify(value); sessionStorage.setItem(name, text); if (sessionStorage.getItem(name) !== text) throw new Error("storage"); }
  catch { throw new AgentNativeRequestError(0, "原请求标识未能可靠保存 本次不发送 请检查浏览器存储"); }
  changed(); return value;
}
function remove(name: string) {
  try { sessionStorage.removeItem(name); if (sessionStorage.getItem(name) !== null) throw new Error("storage"); }
  catch { throw new AgentNativeRequestError(0, "原请求标识尚未可靠清除 本次不另起任务"); }
  changed();
}
export function readAgentNativeIntents(ownerScope: string) {
  const values = list(AGENT_NATIVE_INTENT_PREFIX, ownerScope, AgentNativeIntentSchema, key);
  if (values.some(value => value.state === "known" && !value.runId)) throw new AgentNativeRequestError(409, "原已知请求缺少真实任务编号 请先核对 不新发付费请求");
  return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.requestId.localeCompare(b.requestId));
}
export async function prepareAgentNativeIntent(raw: CreateAgentNative, preferenceScope: string) {
  const input = CreateAgentNativeSchema.parse(raw), [ownerScope, requestChecksum] = await Promise.all([agentNativeOwnerScope(preferenceScope), agentNativeRequestChecksum(input)]);
  if (readAgentNativeIntents(ownerScope).length) throw new AgentNativeRequestError(409, "本人仍有原生工具任务待核对 请先读取原回执 不以新编号重复付费");
  return { input, intent: AgentNativeIntentSchema.parse({ version: 1, ownerScope, requestId: input.requestId, requestChecksum, runId: null, state: "prepared", createdAt: new Date().toISOString() }) };
}
export function saveAgentNativeIntent(raw: AgentNativeIntent) {
  const value = AgentNativeIntentSchema.parse(raw);
  if (value.state !== "prepared" || value.runId !== null || readAgentNativeIntents(value.ownerScope).length)
    throw new AgentNativeRequestError(409, "本人仍有原请求待核对 本次不发送替代请求");
  return persist(value, key(value));
}
export function updateAgentNativeIntent(raw: AgentNativeIntent) {
  const value = AgentNativeIntentSchema.parse(raw), current = readAgentNativeIntents(value.ownerScope).find(marker => marker.requestId === value.requestId);
  if (!current || current.requestChecksum !== value.requestChecksum || current.createdAt !== value.createdAt ||
    current.runId !== null && current.runId !== value.runId || current.state === "known" && value.state !== "known" || value.state === "known" && value.runId === null)
    throw new AgentNativeRequestError(409, "原请求标识已清除或变化 迟到响应不能重建或替换标识");
  return persist(value, key(value));
}
export function forgetAgentNativeIntent(marker: AgentNativeIntent) {
  const current = readAgentNativeIntents(marker.ownerScope).find(value => value.requestId === marker.requestId);
  if (current && (current.requestChecksum !== marker.requestChecksum || current.createdAt !== marker.createdAt))
    throw new AgentNativeRequestError(409, "原请求标识已变化 请重新核对");
  remove(key(marker));
}
export function readAgentNativePreparationIntents(ownerScope: string) {
  return list(AGENT_NATIVE_PREPARATION_INTENT_PREFIX, ownerScope, AgentNativePreparationIntentSchema, preparationKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.itemId.localeCompare(b.itemId));
}
export function saveAgentNativePreparationIntent(raw: AgentNativePreparationIntent) {
  const value = AgentNativePreparationIntentSchema.parse(raw);
  if (value.state !== "prepared" || readAgentNativePreparationIntents(value.ownerScope).some(marker => marker.runId === value.runId && marker.itemId === value.itemId))
    throw new AgentNativeRequestError(409, "这项已有原准备标识 请先读取原回执");
  return persist(value, preparationKey(value));
}
export function updateAgentNativePreparationIntent(raw: AgentNativePreparationIntent) {
  const value = AgentNativePreparationIntentSchema.parse(raw), current = readAgentNativePreparationIntents(value.ownerScope).find(marker => marker.runId === value.runId && marker.itemId === value.itemId);
  if (!current || current.proposalChecksum !== value.proposalChecksum || current.createdAt !== value.createdAt || current.state === "known" && value.state !== "known")
    throw new AgentNativeRequestError(409, "原准备标识已清除或变化 迟到结果不能重建标识");
  return persist(value, preparationKey(value));
}
export function useAgentNativeIntents(preferenceScope: string | null) {
  const [revision, setRevision] = useState(0), [state, setState] = useState<{ scope: string; ownerScope: string; markers: AgentNativeIntent[]; preparations: AgentNativePreparationIntent[]; error: string } | null>(null);
  useEffect(() => {
    const reload = () => setRevision(value => value + 1);
    window.addEventListener(AGENT_NATIVE_INTENT_EVENT, reload); window.addEventListener(AGENT_NATIVE_CLEAR_EVENT, reload); window.addEventListener("storage", reload);
    return () => { window.removeEventListener(AGENT_NATIVE_INTENT_EVENT, reload); window.removeEventListener(AGENT_NATIVE_CLEAR_EVENT, reload); window.removeEventListener("storage", reload); };
  }, []);
  useEffect(() => {
    let cancelled = false; if (!preferenceScope) return;
    void agentNativeOwnerScope(preferenceScope).then(ownerScope => {
      if (cancelled) return;
      try { setState({ scope: preferenceScope, ownerScope, markers: readAgentNativeIntents(ownerScope), preparations: readAgentNativePreparationIntents(ownerScope), error: "" }); }
      catch { setState({ scope: preferenceScope, ownerScope, markers: [], preparations: [], error: "原请求标识暂不可核对 本次不发送新的付费任务或原准备" }); }
    }).catch(() => { if (!cancelled) setState({ scope: preferenceScope, ownerScope: "", markers: [], preparations: [], error: "本人原请求摘要无法核对 本次不发送" }); });
    return () => { cancelled = true; };
  }, [preferenceScope, revision]);
  const current = state?.scope === preferenceScope ? state : null;
  return { ownerScope: current?.ownerScope ?? "", markers: current?.markers ?? [], preparations: current?.preparations ?? [], ready: Boolean(current && !current.error), error: current?.error ?? "", reload: useCallback(() => setRevision(value => value + 1), []) };
}
