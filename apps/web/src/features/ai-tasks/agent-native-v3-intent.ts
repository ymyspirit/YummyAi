"use client";
import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import {
  AGENT_NATIVE_V3_INTENT_PREFIX, AGENT_NATIVE_V3_PREPARATION_INTENT_PREFIX, AGENT_NATIVE_V3_CLEAR_EVENT,
  AgentNativeV3IntentSchema, AgentNativeV3PreparationIntentSchema, CreateAgentNativeV3Schema, canonicalAgentNativeV3Request,
  type CreateAgentNativeV3,
} from "@yummyai/contracts/ai/agent-native-v3";
import { agentTransportTextHash } from "@yummyai/contracts/ai/agent-transport";
import { AgentNativeV3RequestError } from "./agent-native-v3-client";

export { AGENT_NATIVE_V3_INTENT_PREFIX, AGENT_NATIVE_V3_PREPARATION_INTENT_PREFIX, AGENT_NATIVE_V3_CLEAR_EVENT };
export const AGENT_NATIVE_V3_INTENT_EVENT = "yummyai.agent-native-v3-intents-changed";
export type AgentNativeV3Intent = z.infer<typeof AgentNativeV3IntentSchema>;
export type AgentNativeV3PreparationIntent = z.infer<typeof AgentNativeV3PreparationIntentSchema>;
export const agentNativeV3Hash = agentTransportTextHash;
export const agentNativeV3OwnerScope = (preferenceScope: string) => agentNativeV3Hash(preferenceScope);
export const agentNativeV3RequestChecksum = (value: CreateAgentNativeV3) => agentNativeV3Hash(canonicalAgentNativeV3Request(value));
const key = (value: Pick<AgentNativeV3Intent, "ownerScope" | "requestId">) => AGENT_NATIVE_V3_INTENT_PREFIX + value.ownerScope + ":" + value.requestId;
const preparationKey = (value: Pick<AgentNativeV3PreparationIntent, "ownerScope" | "runId" | "itemId">) => AGENT_NATIVE_V3_PREPARATION_INTENT_PREFIX + value.ownerScope + ":" + value.runId + ":" + value.itemId;
function changed() { window.dispatchEvent(new Event(AGENT_NATIVE_V3_INTENT_EVENT)); }
function list<T extends { ownerScope: string }>(prefix: string, ownerScope: string, schema: z.ZodType<T>, makeKey: (value: T) => string): T[] {
  if (!/^[a-f0-9]{64}$/.test(ownerScope)) throw new AgentNativeV3RequestError(400, "本人原请求作用域无效 本次不发送");
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
  } catch { throw new AgentNativeV3RequestError(0, "浏览器无法核对原请求标识 本次不发送新的付费任务或原准备"); }
  return values;
}
function persist<T>(value: T, name: string) {
  try { const text = JSON.stringify(value); sessionStorage.setItem(name, text); if (sessionStorage.getItem(name) !== text) throw new Error("storage"); }
  catch { throw new AgentNativeV3RequestError(0, "原请求标识未能可靠保存 本次不发送 请检查浏览器存储"); }
  changed(); return value;
}
function remove(name: string) {
  try { sessionStorage.removeItem(name); if (sessionStorage.getItem(name) !== null) throw new Error("storage"); }
  catch { throw new AgentNativeV3RequestError(0, "原请求标识尚未可靠清除 本次不另起任务"); }
  changed();
}
export function readAgentNativeV3Intents(ownerScope: string) {
  const values = list(AGENT_NATIVE_V3_INTENT_PREFIX, ownerScope, AgentNativeV3IntentSchema, key);
  if (values.some(value => value.state === "known" && !value.runId)) throw new AgentNativeV3RequestError(409, "原已知请求缺少真实任务编号 请先核对 不新发付费请求");
  return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.requestId.localeCompare(b.requestId));
}
export async function prepareAgentNativeV3Intent(raw: CreateAgentNativeV3, preferenceScope: string) {
  const input = CreateAgentNativeV3Schema.parse(raw), [ownerScope, requestChecksum] = await Promise.all([agentNativeV3OwnerScope(preferenceScope), agentNativeV3RequestChecksum(input)]);
  if (readAgentNativeV3Intents(ownerScope).length) throw new AgentNativeV3RequestError(409, "本人仍有十二类工具任务待核对 请先读取原回执 不以新编号重复付费");
  return { input, intent: AgentNativeV3IntentSchema.parse({ version: 1, ownerScope, requestId: input.requestId, requestChecksum, runId: null, state: "prepared", createdAt: new Date().toISOString() }) };
}
export function saveAgentNativeV3Intent(raw: AgentNativeV3Intent) {
  const value = AgentNativeV3IntentSchema.parse(raw);
  if (value.state !== "prepared" || value.runId !== null || readAgentNativeV3Intents(value.ownerScope).length)
    throw new AgentNativeV3RequestError(409, "本人仍有原请求待核对 本次不发送替代请求");
  return persist(value, key(value));
}
export function updateAgentNativeV3Intent(raw: AgentNativeV3Intent) {
  const value = AgentNativeV3IntentSchema.parse(raw), current = readAgentNativeV3Intents(value.ownerScope).find(marker => marker.requestId === value.requestId);
  if (!current || current.requestChecksum !== value.requestChecksum || current.createdAt !== value.createdAt ||
    current.runId !== null && current.runId !== value.runId || current.state === "known" && value.state !== "known" || value.state === "known" && value.runId === null)
    throw new AgentNativeV3RequestError(409, "原请求标识已清除或变化 迟到响应不能重建或替换标识");
  return persist(value, key(value));
}
export function forgetAgentNativeV3Intent(marker: AgentNativeV3Intent) {
  const current = readAgentNativeV3Intents(marker.ownerScope).find(value => value.requestId === marker.requestId);
  if (current && (current.requestChecksum !== marker.requestChecksum || current.createdAt !== marker.createdAt))
    throw new AgentNativeV3RequestError(409, "原请求标识已变化 请重新核对");
  remove(key(marker));
}
export function readAgentNativeV3PreparationIntents(ownerScope: string) {
  return list(AGENT_NATIVE_V3_PREPARATION_INTENT_PREFIX, ownerScope, AgentNativeV3PreparationIntentSchema, preparationKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.itemId.localeCompare(b.itemId));
}
export function saveAgentNativeV3PreparationIntent(raw: AgentNativeV3PreparationIntent) {
  const value = AgentNativeV3PreparationIntentSchema.parse(raw);
  if (value.state !== "prepared" || readAgentNativeV3PreparationIntents(value.ownerScope).some(marker => marker.runId === value.runId && marker.itemId === value.itemId))
    throw new AgentNativeV3RequestError(409, "这项已有原准备标识 请先读取原回执");
  return persist(value, preparationKey(value));
}
export function updateAgentNativeV3PreparationIntent(raw: AgentNativeV3PreparationIntent) {
  const value = AgentNativeV3PreparationIntentSchema.parse(raw), current = readAgentNativeV3PreparationIntents(value.ownerScope).find(marker => marker.runId === value.runId && marker.itemId === value.itemId);
  if (!current || current.proposalChecksum !== value.proposalChecksum || current.createdAt !== value.createdAt || current.state === "known" && value.state !== "known")
    throw new AgentNativeV3RequestError(409, "原准备标识已清除或变化 迟到结果不能重建标识");
  return persist(value, preparationKey(value));
}
export function useAgentNativeV3Intents(preferenceScope: string | null) {
  const [revision, setRevision] = useState(0), [state, setState] = useState<{ scope: string; ownerScope: string; markers: AgentNativeV3Intent[]; preparations: AgentNativeV3PreparationIntent[]; error: string } | null>(null);
  useEffect(() => {
    const reload = () => setRevision(value => value + 1);
    window.addEventListener(AGENT_NATIVE_V3_INTENT_EVENT, reload); window.addEventListener(AGENT_NATIVE_V3_CLEAR_EVENT, reload); window.addEventListener("storage", reload);
    return () => { window.removeEventListener(AGENT_NATIVE_V3_INTENT_EVENT, reload); window.removeEventListener(AGENT_NATIVE_V3_CLEAR_EVENT, reload); window.removeEventListener("storage", reload); };
  }, []);
  useEffect(() => {
    let cancelled = false; if (!preferenceScope) return;
    void agentNativeV3OwnerScope(preferenceScope).then(ownerScope => {
      if (cancelled) return;
      try { setState({ scope: preferenceScope, ownerScope, markers: readAgentNativeV3Intents(ownerScope), preparations: readAgentNativeV3PreparationIntents(ownerScope), error: "" }); }
      catch { setState({ scope: preferenceScope, ownerScope, markers: [], preparations: [], error: "原请求标识暂不可核对 本次不发送新的付费任务或原准备" }); }
    }).catch(() => { if (!cancelled) setState({ scope: preferenceScope, ownerScope: "", markers: [], preparations: [], error: "本人原请求摘要无法核对 本次不发送" }); });
    return () => { cancelled = true; };
  }, [preferenceScope, revision]);
  const current = state?.scope === preferenceScope ? state : null;
  return { ownerScope: current?.ownerScope ?? "", markers: current?.markers ?? [], preparations: current?.preparations ?? [], ready: Boolean(current && !current.error), error: current?.error ?? "", reload: useCallback(() => setRevision(value => value + 1), []) };
}
