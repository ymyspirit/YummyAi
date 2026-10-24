import type { StoreNodePeer } from "./store-node.types.js";

export const STORE_NODE_EXECUTION_RPC = ["claim", "permit", "step", "checkpoint", "complete", "receipt"] as const;
export type StoreNodeExecutionRpc = typeof STORE_NODE_EXECUTION_RPC[number];
/** Optional mTLS-only owner. No personal Bearer or caller tenant reaches it. */
export abstract class StoreNodeExecutionRuntime {
  abstract execute(peer: StoreNodePeer, operation: StoreNodeExecutionRpc, raw: unknown): Promise<unknown>;
}
