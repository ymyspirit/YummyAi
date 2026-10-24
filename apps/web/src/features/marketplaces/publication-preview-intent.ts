import { z } from "zod";
import { createEntityId, EntityIdSchema } from "@yummyai/contracts/common/ids";
import { PublicationPreviewTargetSchema, type PublicationPreviewTarget } from "@yummyai/contracts/marketplace/publication-preview";
import { previewHash, previewTargetChecksum, PublicationPreviewError, previewSameId } from "./publication-preview-client";

export const PUBLICATION_PREVIEW_INTENT_PREFIX = "yummyai.publication-preview.intent.v1:";
export const PublicationPreviewIntentSchema = z.object({ version: z.literal(1), ownerScope: z.string().regex(/^[a-f0-9]{64}$/),
  requestKey: EntityIdSchema, requestChecksum: z.string().regex(/^[a-f0-9]{64}$/), requestId: EntityIdSchema.nullable(),
  state: z.enum(["unknown", "known"]), createdAt: z.iso.datetime(), target: PublicationPreviewTargetSchema }).strict()
  .refine(value => (value.state === "known") === (value.requestId !== null));
export type PublicationPreviewIntent = z.infer<typeof PublicationPreviewIntentSchema>;
const storageError = () => new PublicationPreviewError(0);
const key = (value: PublicationPreviewIntent) => `${PUBLICATION_PREVIEW_INTENT_PREFIX}${value.ownerScope}:${value.requestKey.toLowerCase()}`;
export const publicationPreviewOwnerScope = (scope: string, listingId: string) => previewHash(`${scope}:${listingId.toLowerCase()}`);
export function readPublicationIntents(ownerScope: string, storage: Storage = sessionStorage) {
  try {
    const rows: PublicationPreviewIntent[] = [], prefix = PUBLICATION_PREVIEW_INTENT_PREFIX + ownerScope + ":";
    for (const name of Array.from({ length: storage.length }, (_, i) => storage.key(i))) {
      if (!name?.startsWith(prefix)) continue; const text = storage.getItem(name); if (!text || text.length > 8192) throw storageError();
      const value = PublicationPreviewIntentSchema.parse(JSON.parse(text)); if (value.ownerScope !== ownerScope || name !== key(value)) throw storageError(); rows.push(value);
    }
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch { throw storageError(); }
}
function persist(value: PublicationPreviewIntent, storage: Storage) {
  try { const text = JSON.stringify(value); storage.setItem(key(value), text); if (storage.getItem(key(value)) !== text) throw storageError(); return value; }
  catch { throw storageError(); }
}
export async function preparePublicationIntent(raw: PublicationPreviewTarget, ownerScope: string) {
  const target = PublicationPreviewTargetSchema.parse(raw), requestKey = createEntityId(), requestChecksum = await previewTargetChecksum(target);
  return { input: { ...target, requestKey, requestChecksum }, intent: PublicationPreviewIntentSchema.parse({ version: 1, ownerScope, requestKey, requestChecksum,
    requestId: null, state: "unknown", createdAt: new Date().toISOString(), target }) };
}
export function savePublicationIntent(raw: PublicationPreviewIntent, storage: Storage = sessionStorage) {
  const value = PublicationPreviewIntentSchema.parse(raw);
  if (value.state !== "unknown" || readPublicationIntents(value.ownerScope, storage).length) throw new PublicationPreviewError(409);
  return persist(value, storage);
}
export function recordPublicationIntent(raw: PublicationPreviewIntent, id: string, storage: Storage = sessionStorage) {
  const value = PublicationPreviewIntentSchema.parse(raw), requestId = EntityIdSchema.parse(id.toLowerCase()), old = readPublicationIntents(value.ownerScope, storage).find(row => previewSameId(row.requestKey, value.requestKey));
  if (!old || old.requestChecksum !== value.requestChecksum || old.createdAt !== value.createdAt || old.requestId && !previewSameId(old.requestId, requestId)) throw new PublicationPreviewError(409);
  return persist(PublicationPreviewIntentSchema.parse({ ...old, requestId, state: "known" }), storage);
}
export function forgetKnownPublicationIntent(raw: PublicationPreviewIntent, storage: Storage = sessionStorage) {
  const value = PublicationPreviewIntentSchema.parse(raw), old = readPublicationIntents(value.ownerScope, storage).find(row => previewSameId(row.requestKey, value.requestKey));
  if (!old || old.state !== "known" || value.state !== "known" || old.requestId !== value.requestId || old.requestChecksum !== value.requestChecksum) throw new PublicationPreviewError(409);
  try { storage.removeItem(key(old)); if (storage.getItem(key(old)) !== null) throw storageError(); } catch { throw storageError(); }
}
