"use client";
import { useEffect, useState } from "react";

// Short-lived, tenant-scoped product form drafts. No credentials or order PII are stored.
// Lives only in this open application tab; a reload starts a fresh session.
const drafts = new Map<string, { value: unknown; at: number }>();
const lifetime = 2 * 60 * 60 * 1000;
export function clearTaskDrafts(prefix: string) {
  for (const key of drafts.keys()) if (key.startsWith(`${prefix}:`)) drafts.delete(key);
}
export function useTaskDraft<T>(prefix: string, field: string, initial: T | (() => T)) {
  const key = `${prefix}:${field}`;
  const [value, setValue] = useState<T>(() => {
    const saved = typeof window !== "undefined" ? drafts.get(key) : undefined;
    if (saved && Date.now() - saved.at < lifetime) return structuredClone(saved.value) as T;
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  useEffect(() => {
    for (const [id, draft] of drafts) if (Date.now() - draft.at >= lifetime) drafts.delete(id);
    while (drafts.size >= 120 && !drafts.has(key)) drafts.delete(drafts.keys().next().value!);
    drafts.set(key, { value: structuredClone(value), at: Date.now() });
  }, [key, value]);
  return [value, setValue] as const;
}
