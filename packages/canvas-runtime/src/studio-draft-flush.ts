type Flush = () => void | Promise<unknown>;
const owners = new Set<Flush>();
const delayed = new Map<string, { timer: ReturnType<typeof setTimeout>; write: Flush }>();
export function registerStudioDraftFlush(flush: Flush) { owners.add(flush); return () => { owners.delete(flush); }; }
export function attachStudioDraftFlushes<T extends object>(owner: T) {
  const beforeRelease = new Set<() => void>();
  // Preserve the lease's live AbortSignal getter and original object identity.
  return Object.assign(owner, { beforeRelease, onBeforeRelease(flush: () => void) { beforeRelease.add(flush); return () => { beforeRelease.delete(flush); }; } });
}
export function releaseStudioDraftOwner(canSave: () => boolean, flushes: Iterable<() => void>, release: () => void) {
  try { if (canSave()) for (const flush of flushes) flush(); } finally { release(); }
}
export function queueStudioDraftWrite(key: string, write: Flush, milliseconds: number) {
  const prior = delayed.get(key); if (prior) clearTimeout(prior.timer);
  const run = () => { const item = delayed.get(key); if (!item) return; delayed.delete(key); return item.write(); };
  delayed.set(key, { write, timer: setTimeout(() => { void Promise.resolve(run()).catch(() => undefined); }, milliseconds) });
}
export async function flushStudioDraftOwners() {
  for (const flush of owners) await flush();
  for (const [key, item] of [...delayed]) { clearTimeout(item.timer); delayed.delete(key); await item.write(); }
}
