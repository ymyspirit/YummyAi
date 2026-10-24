export class StoreNodeError extends Error {
  constructor(readonly code: string) { super(code); this.name = "StoreNodeError"; }
}
export function nodeCheck(condition: unknown, code = "store_node_identity_invalid"): asserts condition {
  if (!condition) throw new StoreNodeError(code);
}
export function safeStoreNodeCode(error: unknown): string {
  return error instanceof StoreNodeError && /^store_node_[a-z_]{1,80}$/.test(error.code) ? error.code : "store_node_unavailable";
}
