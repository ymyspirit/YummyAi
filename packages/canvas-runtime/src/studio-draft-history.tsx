export function studioDraftOrigin(value: unknown): { version: 1; sourceScope: string; requestId: string; executionFrozen: true } | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>, marker = item._yummyaiOrigin;
  if (marker && typeof marker === "object") {
    const origin = marker as Record<string, unknown>;
    if (origin.version === 1 && origin.executionFrozen === true && typeof origin.sourceScope === "string" && typeof origin.requestId === "string") return origin as ReturnType<typeof studioDraftOrigin>;
  }
  return item.metadata && typeof item.metadata === "object" ? studioDraftOrigin(item.metadata) : undefined;
}
export const studioHistoryFrozen = (value: unknown) => !!studioDraftOrigin(value);
export function studioDraftRestoreNodes<T>(nodes: T[], reset: (nodes: T[]) => T[]) {
  return nodes.map(node => studioHistoryFrozen(node) ? node : reset([node])[0]!);
}
export function studioDraftHistoryFields(value: unknown) { const origin = studioDraftOrigin(value); return origin ? { _yummyaiOrigin: origin } : {}; }
export function FrozenDraftHistory({ value }: { value: unknown }) {
  const origin = studioDraftOrigin(value);
  return origin ? <><span role="status" className="studio-origin-history" style={{ display: "block", fontSize: 12, lineHeight: 1.6, color: "#1e4f9b", background: "#eff5ff", padding: "4px 8px", overflowWrap: "anywhere" }}>来源历史副本 · {origin.sourceScope === "unassigned" ? "个人工作区" : origin.sourceScope} · 原任务已冻结 不会自动恢复</span><style>{`.studio-origin-history{animation:studio-history-in .18s ease-out;transition:opacity .16s,transform .16s}@keyframes studio-history-in{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:translateY(0)}}@media(prefers-reduced-motion:reduce){.studio-origin-history{animation:none;transition:none}}`}</style></> : null;
}
