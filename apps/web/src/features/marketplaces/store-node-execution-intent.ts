import { z } from "zod";
import { EntityIdSchema, createEntityId } from "@yummyai/contracts/common/ids";
import { CreateStoreNodeExecutionInputSchema, STORE_NODE_EXECUTION_OPERATION, storeNodeExecutionRequestText,
  type StoreNodeExecutionWorkspace } from "@yummyai/contracts/marketplace/store-node-execution";
import { SyncMarketplaceCapabilitiesInputSchema } from "@yummyai/contracts/marketplace/store";
import { StoreNodeExecutionError, storeNodeExecutionHash } from "./store-node-execution-client";

export const STORE_NODE_EXECUTION_INTENT_PREFIX = "yummyai.store-node-execution.intent.v1:";
export const StoreNodeExecutionIntentSchema = z.object({ version: z.literal(1), ownerScope: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: EntityIdSchema, requestChecksum: z.string().regex(/^[a-f0-9]{64}$/), executionId: EntityIdSchema.nullable(),
  state: z.enum(["prepared", "unknown", "known"]), createdAt: z.iso.datetime() }).strict();
export type StoreNodeExecutionIntent = z.infer<typeof StoreNodeExecutionIntentSchema>;
const key = (value: StoreNodeExecutionIntent) => `${STORE_NODE_EXECUTION_INTENT_PREFIX}${value.ownerScope}:${value.requestId.toLowerCase()}`;
const storageError = () => new StoreNodeExecutionError(0);
export const storeNodeExecutionOwnerScope = (preferenceScope: string, accountId: string) => storeNodeExecutionHash(`${preferenceScope}:${accountId.toLowerCase()}`);
export function readStoreNodeExecutionIntents(ownerScope: string, storage: Storage = sessionStorage) {
  const values: StoreNodeExecutionIntent[] = [];
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((value): value is string => value !== null && value.startsWith(STORE_NODE_EXECUTION_INTENT_PREFIX + ownerScope + ":"));
    for (const name of keys) { const text = storage.getItem(name); if (!text || text.length > 4096) throw storageError();
      const parsed = StoreNodeExecutionIntentSchema.safeParse(JSON.parse(text));
      if (!parsed.success || parsed.data.ownerScope !== ownerScope || key(parsed.data) !== name || (parsed.data.state === "known") !== (parsed.data.executionId !== null)) throw storageError();
      values.push(parsed.data); }
    return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch { throw storageError(); }
}
function store(value: StoreNodeExecutionIntent, storage: Storage) {
  try { const text = JSON.stringify(value); storage.setItem(key(value), text); if (storage.getItem(key(value)) !== text) throw storageError(); return value; }
  catch { throw storageError(); }
}
export function saveStoreNodeExecutionIntent(raw: StoreNodeExecutionIntent, storage: Storage = sessionStorage) {
  const value = StoreNodeExecutionIntentSchema.parse(raw);
  if (value.state !== "prepared" || value.executionId || readStoreNodeExecutionIntents(value.ownerScope, storage).length) throw new StoreNodeExecutionError(409);
  return store(value, storage);
}
export function updateStoreNodeExecutionIntent(raw: StoreNodeExecutionIntent, storage: Storage = sessionStorage) {
  const value = StoreNodeExecutionIntentSchema.parse(raw), prior = readStoreNodeExecutionIntents(value.ownerScope, storage).find(row => row.requestId === value.requestId);
  if (!prior || prior.createdAt !== value.createdAt || prior.requestChecksum !== value.requestChecksum || prior.executionId !== null && prior.executionId !== value.executionId ||
    prior.state === "known" && value.state !== "known" || (value.state === "known") !== (value.executionId !== null)) throw new StoreNodeExecutionError(409);
  return store(value, storage);
}
export function forgetStoreNodeExecutionIntent(raw: StoreNodeExecutionIntent, storage: Storage = sessionStorage) {
  const value = StoreNodeExecutionIntentSchema.parse(raw), prior = readStoreNodeExecutionIntents(value.ownerScope, storage).find(row => row.requestId === value.requestId);
  if (!prior || prior.requestChecksum !== value.requestChecksum || prior.executionId !== value.executionId) throw new StoreNodeExecutionError(409);
  try { storage.removeItem(key(prior)); if (storage.getItem(key(prior)) !== null) throw storageError(); } catch { throw storageError(); }
}
export function clearStoreNodeExecutionIntents(storage: Storage = sessionStorage) {
  for (const name of Array.from({ length: storage.length }, (_, index) => storage.key(index))) if (name?.startsWith(STORE_NODE_EXECUTION_INTENT_PREFIX)) storage.removeItem(name);
}
export async function prepareStoreNodeExecution(workspace: StoreNodeExecutionWorkspace, raw: unknown, ownerScope: string) {
  if (!workspace.binding.nodeId || !workspace.binding.certificateGeneration || !workspace.access.canSubmit) throw new StoreNodeExecutionError(409);
  const input = CreateStoreNodeExecutionInputSchema.parse({ nodeId: workspace.binding.nodeId, certificateGeneration: workspace.binding.certificateGeneration,
    authorizationGeneration: workspace.authorizationGeneration, bindingRevision: workspace.binding.revision, requestId: createEntityId(), requestChecksum: "0".repeat(64),
    operation: STORE_NODE_EXECUTION_OPERATION, input: SyncMarketplaceCapabilitiesInputSchema.parse(raw) });
  input.requestChecksum = await storeNodeExecutionHash(storeNodeExecutionRequestText(workspace.accountId, input));
  return { input, intent: StoreNodeExecutionIntentSchema.parse({ version: 1, ownerScope, requestId: input.requestId, requestChecksum: input.requestChecksum,
    executionId: null, state: "prepared", createdAt: new Date().toISOString() }) };
}
