"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import { ASSIST_INTENT_PREFIX, ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { AGENT_LOOP_INTENT_PREFIX, AGENT_LOOP_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/agent-loop";
import { AGENT_PLAN_INTENT_PREFIX, AGENT_PLAN_PREPARATION_INTENT_PREFIX, AGENT_PLAN_CLEAR_EVENT } from "@yummyai/contracts/ai/agent-plan";
import { AGENT_NATIVE_INTENT_PREFIX, AGENT_NATIVE_PREPARATION_INTENT_PREFIX, AGENT_NATIVE_CLEAR_EVENT } from "@yummyai/contracts/ai/agent-native";
import { AGENT_NATIVE_V2_INTENT_PREFIX, AGENT_NATIVE_V2_PREPARATION_INTENT_PREFIX, AGENT_NATIVE_V2_CLEAR_EVENT } from "@yummyai/contracts/ai/agent-native-v2";
import { AGENT_NATIVE_V3_INTENT_PREFIX, AGENT_NATIVE_V3_PREPARATION_INTENT_PREFIX, AGENT_NATIVE_V3_CLEAR_EVENT } from "@yummyai/contracts/ai/agent-native-v3";
import { AGENT_NATIVE_V4_INTENT_PREFIX, AGENT_NATIVE_V4_PREPARATION_INTENT_PREFIX, AGENT_NATIVE_V4_CLEAR_EVENT } from "@yummyai/contracts/ai/agent-native-v4";
import { AGENT_DEPENDENCY_PLAN_INTENT_PREFIX, AGENT_DEPENDENCY_PLAN_CLEAR_EVENT } from "@yummyai/contracts/ai/agent-dependency-plan";
import { AGENT_FULFILLMENT_COMMAND_INTENT_PREFIX, AGENT_FULFILLMENT_COMMAND_CLEAR_EVENT } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { STUDIO_PERSONAL_CLEAR_EVENT } from "@yummyai/contracts/pod/studio-personal";
import { STUDIO_TRANSFER_INTENT_PREFIX } from "@yummyai/contracts/pod/studio-document-transfer";

// Short-lived, tenant-scoped product form drafts. No credentials or order PII are stored.
// Memory is the default. Product-only forms may opt into this tab's session storage.
const drafts = new Map<string, { value: unknown; at: number; session?: boolean; recoveryError?: string | null }>();
const lifetime = 2 * 60 * 60 * 1000;
const sessionPrefix = "yummyai:product-task-draft:v1:";
type DraftOptions<T> = { session?: boolean; validate?: (value: unknown) => value is T };
export function readSessionTaskDraft<T>(storage: Storage, key: string, now: number, validate?: (value: unknown) => value is T): T | undefined {
  const text = storage.getItem(sessionPrefix + key);
  if (!text) return undefined;
  const saved = JSON.parse(text) as { version?: number; at?: number; value?: unknown };
  if (saved.version !== 1 || typeof saved.at !== "number" || !Number.isFinite(saved.at) || saved.at > now || now - saved.at >= lifetime) {
    storage.removeItem(sessionPrefix + key);
    return undefined;
  }
  if (validate && !validate(saved.value)) throw new Error("产品草稿格式已损坏 请核对后重新填写");
  return structuredClone(saved.value) as T;
}
export function writeSessionTaskDraft(storage: Storage, key: string, value: unknown, now: number) {
  storage.setItem(sessionPrefix + key, JSON.stringify({ version: 1, at: now, value }));
}
export function clearSessionTaskDrafts(options: { preserveAssistIntents?: boolean } = {}) {
  for (const [key, draft] of drafts) if (draft.session) drafts.delete(key);
  if (typeof window === "undefined") return;
  // Invalidate in-flight preparation synchronously, before storage is cleared.
  if (!options.preserveAssistIntents) {
    // Studio can be retained while its route is hidden. Abort its readers before
    // any legacy clear listener can publish focus or start a sibling refresh.
    window.dispatchEvent?.(new Event(STUDIO_PERSONAL_CLEAR_EVENT));
    // Legacy assist recovery can synchronously publish focus while clearing.
    // Purge every native reader before that notification can refresh siblings.
    window.dispatchEvent?.(new Event(AGENT_LOOP_INTENT_CLEAR_EVENT));
    window.dispatchEvent?.(new Event(AGENT_PLAN_CLEAR_EVENT));
    window.dispatchEvent?.(new Event(AGENT_NATIVE_CLEAR_EVENT));
    window.dispatchEvent?.(new Event(AGENT_NATIVE_V2_CLEAR_EVENT));
    window.dispatchEvent?.(new Event(AGENT_NATIVE_V3_CLEAR_EVENT));
    window.dispatchEvent?.(new Event(AGENT_NATIVE_V4_CLEAR_EVENT));
    window.dispatchEvent?.(new Event(AGENT_DEPENDENCY_PLAN_CLEAR_EVENT));
    window.dispatchEvent?.(new Event(AGENT_FULFILLMENT_COMMAND_CLEAR_EVENT));
    window.dispatchEvent?.(new Event(ASSIST_INTENT_CLEAR_EVENT));
  }
  try {
    for (const key of Object.keys(window.sessionStorage))
      if (key.startsWith(sessionPrefix) || key.startsWith("yummyai.knowledge-evaluation.start.v1:") || key.startsWith("yummyai.knowledge-benchmark.intent.v1:") || !options.preserveAssistIntents && (key === "yummyai.studio.scope" || key.startsWith("yummyai.studio.scope:") || key.startsWith(ASSIST_INTENT_PREFIX) || key.startsWith(AGENT_LOOP_INTENT_PREFIX) || key.startsWith(AGENT_PLAN_INTENT_PREFIX) || key.startsWith(AGENT_PLAN_PREPARATION_INTENT_PREFIX) || key.startsWith(AGENT_DEPENDENCY_PLAN_INTENT_PREFIX) || key.startsWith(AGENT_FULFILLMENT_COMMAND_INTENT_PREFIX) || key.startsWith(AGENT_NATIVE_V2_INTENT_PREFIX) || key.startsWith(AGENT_NATIVE_V2_PREPARATION_INTENT_PREFIX) || key.startsWith(AGENT_NATIVE_V3_INTENT_PREFIX) || key.startsWith(AGENT_NATIVE_V3_PREPARATION_INTENT_PREFIX) || key.startsWith(AGENT_NATIVE_V4_INTENT_PREFIX) || key.startsWith(AGENT_NATIVE_V4_PREPARATION_INTENT_PREFIX) || key.startsWith(AGENT_NATIVE_INTENT_PREFIX) || key.startsWith(AGENT_NATIVE_PREPARATION_INTENT_PREFIX) || key.startsWith("yummyai.agent-operation.intent.v1:") || key.startsWith("yummyai.store-node-execution.intent.v1:") || key.startsWith("yummyai.listing-sync.intent.v1:") || key.startsWith("yummyai.publication-preview.intent.v1:") || key.startsWith("yummyai.publication-submit.intent.v1:"))) window.sessionStorage.removeItem(key);
    if (!options.preserveAssistIntents)
      for (const key of Object.keys(window.sessionStorage))
        if (key.startsWith(STUDIO_TRANSFER_INTENT_PREFIX)) window.sessionStorage.removeItem(key);
  } catch { /* Storage can be unavailable without preventing logout. */ }
}
export function clearTaskDrafts(prefix: string) {
  if (typeof window !== "undefined") {
    try {
      for (const key of Object.keys(window.sessionStorage))
        if (key.startsWith(sessionPrefix + prefix + ":")) window.sessionStorage.removeItem(key);
    } catch { /* Memory drafts can still be cleared when browser storage is unavailable. */ }
  }
  for (const key of drafts.keys()) if (key.startsWith(`${prefix}:`)) drafts.delete(key);
}
export type TaskDraftState<T> = { key: string; value: T };
export function taskDraftStateForKey<T>(
  state: TaskDraftState<T>,
  key: string,
  initial: () => T,
): TaskDraftState<T> {
  return state.key === key ? state : { key, value: initial() };
}
export function updateTaskDraftState<T>(
  state: TaskDraftState<T>,
  key: string,
  action: SetStateAction<T>,
): TaskDraftState<T> {
  if (state.key !== key) return state;
  return {
    key,
    value: typeof action === "function" ? (action as (value: T) => T)(state.value) : action,
  };
}
export function useTaskDraft<T>(prefix: string, field: string, initial: T | (() => T), options: DraftOptions<T> = {}) {
  const recoveryError = useRef<string | null>(null);
  const key = `${prefix}:${field}`;
  const read = () => {
    recoveryError.current = null;
    const saved = typeof window !== "undefined" ? drafts.get(key) : undefined;
    if (saved && Date.now() - saved.at < lifetime) {
      recoveryError.current = saved.recoveryError ?? null;
      return structuredClone(saved.value) as T;
    }
    if (options.session && typeof window !== "undefined") {
      try {
        const restored = readSessionTaskDraft(window.sessionStorage, key, Date.now(), options.validate);
        if (restored !== undefined) return restored;
      } catch { recoveryError.current = "本标签页草稿未能恢复 请核对当前内容后重新填写或保存草稿"; }
    }
    return typeof initial === "function" ? (initial as () => T)() : initial;
  };
  const [state, setState] = useState<TaskDraftState<T>>(() => ({ key, value: read() }));
  const current = taskDraftStateForKey(state, key, read);
  // Adjust this hook's state before commit so old values never enter a new key.
  if (current !== state) setState(current);
  const setValue = useCallback(
    (action: SetStateAction<T>) => { recoveryError.current = null; setState((state) => updateTaskDraftState(state, key, action)); },
    [key],
  );
  useEffect(() => {
    if (state.key !== key) return;
    for (const [id, draft] of drafts) if (Date.now() - draft.at >= lifetime) drafts.delete(id);
    while (drafts.size >= 120 && !drafts.has(key)) drafts.delete(drafts.keys().next().value!);
    drafts.set(key, { value: structuredClone(state.value), at: Date.now(), session: options.session, recoveryError: recoveryError.current });
  }, [key, state, options.session]);
  useLayoutEffect(() => {
    if (state.key === key && options.session && !recoveryError.current) {
      try { writeSessionTaskDraft(window.sessionStorage, key, state.value, Date.now()); }
      catch { recoveryError.current = "浏览器未能保留本标签页草稿 请先保存草稿"; }
    }
  }, [key, state, options.session]);
  return [current.value, setValue, recoveryError.current] as const;
}
