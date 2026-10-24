import { StudioResultIntentSchema, StudioResultLookupSchema, StudioPinnedResultRequestSchema, STUDIO_RESULT_INTENT_PREFIX, studioResultIntentKey, type StudioResultIntent, type StudioPinnedResultRequest, type StudioResultLookup } from "@yummyai/contracts/pod/studio-original";
import { CanvasResultReceiptSchema } from "@yummyai/contracts/pod/canvas-bridge";

type Call = <T>(input: Record<string, unknown>) => Promise<T>;
export type StoredResultIntent = { key: string; revision: number; value: StudioResultIntent };
type StateRead = { revision: number; value: unknown };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** An intent is stored before its first submit. Recovery only looks up this
 * frozen input; a missing receipt never authorizes a replacement request. */
export function createStudioResultIntents(scope: string, call: Call, current: () => void) {
  const read = async (key: string): Promise<StoredResultIntent | null> => {
    current(); const result = await call<StateRead>({ operation: "state.get", namespace: "app_state", key }); current();
    if (result.value === null) return null;
    const value = StudioResultIntentSchema.parse(result.value);
    if (value.request.scope !== scope || studioResultIntentKey(value.request.source) !== key) throw new Error("原送审意图与当前项目不一致 请保留记录并核对");
    return { key, revision: result.revision, value };
  };
  const persist = async (key: string, revision: number, value: StudioResultIntent) => {
    current();
    await call({ operation: "state.set", namespace: "app_state", key, revision, value });
    // Even a positive transport acknowledgement is not the persisted-input proof.
    const saved = await read(key);
    if (!saved || saved.revision !== revision + 1 || !same(saved.value, value)) throw new Error("送审意图保存结果尚未核对 请读取原记录 未提交方案");
    return saved;
  };
  return {
    read,
    async list() {
      current(); const keys = await call<string[]>({ operation: "state.keys", namespace: "app_state" }); current();
      const found: StoredResultIntent[] = [], failures: string[] = [];
      const queue = keys.filter(key => key.startsWith(STUDIO_RESULT_INTENT_PREFIX));
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (;;) { current(); const key = queue.shift(); if (!key) return;
          try { const item = await read(key); if (item) found.push(item); }
          catch { current(); failures.push(key); }
        }
      }));
      current(); return { items: found.sort((a, b) => a.key.localeCompare(b.key)), unreadable: failures.length };
    },
    async prepare(raw: StudioPinnedResultRequest, replaceConfirmed = false) {
      const request = StudioPinnedResultRequestSchema.parse(raw);
      if (request.scope !== scope) throw new Error("送审项目已变化");
      const key = studioResultIntentKey(request.source);
      current(); const original = await read(key); current();
      if (original && (original.value.status !== "confirmed" || !replaceConfirmed)) return { item: original, created: false };
      // A confirmed intent may be superseded only by a separate explicit action.
      // CAS history preserves the previous request and its receipt.
      let revision = original?.revision;
      if (revision === undefined) {
        const empty = await call<StateRead>({ operation: "state.get", namespace: "app_state", key });
        if (empty.value !== null) throw new Error("原送审意图已由另一页面建立 请先只读找回");
        revision = empty.revision;
      }
      current();
      const value = StudioResultIntentSchema.parse({ version: 1, status: "prepared", request });
      return { item: await persist(key, revision, value), created: true };
    },
    async lookup(item: StoredResultIntent): Promise<StudioResultLookup> {
      current(); const input = StudioResultIntentSchema.parse(item.value).request;
      const result = StudioResultLookupSchema.parse(await call({ ...input, operation: "result.lookup" })); current();
      if (result.status === "found" && result.receipt.batchId !== scope) throw new Error("原回执不属于当前创意项目");
      return result;
    },
    async submit(item: StoredResultIntent) {
      // Read the exact durable revision again immediately before an operator's
      // explicit submit. No generated replacement ID is allowed here.
      const stored = await read(item.key);
      if (!stored || stored.revision !== item.revision || !same(stored.value.request, item.value.request)) throw new Error("原送审意图已有其他版本 请先只读核对");
      current();
      const receipt = CanvasResultReceiptSchema.strict().parse(await call(stored.value.request)); current();
      if (receipt.batchId !== scope) throw new Error("送审回执不属于当前项目");
      return receipt;
    },
    async record(item: StoredResultIntent, status: "unknown" | "confirmed", receipt?: unknown) {
      const stored = await read(item.key);
      if (!stored || !same(stored.value.request, item.value.request)) throw new Error("原送审意图已有其他版本 请保留原回执核对");
      if (stored.value.status === "confirmed" && status === "unknown") return stored;
      const value = StudioResultIntentSchema.parse({ version: 1, status, request: stored.value.request, ...(status === "confirmed" ? { receipt } : {}) });
      if (same(value, stored.value)) return stored;
      return persist(item.key, stored.revision, value);
    },
  };
}
