import { z } from "zod";
import { createEntityId, EntityIdSchema } from "@yummyai/contracts/common/ids";
import { CreatePublicationSubmitInputSchema, CreatePublicationStatusInputSchema, PublicationSubmitTargetSchema, PublicationStatusTargetSchema,
  publicationSubmitRequestText, publicationStatusRequestText, type PublicationSubmitTarget, type PublicationStatusTarget } from "@yummyai/contracts/marketplace/publication-submit";
import { publicationSubmitHash, PublicationSubmitError, submitSameId } from "./publication-submit-client";

export const PUBLICATION_SUBMIT_INTENT_PREFIX = "yummyai.publication-submit.intent.v1:";
export const PublicationSubmitIntentSchema = z.object({ version: z.literal(1), ownerScope: z.string().regex(/^[a-f0-9]{64}$/), operation: z.enum(["submit", "status"]),
  previewRequestId: EntityIdSchema, sourceId: EntityIdSchema, requestKey: EntityIdSchema, requestChecksum: z.string().regex(/^[a-f0-9]{64}$/), resultId: EntityIdSchema.nullable(),
  state: z.enum(["unknown", "known"]), createdAt: z.iso.datetime() }).strict().refine(value => (value.state === "known") === (value.resultId !== null));
export type PublicationSubmitIntent = z.infer<typeof PublicationSubmitIntentSchema>;
const storageError = () => new PublicationSubmitError(0);
const key = (value: PublicationSubmitIntent) => `${PUBLICATION_SUBMIT_INTENT_PREFIX}${value.ownerScope}:${value.requestKey.toLowerCase()}`;
export const publicationSubmitOwnerScope = (scope: string, listingId: string, versionId: string, previewId: string) => publicationSubmitHash(JSON.stringify([
  scope, ...[listingId, versionId, previewId].map(id => EntityIdSchema.parse(id.toLowerCase())),
]));
export function readPublicationSubmitIntents(ownerScope: string, storage: Storage = sessionStorage) {
  try {
    const rows: PublicationSubmitIntent[] = [], prefix = PUBLICATION_SUBMIT_INTENT_PREFIX + ownerScope + ":";
    for (const name of Array.from({ length: storage.length }, (_, index) => storage.key(index))) {
      if (!name?.startsWith(prefix)) continue; const text = storage.getItem(name); if (!text || text.length > 4096) throw storageError();
      const value = PublicationSubmitIntentSchema.parse(JSON.parse(text)); if (value.ownerScope !== ownerScope || name !== key(value)) throw storageError(); rows.push(value);
    }
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch { throw storageError(); }
}
function persist(value: PublicationSubmitIntent, storage: Storage) {
  try { const text = JSON.stringify(value); storage.setItem(key(value), text); if (storage.getItem(key(value)) !== text) throw storageError(); return value; } catch { throw storageError(); }
}
export async function preparePublicationSubmit(raw: PublicationSubmitTarget, ownerScope: string) {
  const target = PublicationSubmitTargetSchema.parse(raw), requestKey = createEntityId(), requestChecksum = await publicationSubmitHash(publicationSubmitRequestText(target));
  return { input: CreatePublicationSubmitInputSchema.parse({ ...target, requestKey, requestChecksum, acknowledgeReplacement: true }),
    intent: PublicationSubmitIntentSchema.parse({ version: 1, ownerScope, operation: "submit", previewRequestId: target.previewRequestId, sourceId: target.previewRequestId,
      requestKey, requestChecksum, resultId: null, state: "unknown", createdAt: new Date().toISOString() }) };
}
export async function preparePublicationStatus(raw: PublicationStatusTarget, previewRequestId: string, ownerScope: string) {
  const target = PublicationStatusTargetSchema.parse(raw), requestKey = createEntityId(), requestChecksum = await publicationSubmitHash(publicationStatusRequestText(target));
  return { input: CreatePublicationStatusInputSchema.parse({ ...target, requestKey, requestChecksum }),
    intent: PublicationSubmitIntentSchema.parse({ version: 1, ownerScope, operation: "status", previewRequestId: EntityIdSchema.parse(previewRequestId), sourceId: target.publicationRequestId,
      requestKey, requestChecksum, resultId: null, state: "unknown", createdAt: new Date().toISOString() }) };
}
export function savePublicationSubmitIntent(raw: PublicationSubmitIntent, storage: Storage = sessionStorage) {
  const value = PublicationSubmitIntentSchema.parse(raw), existing = readPublicationSubmitIntents(value.ownerScope, storage);
  if (value.state !== "unknown" || existing.some(row => row.state === "unknown" || row.operation === value.operation)) throw new PublicationSubmitError(409);
  return persist(value, storage);
}
export function recordPublicationSubmitIntent(raw: PublicationSubmitIntent, id: string, storage: Storage = sessionStorage) {
  const value = PublicationSubmitIntentSchema.parse(raw), resultId = EntityIdSchema.parse(id.toLowerCase()), old = readPublicationSubmitIntents(value.ownerScope, storage).find(row => submitSameId(row.requestKey, value.requestKey));
  if (!old || old.requestChecksum !== value.requestChecksum || old.sourceId !== value.sourceId || old.operation !== value.operation || old.previewRequestId !== value.previewRequestId ||
    old.createdAt !== value.createdAt || old.resultId && !submitSameId(old.resultId, resultId)) throw new PublicationSubmitError(409);
  return persist(PublicationSubmitIntentSchema.parse({ ...old, resultId, state: "known" }), storage);
}
export function forgetPublicationSubmitIntent(raw: PublicationSubmitIntent, storage: Storage = sessionStorage) {
  const value = PublicationSubmitIntentSchema.parse(raw), old = readPublicationSubmitIntents(value.ownerScope, storage).find(row => submitSameId(row.requestKey, value.requestKey));
  if (!old || old.state !== "known" || value.state !== "known" || old.resultId !== value.resultId || old.requestChecksum !== value.requestChecksum) throw new PublicationSubmitError(409);
  try { storage.removeItem(key(old)); if (storage.getItem(key(old)) !== null) throw storageError(); } catch { throw storageError(); }
}
