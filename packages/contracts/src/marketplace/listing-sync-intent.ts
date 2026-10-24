import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { CreateMarketplaceListingSyncInputSchema, MarketplaceListingSyncRequestViewSchema } from "@yummyai/contracts/marketplace/listing-operations";
import { MarketplacePlatformSchema } from "@yummyai/contracts/marketplace/store";

export const LISTING_SYNC_INTENT_PROTOCOL = "erp-listing-sync-intent-v1" as const;
const Protocol = z.literal(LISTING_SYNC_INTENT_PROTOCOL);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ListingSyncIntentLookupSchema = z.object({ requestKey: EntityIdSchema, requestChecksum: Digest }).strict();
export const ListingSyncIntentReceiptSchema = z.object({ protocol: Protocol, requestKey: EntityIdSchema, requestChecksum: Digest,
  found: z.boolean(), request: MarketplaceListingSyncRequestViewSchema.nullable(), observedAt: z.iso.datetime() }).strict()
  .refine(value => value.found === (value.request !== null));
export const ListingSyncIntentSourceSchema = z.object({ accountId: EntityIdSchema, accountName: z.string().max(200),
  sourcePublicationRequestId: EntityIdSchema, listingVersionId: EntityIdSchema, platform: MarketplacePlatformSchema,
  marketplaceId: z.string().max(80), externalListingId: z.string().max(500) }).strict();
export const ListingSyncIntentWorkspaceSchema = z.object({ protocol: Protocol,
  context: z.object({ actorId: EntityIdSchema, tenantId: EntityIdSchema, authority: Digest }).strict(),
  listing: z.object({ id: EntityIdSchema, currentVersionId: EntityIdSchema.nullable(), status: z.string().max(80) }).strict(),
  access: z.object({ canSubmit: z.boolean(), canRead: z.literal(true) }).strict(),
  sources: z.array(ListingSyncIntentSourceSchema).max(100),
  recent: z.array(MarketplaceListingSyncRequestViewSchema).max(20),
  observedAt: z.iso.datetime() }).strict();

/** The original target is immutable. Today's mutable price/capability state is not an intent identity. */
export function listingSyncIntentRequestText(raw: z.input<typeof CreateMarketplaceListingSyncInputSchema>): string {
  const value = CreateMarketplaceListingSyncInputSchema.parse(raw);
  return JSON.stringify([LISTING_SYNC_INTENT_PROTOCOL, value.accountId.toLowerCase(), value.listingId.toLowerCase(),
    value.listingVersionId.toLowerCase(), value.sourcePublicationRequestId.toLowerCase(), value.action]);
}
export type ListingSyncIntentLookup = z.infer<typeof ListingSyncIntentLookupSchema>;
export type ListingSyncIntentReceipt = z.infer<typeof ListingSyncIntentReceiptSchema>;
export type ListingSyncIntentWorkspace = z.infer<typeof ListingSyncIntentWorkspaceSchema>;
export type ListingSyncIntentSource = z.infer<typeof ListingSyncIntentSourceSchema>;
