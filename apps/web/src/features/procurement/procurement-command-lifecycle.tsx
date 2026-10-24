import type { ProcurementCommandKind } from "@yummyai/contracts/procurement/procurement-command";

export type ProcurementRecoveryScope = { kind: ProcurementCommandKind; targetId: string | null };

/** Input copies live at the API; opening a source must find its original even
 * when many newer, unrelated originals fill the global recovery page. */
export function procurementCommandReadPath(scope: ProcurementRecoveryScope | null, before?: string) {
  const query = new URLSearchParams();
  if (scope) { query.set("kind", scope.kind); if (scope.targetId) query.set("targetId", scope.targetId); }
  if (before) query.set("before", before);
  return `commands${query.size ? `?${query}` : ""}`;
}

/** A display refresh may invalidate a response, but must still settle its busy
 * state. A stale completion can never release a newer actor's operation. */
export function createProcurementWriteActivity() {
  let owner: symbol | null = null;
  return {
    get busy() { return owner !== null; },
    begin() { if (owner !== null) return null; owner = Symbol("procurement-write"); return owner; },
    settle(token: symbol) { if (owner === token) owner = null; },
    revoke() { owner = null; },
  };
}
