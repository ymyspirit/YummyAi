import { z } from "zod";
import { createEntityId, EntityIdSchema } from "@yummyai/contracts/common/ids";
import { CreateMarketplaceListingSyncInputSchema, type CreateMarketplaceListingSyncInput } from "@yummyai/contracts/marketplace/listing-operations";
import { ListingSyncError, listingSyncHash, listingSyncRequestChecksum } from "./listing-sync-client";

export const LISTING_SYNC_INTENT_PREFIX = "yummyai.listing-sync.intent.v1:";
export const ListingSyncStoredIntentSchema = z.object({ version: z.literal(1), ownerScope: z.string().regex(/^[a-f0-9]{64}$/),
  requestKey: EntityIdSchema, requestChecksum: z.string().regex(/^[a-f0-9]{64}$/), requestId: EntityIdSchema.nullable(),
  state: z.enum(["prepared", "unknown", "known"]), createdAt: z.iso.datetime() }).strict()
  .refine(value => (value.state === "known") === (value.requestId !== null));
export type ListingSyncStoredIntent = z.infer<typeof ListingSyncStoredIntentSchema>;
const storageError = () => new ListingSyncError(0);
const key = (value: ListingSyncStoredIntent) => `${LISTING_SYNC_INTENT_PREFIX}${value.ownerScope}:${value.requestKey.toLowerCase()}`;
export const listingSyncOwnerScope = (preferenceScope: string, listingId: string) => listingSyncHash(`${preferenceScope}:${listingId.toLowerCase()}`);
export function readListingSyncIntents(ownerScope: string, storage: Storage = sessionStorage) {
  try {
    const values: ListingSyncStoredIntent[] = [], prefix = LISTING_SYNC_INTENT_PREFIX + ownerScope + ":";
    for (const name of Array.from({ length: storage.length }, (_, index) => storage.key(index))) {
      if (!name?.startsWith(prefix)) continue; const text = storage.getItem(name); if (!text || text.length > 4096) throw storageError();
      const parsed = ListingSyncStoredIntentSchema.safeParse(JSON.parse(text));
      if (!parsed.success || parsed.data.ownerScope !== ownerScope || key(parsed.data) !== name) throw storageError(); values.push(parsed.data);
    }
    return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch { throw storageError(); }
}
function persist(value: ListingSyncStoredIntent, storage: Storage) {
  try { const text = JSON.stringify(value); storage.setItem(key(value), text); if (storage.getItem(key(value)) !== text) throw storageError(); return value; }
  catch { throw storageError(); }
}
/** Persisted before POST. Even a preparation interrupted after this point is recovered by GET only. */
export function saveListingSyncIntent(raw: ListingSyncStoredIntent, storage: Storage = sessionStorage) {
  const value = ListingSyncStoredIntentSchema.parse(raw);
  if (value.state !== "unknown" || readListingSyncIntents(value.ownerScope, storage).length) throw new ListingSyncError(409);
  return persist(value, storage);
}
export function recordListingSyncRequest(raw: ListingSyncStoredIntent, requestId: string, storage: Storage = sessionStorage) {
  const value = ListingSyncStoredIntentSchema.parse(raw), id = EntityIdSchema.parse(requestId),
    prior = readListingSyncIntents(value.ownerScope, storage).find(row => row.requestKey === value.requestKey);
  if (!prior || prior.requestChecksum !== value.requestChecksum || prior.createdAt !== value.createdAt || prior.requestId !== null && prior.requestId !== id) throw new ListingSyncError(409);
  return persist(ListingSyncStoredIntentSchema.parse({ ...prior, state: "known", requestId: id }), storage);
}
/** The UI calls this only after explicitly reading the known original request. Unknown markers cannot be discarded. */
export function forgetKnownListingSyncIntent(raw: ListingSyncStoredIntent, storage: Storage = sessionStorage) {
  const value = ListingSyncStoredIntentSchema.parse(raw), prior = readListingSyncIntents(value.ownerScope, storage).find(row => row.requestKey === value.requestKey);
  if (!prior || prior.state !== "known" || value.state !== "known" || prior.requestId !== value.requestId || prior.requestChecksum !== value.requestChecksum) throw new ListingSyncError(409);
  try { storage.removeItem(key(prior)); if (storage.getItem(key(prior)) !== null) throw storageError(); } catch { throw storageError(); }
}
export async function prepareListingSyncRequest(raw: Omit<CreateMarketplaceListingSyncInput, "requestKey">, ownerScope: string) {
  const input = CreateMarketplaceListingSyncInputSchema.parse({ ...raw, requestKey: createEntityId() }), requestChecksum = await listingSyncRequestChecksum(input);
  return { input, intent: ListingSyncStoredIntentSchema.parse({ version: 1, ownerScope, requestKey: input.requestKey,
    requestChecksum, requestId: null, state: "unknown", createdAt: new Date().toISOString() }) };
}
