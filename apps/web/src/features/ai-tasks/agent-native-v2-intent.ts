"use client";
import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import {
  AGENT_NATIVE_V2_INTENT_PREFIX, AGENT_NATIVE_V2_PREPARATION_INTENT_PREFIX, AGENT_NATIVE_V2_CLEAR_EVENT,
  AgentNativeV2IntentSchema, AgentNativeV2PreparationIntentSchema, CreateAgentNativeV2Schema, canonicalAgentNativeV2Request,
  type CreateAgentNativeV2,
} from "@yummyai/contracts/ai/agent-native-v2";
import { agentTransportTextHash } from "@yummyai/contracts/ai/agent-transport";
import { AgentNativeV2RequestError } from "./agent-native-v2-client";

export { AGENT_NATIVE_V2_INTENT_PREFIX, AGENT_NATIVE_V2_PREPARATION_INTENT_PREFIX, AGENT_NATIVE_V2_CLEAR_EVENT };
export const AGENT_NATIVE_V2_INTENT_EVENT = "yummyai.agent-native-v2-intents-changed";
export type AgentNativeV2Intent = z.infer<typeof AgentNativeV2IntentSchema>;
export type AgentNativeV2PreparationIntent = z.infer<typeof AgentNativeV2PreparationIntentSchema>;
export const agentNativeV2Hash = agentTransportTextHash;
export const agentNativeV2OwnerScope = (preferenceScope: string) => agentNativeV2Hash(preferenceScope);
export const agentNativeV2RequestChecksum = (value: CreateAgentNativeV2) => agentNativeV2Hash(canonicalAgentNativeV2Request(value));
const key = (value: Pick<AgentNativeV2Intent, "ownerScope" | "requestId">) => AGENT_NATIVE_V2_INTENT_PREFIX + value.ownerScope + ":" + value.requestId;
const preparationKey = (value: Pick<AgentNativeV2PreparationIntent, "ownerScope" | "runId" | "itemId">) => AGENT_NATIVE_V2_PREPARATION_INTENT_PREFIX + value.ownerScope + ":" + value.runId + ":" + value.itemId;
function changed() { window.dispatchEvent(new Event(AGENT_NATIVE_V2_INTENT_EVENT)); }
function list<T extends { ownerScope: string }>(prefix: string, ownerScope: string, schema: z.ZodType<T>, makeKey: (value: T) => string): T[] {
  if (!/^[a-f0-9]{64}$/.test(ownerScope)) throw new AgentNativeV2RequestError(400, "本人原请求作用域无效 本次不发送");
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
  } catch { throw new AgentNativeV2RequestError(0, "浏览器无法核对原请求标识 本次不发送新的付费任务或原准备"); }
  return values;
}
function persist<T>(value: T, name: string) {
  try { const text = JSON.stringify(value); sessionStorage.setItem(name, text); if (sessionStorage.getItem(name) !== text) throw new Error("storage"); }
  catch { throw new AgentNativeV2RequestError(0, "原请求标识未能可靠保存 本次不发送 请检查浏览器存储"); }
  changed(); return value;
}
function remove(name: string) {
  try { sessionStorage.removeItem(name); if (sessionStorage.getItem(name) !== null) throw new Error("storage"); }
  catch { throw new AgentNativeV2RequestError(0, "原请求标识尚未可靠清除 本次不另起任务"); }
  changed();
}
export function readAgentNativeV2Intents(ownerScope: string) {
  const values = list(AGENT_NATIVE_V2_INTENT_PREFIX, ownerScope, AgentNativeV2IntentSchema, key);
  if (values.some(value => value.state === "known" && !value.runId)) throw new AgentNativeV2RequestError(409, "原已知请求缺少真实任务编号 请先核对 不新发付费请求");
  return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.requestId.localeCompare(b.requestId));
}
export async function prepareAgentNativeV2Intent(raw: CreateAgentNativeV2, preferenceScope: string) {
  const input = CreateAgentNativeV2Schema.parse(raw), [ownerScope, requestChecksum] = await Promise.all([agentNativeV2OwnerScope(preferenceScope), agentNativeV2RequestChecksum(input)]);
  if (readAgentNativeV2Intents(ownerScope).length) throw new AgentNativeV2RequestError(409, "本人仍有十一类工具任务待核对 请先读取原回执 不以新编号重复付费");
  return { input, intent: AgentNativeV2IntentSchema.parse({ version: 1, ownerScope, requestId: input.requestId, requestChecksum, runId: null, state: "prepared", createdAt: new Date().toISOString() }) };
}
export function saveAgentNativeV2Intent(raw: AgentNativeV2Intent) {
  const value = AgentNativeV2IntentSchema.parse(raw);
  if (value.state !== "prepared" || value.runId !== null || readAgentNativeV2Intents(value.ownerScope).length)
    throw new AgentNativeV2RequestError(409, "本人仍有原请求待核对 本次不发送替代请求");
  return persist(value, key(value));
}
export function updateAgentNativeV2Intent(raw: AgentNativeV2Intent) {
  const value = AgentNativeV2IntentSchema.parse(raw), current = readAgentNativeV2Intents(value.ownerScope).find(marker => marker.requestId === value.requestId);
  if (!current || current.requestChecksum !== value.requestChecksum || current.createdAt !== value.createdAt ||
    current.runId !== null && current.runId !== value.runId || current.state === "known" && value.state !== "known" || value.state === "known" && value.runId === null)
    throw new AgentNativeV2RequestError(409, "原请求标识已清除或变化 迟到响应不能重建或替换标识");
  return persist(value, key(value));
}
export function forgetAgentNativeV2Intent(marker: AgentNativeV2Intent) {
  const current = readAgentNativeV2Intents(marker.ownerScope).find(value => value.requestId === marker.requestId);
  if (current && (current.requestChecksum !== marker.requestChecksum || current.createdAt !== marker.createdAt))
    throw new AgentNativeV2RequestError(409, "原请求标识已变化 请重新核对");
  remove(key(marker));
}
export function readAgentNativeV2PreparationIntents(ownerScope: string) {
  return list(AGENT_NATIVE_V2_PREPARATION_INTENT_PREFIX, ownerScope, AgentNativeV2PreparationIntentSchema, preparationKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.itemId.localeCompare(b.itemId));
}
export function saveAgentNativeV2PreparationIntent(raw: AgentNativeV2PreparationIntent) {
  const value = AgentNativeV2PreparationIntentSchema.parse(raw);
  if (value.state !== "prepared" || readAgentNativeV2PreparationIntents(value.ownerScope).some(marker => marker.runId === value.runId && marker.itemId === value.itemId))
    throw new AgentNativeV2RequestError(409, "这项已有原准备标识 请先读取原回执");
  return persist(value, preparationKey(value));
}
export function updateAgentNativeV2PreparationIntent(raw: AgentNativeV2PreparationIntent) {
  const value = AgentNativeV2PreparationIntentSchema.parse(raw), current = readAgentNativeV2PreparationIntents(value.ownerScope).find(marker => marker.runId === value.runId && marker.itemId === value.itemId);
  if (!current || current.proposalChecksum !== value.proposalChecksum || current.createdAt !== value.createdAt || current.state === "known" && value.state !== "known")
    throw new AgentNativeV2RequestError(409, "原准备标识已清除或变化 迟到结果不能重建标识");
  return persist(value, preparationKey(value));
}
export function useAgentNativeV2Intents(preferenceScope: string | null) {
  const [revision, setRevision] = useState(0), [state, setState] = useState<{ scope: string; ownerScope: string; markers: AgentNativeV2Intent[]; preparations: AgentNativeV2PreparationIntent[]; error: string } | null>(null);
  useEffect(() => {
    const reload = () => setRevision(value => value + 1);
    window.addEventListener(AGENT_NATIVE_V2_INTENT_EVENT, reload); window.addEventListener(AGENT_NATIVE_V2_CLEAR_EVENT, reload); window.addEventListener("storage", reload);
    return () => { window.removeEventListener(AGENT_NATIVE_V2_INTENT_EVENT, reload); window.removeEventListener(AGENT_NATIVE_V2_CLEAR_EVENT, reload); window.removeEventListener("storage", reload); };
  }, []);
  useEffect(() => {
    let cancelled = false; if (!preferenceScope) return;
    void agentNativeV2OwnerScope(preferenceScope).then(ownerScope => {
      if (cancelled) return;
      try { setState({ scope: preferenceScope, ownerScope, markers: readAgentNativeV2Intents(ownerScope), preparations: readAgentNativeV2PreparationIntents(ownerScope), error: "" }); }
      catch { setState({ scope: preferenceScope, ownerScope, markers: [], preparations: [], error: "原请求标识暂不可核对 本次不发送新的付费任务或原准备" }); }
    }).catch(() => { if (!cancelled) setState({ scope: preferenceScope, ownerScope: "", markers: [], preparations: [], error: "本人原请求摘要无法核对 本次不发送" }); });
    return () => { cancelled = true; };
  }, [preferenceScope, revision]);
  const current = state?.scope === preferenceScope ? state : null;
  return { ownerScope: current?.ownerScope ?? "", markers: current?.markers ?? [], preparations: current?.preparations ?? [], ready: Boolean(current && !current.error), error: current?.error ?? "", reload: useCallback(() => setRevision(value => value + 1), []) };
}
