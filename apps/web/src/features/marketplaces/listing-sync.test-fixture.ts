import { createHash } from "node:crypto";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { CreateMarketplaceListingSyncInputSchema, MarketplaceListingSyncRequestViewSchema } from "@yummyai/contracts/marketplace/listing-operations";
import { ListingSyncIntentWorkspaceSchema, LISTING_SYNC_INTENT_PROTOCOL, listingSyncIntentRequestText } from "@yummyai/contracts/marketplace/listing-sync-intent";

export const syncIds = { actor: "019f1000-0000-7000-8000-000000000001", tenant: "019f1000-0000-7000-8000-000000000002",
  listing: "019f1000-0000-7000-8000-000000000003", version: "019f1000-0000-7000-8000-000000000004", source: "019f1000-0000-7000-8000-000000000005",
  account: "019f1000-0000-7000-8000-000000000006", key: "019f1000-0000-7000-8000-000000000007", request: "019f1000-0000-7000-8000-000000000008",
  event: "019f1000-0000-7000-8000-000000000009", other: "019f1000-0000-7000-8000-000000000010" };
export const syncActor: ErpSessionView = { authenticated: true, canUseErp: true, userId: syncIds.actor, tenantId: syncIds.tenant, permissions: ["listing:read", "listing:publish"],
  dataScope: "tenant", teamIds: [], displayName: "Synthetic operator", organizationName: "Synthetic organization" };
export const syncAuthority = createHash("sha256").update(erpSessionAuthority(syncActor)).digest("hex");
export const syncContext = { listingId: syncIds.listing, actorId: syncIds.actor, tenantId: syncIds.tenant, authority: syncAuthority };
export const syncInput = () => CreateMarketplaceListingSyncInputSchema.parse({ accountId: syncIds.account, listingId: syncIds.listing, listingVersionId: syncIds.version,
  sourcePublicationRequestId: syncIds.source, action: "read", requestKey: syncIds.key });
export const syncChecksum = () => createHash("sha256").update(listingSyncIntentRequestText(syncInput())).digest("hex");
export const syncView = () => MarketplaceListingSyncRequestViewSchema.parse({ id: syncIds.request, ...syncInput(), requestKey: undefined, platform: "amazon", marketplaceId: "ATVPDKIKX0DER",
  externalListingId: "SYNTHETIC-ORIGINAL-SKU", idempotencyKey: "a".repeat(64), desiredChecksum: "b".repeat(64), createdBy: syncIds.actor, createdAt: "2026-10-22T10:00:00.000Z",
  current: { id: syncIds.event, sequence: 1, status: "completed", code: null, message: null, issues: [], snapshotChecksum: "c".repeat(64), retryable: false,
    occurredAt: "2026-10-22T10:01:00.000Z", snapshot: { externalState: "BUYABLE", content: { title: "Synthetic original content" },
      price: { currency: "USD", amountMinor: 123 }, inventory: { quantity: 0 }, observedAt: "2026-10-22T10:01:00.000Z" } } });
export const syncReceipt = (found = true) => ({ protocol: LISTING_SYNC_INTENT_PROTOCOL, requestKey: syncIds.key, requestChecksum: syncChecksum(), found,
  request: found ? syncView() : null, observedAt: "2026-10-22T10:02:00.000Z" });
export const syncWorkspace = () => ListingSyncIntentWorkspaceSchema.parse({ protocol: LISTING_SYNC_INTENT_PROTOCOL, context: { actorId: syncIds.actor, tenantId: syncIds.tenant, authority: syncAuthority },
  listing: { id: syncIds.listing, currentVersionId: syncIds.version, status: "approved" }, access: { canSubmit: true, canRead: true },
  sources: [{ accountId: syncIds.account, accountName: "Synthetic original account", sourcePublicationRequestId: syncIds.source, listingVersionId: syncIds.other,
    platform: "amazon", marketplaceId: "ATVPDKIKX0DER", externalListingId: "SYNTHETIC-ORIGINAL-SKU" }], recent: [], observedAt: "2026-10-22T10:02:00.000Z" });
export const syncResponse = (data: unknown, status = 200) => Response.json(data, { status, headers: { "x-yummyai-context-authority": syncAuthority } });
export function syncStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear() { values.clear(); }, getItem(key) { return values.get(key) ?? null; }, key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); }, setItem(key, value) { values.set(key, value); } };
}
