import { createHash } from "node:crypto";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { CreateStoreNodeExecutionInputSchema, StoreNodeExecutionViewSchema, StoreNodeExecutionWorkspaceSchema,
  STORE_NODE_EXECUTION_OPERATION, STORE_NODE_EXECUTION_PROTOCOL, storeNodeExecutionRequestText } from "@yummyai/contracts/marketplace/store-node-execution";

export const executionIds = { account: "019f1000-0000-7000-8000-000000000001", actor: "019f1000-0000-7000-8000-000000000002", tenant: "019f1000-0000-7000-8000-000000000003",
  node: "019f1000-0000-7000-8000-000000000004", generation: "019f1000-0000-7000-8000-000000000005", request: "019f1000-0000-7000-8000-000000000006",
  execution: "019f1000-0000-7000-8000-000000000007", snapshot: "019f1000-0000-7000-8000-000000000008", other: "019f1000-0000-7000-8000-000000000009" };
export const executionActor: ErpSessionView = { authenticated: true, canUseErp: true, userId: executionIds.actor, tenantId: executionIds.tenant,
  permissions: ["store:read", "store:manage"], dataScope: "tenant", teamIds: [], displayName: "Synthetic operator", organizationName: "Synthetic isolated organization" };
export const executionAuthority = createHash("sha256").update(erpSessionAuthority(executionActor)).digest("hex");
export const executionContext = { accountId: executionIds.account, actorId: executionIds.actor, tenantId: executionIds.tenant, authority: executionAuthority };
export function executionInput() {
  const input = CreateStoreNodeExecutionInputSchema.parse({ nodeId: executionIds.node, certificateGeneration: 2, authorizationGeneration: executionIds.generation,
    bindingRevision: 3, requestId: executionIds.request, requestChecksum: "0".repeat(64), operation: STORE_NODE_EXECUTION_OPERATION,
    input: { amazonProductTypes: ["HOME"], etsyTaxonomyNodeIds: [], ttlHours: 24 } });
  input.requestChecksum = createHash("sha256").update(storeNodeExecutionRequestText(executionIds.account, input)).digest("hex"); return input;
}
export function executionWorkspace() {
  return StoreNodeExecutionWorkspaceSchema.parse({ protocol: STORE_NODE_EXECUTION_PROTOCOL, accountId: executionIds.account, platform: "amazon", authorizationMode: "amazon_private",
    accountStatus: "pending_authorization", authorizationGeneration: executionIds.generation,
    context: { actorId: executionIds.actor, tenantId: executionIds.tenant, authority: executionAuthority },
    binding: { revision: 3, nodeId: executionIds.node, certificateGeneration: 2, state: "active", online: false, lastSeenAt: "2026-10-22T10:00:00.000Z" },
    access: { canSubmit: true, canCancel: true }, configuration: { enabled: true, operationSupported: true, reason: "ready" },
    operations: [STORE_NODE_EXECUTION_OPERATION], recent: [], observedAt: "2026-10-22T10:02:00.000Z" });
}
export function executionView(success = false) {
  const input = executionInput();
  return StoreNodeExecutionViewSchema.parse({ ...input, id: executionIds.execution, state: success ? "succeeded" : "waiting_node", phase: success ? "finished" : "queued", errorCode: null,
    createdAt: "2026-10-22T10:01:00.000Z", updatedAt: "2026-10-22T10:02:00.000Z", expiresAt: "2026-10-22T11:00:00.000Z",
    startedAt: success ? "2026-10-22T10:01:10.000Z" : null, completedAt: success ? "2026-10-22T10:02:00.000Z" : null, canCancel: !success,
    snapshotId: success ? executionIds.snapshot : null, snapshotVersion: success ? 7 : null,
    snapshot: success ? { id: executionIds.snapshot, accountId: executionIds.account, platform: "amazon", version: 7, externalAccountId: "synthetic-original-seller",
      marketplaceIds: ["ATVPDKIKX0DER"], capabilities: ["listing_read"], sourceVersion: "synthetic-native-capability-v1", sourceChecksum: "a".repeat(43),
      data: { synthetic: "original capability result" }, syncedAt: "2026-10-22T10:02:00.000Z", expiresAt: "2026-10-23T10:02:00.000Z", stale: false } : null });
}
export const executionReceipt = (found = true) => ({ protocol: STORE_NODE_EXECUTION_PROTOCOL, accountId: executionIds.account, requestId: executionIds.request,
  requestChecksum: executionInput().requestChecksum, found, execution: found ? executionView() : null, observedAt: "2026-10-22T10:02:00.000Z" });
export const executionResponse = (body: unknown, status = 200) => Response.json(body, { status, headers: { "x-yummyai-context-authority": executionAuthority } });
export function executionStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear() { values.clear(); }, getItem(name) { return values.get(name) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; }, removeItem(name) { values.delete(name); }, setItem(name, value) { values.set(name, value); } };
}
