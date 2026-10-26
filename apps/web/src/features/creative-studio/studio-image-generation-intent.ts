import { z } from "zod";
import { ASSIST_INTENT_PREFIX } from "@yummyai/contracts/ai/assist-recovery";
import { StudioScopeSchema } from "@yummyai/contracts/pod/creative-studio";
import { StudioPaidImageAbandonSchema, StudioPaidImageInputSchema, StudioPaidImageRequestSchema, type StudioPaidImageInput, type StudioPaidImageRequest } from "@yummyai/contracts/pod/studio-paid-image";
import { studioImageHash, studioImageInputText, type StudioImageGenerationClient } from "./studio-image-generation-client";

export const STUDIO_IMAGE_GENERATION_INTENT_PREFIX = `${ASSIST_INTENT_PREFIX}studio-paid-image:v1:`;
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const MarkerSchema = z.object({ version: z.literal(1), scope: StudioScopeSchema, requestId: z.uuid(), inputHash: Hash,
  quoteHash: Hash.nullable(), commitHash: Hash.nullable() }).strict();
export type StudioImageGenerationMarker = z.infer<typeof MarkerSchema>;
export type StudioImageGenerationStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;
export type StudioImageGenerationSnapshot = {
  marker?: StudioImageGenerationMarker; request?: StudioPaidImageRequest; missing: boolean;
  abandoned?: ReturnType<typeof StudioPaidImageAbandonSchema.parse>;
  history: StudioPaidImageRequest[]; nextCursor: string | null;
};
export const studioImageTerminal = (request: StudioPaidImageRequest) => ["completed", "failed", "cancelled"].includes(request.status);
const commitText = (requestId: string, quoteHash: string) => JSON.stringify({ requestId, quoteHash, confirmed: true });

/** Only hashes and identifiers are durable. Terminal status is always obtained
 * from the server, never accepted from this browser marker. */
export function studioImageGenerationVault(ownerHash: string, scope: string, storage: StudioImageGenerationStorage) {
  const key = `${STUDIO_IMAGE_GENERATION_INTENT_PREFIX}${Hash.parse(ownerHash)}:${StudioScopeSchema.parse(scope)}`;
  const read = () => {
    const text = storage.getItem(key); if (text === null) return;
    try { if (text.length > 2048) throw new Error(); const marker = MarkerSchema.parse(JSON.parse(text)); if (marker.scope !== scope) throw new Error(); return marker; }
    catch { throw new Error("原生图标识无法核对 请保留原编号 不另起请求"); }
  };
  const write = (marker: StudioImageGenerationMarker) => {
    const parsed = MarkerSchema.parse(marker), text = JSON.stringify(parsed);
    if (parsed.scope !== scope) throw new Error("原生图标识属于其他范围");
    try { storage.setItem(key, text); if (storage.getItem(key) !== text) throw new Error(); }
    catch { throw new Error("浏览器未能保留原生图编号 未继续提交 请保留此页并只读核对"); }
    return parsed;
  };
  return {
    read,
    save(marker: StudioImageGenerationMarker) {
      const old = read();
      if (old && (old.requestId !== marker.requestId || old.inputHash !== marker.inputHash || old.quoteHash && old.quoteHash !== marker.quoteHash
        || old.commitHash && old.commitHash !== marker.commitHash)) throw new Error("已有原生图请求 未替换原编号或固定正文");
      return write(marker);
    },
    replace(expected: StudioImageGenerationMarker | undefined, marker: StudioImageGenerationMarker) {
      if (JSON.stringify(read()) !== JSON.stringify(expected)) throw new Error("原生图标识已变化 未切换历史记录");
      return write(marker);
    },
    forget(expected: StudioImageGenerationMarker) {
      if (JSON.stringify(read()) !== JSON.stringify(expected)) throw new Error("原生图标识已变化 未另起请求");
      storage.removeItem(key); if (storage.getItem(key) !== null) throw new Error("原生图标识未能清除 未另起请求");
    },
  };
}
export function clearStudioImageGenerationIntents(storage: StudioImageGenerationStorage) {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => !!key?.startsWith(STUDIO_IMAGE_GENERATION_INTENT_PREFIX));
  for (const key of keys) { storage.removeItem(key); if (storage.getItem(key) !== null) throw new Error("原生图标识未能清除"); }
}

/** The restricted-scope entry reads only this principal's recovery identifiers.
 * It does not read former project documents, quotes, assets or model catalogues. */
export function studioImagePreparationMarkers(ownerHash: string, storage: StudioImageGenerationStorage) {
  const prefix = `${STUDIO_IMAGE_GENERATION_INTENT_PREFIX}${Hash.parse(ownerHash)}:`;
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => !!key?.startsWith(prefix)).sort();
  const markers: StudioImageGenerationMarker[] = []; let invalid = 0;
  for (const key of keys.slice(0, 100)) {
    const scope = StudioScopeSchema.safeParse(key.slice(prefix.length));
    if (!scope.success) { invalid++; continue; }
    try { const marker = studioImageGenerationVault(ownerHash, scope.data, storage).read(); if (marker) markers.push(marker); else invalid++; }
    catch { invalid++; }
  }
  return { markers, invalid, limited: keys.length > 100 };
}
export async function abandonStudioImagePreparation(options: {
  ownerHash: string; marker: StudioImageGenerationMarker; storage: StudioImageGenerationStorage; current: () => void;
  abandon: (scope: string, requestId: string) => Promise<unknown>;
}) {
  options.current(); const marker = MarkerSchema.parse(options.marker), vault = studioImageGenerationVault(options.ownerHash, marker.scope, options.storage);
  const retained = () => { options.current(); if (JSON.stringify(vault.read()) !== JSON.stringify(marker)) throw new Error("原准备标识已变化 未放弃或替换编号"); };
  retained(); const proof = StudioPaidImageAbandonSchema.parse(await options.abandon(marker.scope, marker.requestId)); options.current(); retained();
  if (proof.scope !== marker.scope || proof.requestId !== marker.requestId) throw new Error("放弃凭据与原准备标识不一致 未清除原编号");
  vault.forget(marker); options.current(); return proof;
}

export function createStudioImageGenerationIntent(options: {
  client: StudioImageGenerationClient; ownerHash: string; storage: StudioImageGenerationStorage;
  current: () => void; id: () => string; now?: () => number;
}) {
  const client = options.client, vault = studioImageGenerationVault(options.ownerHash, client.scope, options.storage), now = options.now ?? Date.now;
  const state: StudioImageGenerationSnapshot = { missing: false, history: [], nextCursor: null };
  let busy = false;
  const current = () => { options.current(); client.current(); };
  const snapshot = () => { current(); return structuredClone(state); };
  const retained = () => {
    current(); const marker = state.marker;
    if (!marker || JSON.stringify(vault.read()) !== JSON.stringify(marker)) throw new Error("原生图标识已清除或变化 未重建请求");
    return marker;
  };
  async function exclusive<T>(action: () => Promise<T>) {
    current(); if (busy) throw new Error("原生图请求正在核对 请稍候"); busy = true;
    try { return await action(); } finally { busy = false; }
  }
  async function markerFrom(request: StudioPaidImageRequest) {
    const inputHash = await studioImageHash(studioImageInputText(request.originalInput)); current();
    const commitHash = ["prepared", "cancelled"].includes(request.status) ? null : await studioImageHash(commitText(request.requestId, request.quote.quoteHash)); current();
    return MarkerSchema.parse({ version: 1, scope: client.scope, requestId: request.requestId, inputHash, quoteHash: request.quote.quoteHash, commitHash });
  }
  async function apply(raw: StudioPaidImageRequest) {
    current(); const request = StudioPaidImageRequestSchema.parse(raw), marker = retained();
    const inputHash = await studioImageHash(studioImageInputText(request.originalInput)); current(); retained();
    if (request.scope !== client.scope || request.requestId !== marker.requestId || request.input.requestId !== marker.requestId || inputHash !== marker.inputHash
      || marker.quoteHash && request.quote.quoteHash !== marker.quoteHash) throw new Error("原生图结果不对应固定编号 输入或报价 请只读核对");
    const next = { ...marker, quoteHash: request.quote.quoteHash };
    state.marker = vault.save(next); current(); state.request = request; state.missing = false; state.abandoned = undefined;
    state.history = [request, ...state.history.filter(item => item.requestId !== request.requestId)].sort((a, b) => a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    return snapshot();
  }
  const mergePage = (items: StudioPaidImageRequest[], nextCursor: string | null) => {
    const all = new Map(state.history.map(item => [item.requestId, item])); for (const item of items) all.set(item.requestId, item);
    state.history = [...all.values()].sort((a, b) => a.id < b.id ? 1 : a.id > b.id ? -1 : 0); state.nextCursor = nextCursor;
  };
  async function readOriginal(marker: StudioImageGenerationMarker) {
    const result = await client.lookup(marker.requestId); current(); retained();
    if (result.status === "missing") { state.request = undefined; state.missing = true; return snapshot(); }
    return apply(result.request);
  }
  async function dispatch(action: () => Promise<StudioPaidImageRequest>) {
    state.request = undefined; state.missing = false; state.abandoned = undefined;
    const result = await action(); current(); return apply(result);
  }
  const canLeave = () => {
    if (!state.marker) return;
    const marker = retained();
    if (state.abandoned?.scope === client.scope && state.abandoned.requestId === marker.requestId) return;
    if (!state.request || !studioImageTerminal(state.request)) throw new Error("原准备或提交结果尚未终结 请先核对原编号 不能换新请求");
  };
  return {
    snapshot,
    read() { return exclusive(async () => {
      state.request = undefined; state.missing = false;
      const local = vault.read(); current();
      if (local) {
        state.marker = local; return readOriginal(local);
      }
      if (state.marker) throw new Error("原生图标识已变化 请关闭面板后从本人记录恢复");
      let cursor: string | undefined, fallback: StudioPaidImageRequest | undefined, selected: StudioPaidImageRequest | undefined;
      const seen = new Set<string>();
      for (;;) {
        current(); const page = await client.requests(cursor); current(); mergePage(page.items, page.nextCursor);
        fallback ??= page.items[0]; selected = page.items.find(item => !studioImageTerminal(item));
        if (selected || !page.nextCursor) break;
        if (seen.has(page.nextCursor) || cursor && page.nextCursor >= cursor) throw new Error("生图历史游标未向前推进 已停止读取");
        seen.add(page.nextCursor); cursor = page.nextCursor;
      }
      selected ??= fallback;
      if (!selected) return snapshot();
      const marker = await markerFrom(selected); current(); state.marker = vault.save(marker); current();
      return readOriginal(marker);
    }); },
    history() { return exclusive(async () => {
      const page = await client.requests(); current(); mergePage(page.items, page.nextCursor); return snapshot();
    }); },
    more() { return exclusive(async () => {
      const cursor = state.nextCursor; if (!cursor) return snapshot();
      const page = await client.requests(cursor); current();
      if (page.nextCursor && page.nextCursor >= cursor) throw new Error("生图历史游标未向前推进 已停止读取");
      mergePage(page.items, page.nextCursor); return snapshot();
    }); },
    choose(requestId: string) { return exclusive(async () => {
      if (state.marker?.requestId === requestId) return readOriginal(retained());
      canLeave(); const previous = state.marker, result = await client.lookup(requestId); current();
      if (result.status === "missing") throw new Error("这份原记录当前未找到 保留当前原编号");
      const marker = await markerFrom(result.request); current(); canLeave(); state.marker = vault.replace(previous, marker); current();
      return apply(result.request);
    }); },
    prepare(input: Omit<StudioPaidImageInput, "requestId">) { return exclusive(async () => {
      if (state.marker || vault.read()) throw new Error("已有原生图编号 请先核对或明确结束原准备");
      const parsed = StudioPaidImageInputSchema.parse({ ...input, requestId: options.id() }), inputHash = await studioImageHash(studioImageInputText(parsed)); current();
      const marker = MarkerSchema.parse({ version: 1, scope: client.scope, requestId: parsed.requestId, inputHash, quoteHash: null, commitHash: null });
      state.marker = vault.save(marker); current();
      return dispatch(() => client.prepare(parsed));
    }); },
    commit(acknowledgedHash: string) { return exclusive(async () => {
      const marker = retained(), request = state.request;
      if (!request || request.status !== "prepared" || marker.commitHash || marker.quoteHash !== acknowledgedHash || request.quote.quoteHash !== acknowledgedHash)
        throw new Error("没有当前可明确提交的原报价 请只读核对原请求");
      const assertQuote = () => {
        current(); if (!request.admission.enabled || request.admission.code !== "ready") throw new Error("真实付费生成尚未启用 已保存准备 未提交");
        if (request.quote.contextAuthority !== client.authority || new Date(request.quote.expiresAt).getTime() <= now()) throw new Error("原报价已过期或权限已变化 请取消尚未提交的准备后重新报价");
      };
      assertQuote(); const commitHash = await studioImageHash(commitText(marker.requestId, acknowledgedHash)); current(); retained(); assertQuote();
      state.marker = vault.save({ ...marker, commitHash }); current(); assertQuote();
      return dispatch(() => client.commit(marker.requestId, acknowledgedHash));
    }); },
    cancel() { return exclusive(async () => {
      const marker = retained(), request = state.request, quoteHash = marker.quoteHash;
      if (!request || request.status !== "prepared" || !quoteHash) throw new Error("仅可取消已核对且尚未提交的准备 提交结果未知时请先只读核对");
      return dispatch(() => client.cancel(marker.requestId, quoteHash));
    }); },
    abandon() { return exclusive(async () => {
      const marker = retained(); state.request = undefined; state.missing = false; state.abandoned = undefined;
      const result = StudioPaidImageAbandonSchema.parse(await client.abandon(marker.requestId)); current(); retained();
      if (result.scope !== client.scope || result.requestId !== marker.requestId) throw new Error("放弃凭据与原生图编号不一致 原编号保持");
      state.abandoned = result; return snapshot();
    }); },
    beginAnother() { return exclusive(async () => {
      canLeave(); const marker = retained(); vault.forget(marker); current(); state.marker = undefined; state.request = undefined; state.missing = false; state.abandoned = undefined; return snapshot();
    }); },
  };
}
