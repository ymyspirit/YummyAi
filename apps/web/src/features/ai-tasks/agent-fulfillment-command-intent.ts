"use client";

import { useCallback, useEffect, useState } from "react";
import { AGENT_FULFILLMENT_COMMAND_VERSION, AGENT_FULFILLMENT_COMMAND_CLEAR_EVENT, AGENT_FULFILLMENT_COMMAND_INTENT_PREFIX, AgentFulfillmentCommandIntentSchema,
  PrepareAgentFulfillmentCommandSchema, canonicalAgentFulfillmentOriginal, type AgentFulfillmentCommandIntent,
  type PrepareAgentFulfillmentCommand } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { agentTransportTextHash } from "@yummyai/contracts/ai/agent-transport";
import { normalizeFulfillmentCommand } from "@yummyai/contracts/order/fulfillment-command";
import { AgentFulfillmentCommandRequestError } from "./agent-fulfillment-command-client";

export { AGENT_FULFILLMENT_COMMAND_INTENT_PREFIX };
export const AGENT_FULFILLMENT_COMMAND_INTENT_EVENT = "yummyai.agent-fulfillment-command-intents-changed";
const key = (value: Pick<AgentFulfillmentCommandIntent, "ownerScope" | "requestId">) => AGENT_FULFILLMENT_COMMAND_INTENT_PREFIX + value.ownerScope + ":" + value.requestId;
const storageError = () => new AgentFulfillmentCommandRequestError(0, "浏览器未能保存并核对原履约标识 本次不发送新准备");
function changed() { window.dispatchEvent(new Event(AGENT_FULFILLMENT_COMMAND_INTENT_EVENT)); }
export function readAgentFulfillmentCommandIntents(ownerScope: string): AgentFulfillmentCommandIntent[] {
  if (!/^[a-f0-9]{64}$/.test(ownerScope)) throw storageError();
  const result: AgentFulfillmentCommandIntent[] = [];
  try {
    const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).filter((item): item is string => Boolean(item?.startsWith(AGENT_FULFILLMENT_COMMAND_INTENT_PREFIX + ownerScope + ":")));
    for (const storageKey of keys) {
      const text = sessionStorage.getItem(storageKey); let raw: unknown; try { raw = text && text.length <= 4096 ? JSON.parse(text) : null; } catch { throw storageError(); }
      const parsed = AgentFulfillmentCommandIntentSchema.safeParse(raw);
      if (!parsed.success || parsed.data.ownerScope !== ownerScope || key(parsed.data) !== storageKey || parsed.data.state === "known" && !parsed.data.id) throw storageError();
      result.push(parsed.data);
    }
  } catch { throw storageError(); }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function store(value: AgentFulfillmentCommandIntent) {
  try { const text = JSON.stringify(value); sessionStorage.setItem(key(value), text); if (sessionStorage.getItem(key(value)) !== text) throw storageError(); }
  catch { throw storageError(); }
  changed(); return value;
}
export async function createAgentFulfillmentCommandIntent(raw: PrepareAgentFulfillmentCommand, preferenceScope: string) {
  const parsed = PrepareAgentFulfillmentCommandSchema.parse(raw), input = { ...parsed, original: normalizeFulfillmentCommand(parsed.original) };
  const [ownerScope, requestChecksum] = await Promise.all([agentTransportTextHash(preferenceScope), agentTransportTextHash(canonicalAgentFulfillmentOriginal(input.original))]);
  const prior = readAgentFulfillmentCommandIntents(ownerScope);
  if (prior.some(item => item.orderId === input.orderId)) throw new AgentFulfillmentCommandRequestError(409, "本单仍有原准备待核对 请先读取原回执 不换键重建");
  return { input, intent: AgentFulfillmentCommandIntentSchema.parse({ version: AGENT_FULFILLMENT_COMMAND_VERSION, ownerScope,
    orderId: input.orderId, requestId: input.original.requestId, requestChecksum, id: null, state: "unknown", createdAt: new Date().toISOString() }) };
}
export function saveAgentFulfillmentCommandIntent(raw: AgentFulfillmentCommandIntent) {
  const value = AgentFulfillmentCommandIntentSchema.parse(raw), prior = readAgentFulfillmentCommandIntents(value.ownerScope);
  if (value.state !== "unknown" || value.id || prior.some(item => item.orderId === value.orderId || item.requestId === value.requestId))
    throw new AgentFulfillmentCommandRequestError(409, "本单原请求尚待核对 不替换原标识");
  return store(value);
}
export function recordAgentFulfillmentCommandIntent(raw: AgentFulfillmentCommandIntent) {
  const value = AgentFulfillmentCommandIntentSchema.parse(raw), prior = readAgentFulfillmentCommandIntents(value.ownerScope).find(item => item.requestId === value.requestId);
  if (!prior || prior.orderId !== value.orderId || prior.requestChecksum !== value.requestChecksum || prior.createdAt !== value.createdAt
    || prior.id !== null && prior.id !== value.id || value.state !== "known" || !value.id)
    throw new AgentFulfillmentCommandRequestError(409, "原恢复标识已清除或变化 迟到响应不重建标识");
  return store(value);
}
export function forgetAgentFulfillmentCommandIntent(value: AgentFulfillmentCommandIntent) {
  const prior = readAgentFulfillmentCommandIntents(value.ownerScope).find(item => item.requestId === value.requestId);
  if (!prior || prior.state !== "known" || !prior.id || prior.orderId !== value.orderId || prior.requestChecksum !== value.requestChecksum || prior.id !== value.id) throw storageError();
  try { sessionStorage.removeItem(key(value)); if (sessionStorage.getItem(key(value)) !== null) throw storageError(); } catch { throw storageError(); }
  changed();
}
export function useAgentFulfillmentCommandIntents(preferenceScope: string | null) {
  const [revision, setRevision] = useState(0), [snapshot, setSnapshot] = useState<{ scope: string; ownerScope: string; items: AgentFulfillmentCommandIntent[]; error: string } | null>(null);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    window.addEventListener(AGENT_FULFILLMENT_COMMAND_INTENT_EVENT, reload); window.addEventListener("storage", reload);
    window.addEventListener(AGENT_FULFILLMENT_COMMAND_CLEAR_EVENT, reload); window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, reload);
    return () => { window.removeEventListener(AGENT_FULFILLMENT_COMMAND_INTENT_EVENT, reload); window.removeEventListener("storage", reload);
      window.removeEventListener(AGENT_FULFILLMENT_COMMAND_CLEAR_EVENT, reload); window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, reload); };
  }, [reload]);
  useEffect(() => {
    let cancelled = false; if (!preferenceScope) return;
    void agentTransportTextHash(preferenceScope).then(ownerScope => {
      if (cancelled) return;
      try { setSnapshot({ scope: preferenceScope, ownerScope, items: readAgentFulfillmentCommandIntents(ownerScope), error: "" }); }
      catch { setSnapshot({ scope: preferenceScope, ownerScope, items: [], error: "本人原恢复标识暂不可核对 不发起新准备" }); }
    }).catch(() => { if (!cancelled) setSnapshot({ scope: preferenceScope, ownerScope: "", items: [], error: "本人原恢复作用域暂不可核对" }); });
    return () => { cancelled = true; };
  }, [preferenceScope, revision]);
  const value = snapshot?.scope === preferenceScope ? snapshot : null;
  return { items: value?.items ?? [], ownerScope: value?.ownerScope ?? "", ready: Boolean(value && !value.error), error: value?.error ?? "", reload };
}
