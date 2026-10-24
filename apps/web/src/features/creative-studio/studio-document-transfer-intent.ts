import { STUDIO_TRANSFER_INTENT_PREFIX, StudioTransferLookupSchema, StudioTransferPageSchema, StudioTransferRequestSchema, type StudioTransferLookup, type StudioTransferRequest } from "@yummyai/contracts/pod/studio-document-transfer";
export { STUDIO_TRANSFER_INTENT_PREFIX };
type Vault = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
const equal = (a: StudioTransferRequest, b: StudioTransferRequest) => a.scope === b.scope && a.targetScope === b.targetScope && a.requestId === b.requestId && a.manifestHash === b.manifestHash;
export function studioTransferTarget(value: string, origin: string) {
  const text = value.trim(), direct = StudioTransferRequestSchema.shape.targetScope.safeParse(text);
  if (direct.success) return direct.data;
  try {
    const url = new URL(text, origin);
    if (url.origin !== origin || url.username || url.password || !/^\/creative-designs\/(?:studio(?:\/(?:canvas|image|video|assets|prompts))?|canvas)\/?$/.test(url.pathname)) throw new Error("invalid target");
    return StudioTransferRequestSchema.shape.targetScope.parse(url.searchParams.get("brief"));
  } catch { throw new Error("请输入目标项目 UUID 或本站创作项目链接 原填写内容保持"); }
}
export function studioTransferVault(ownerHash: string, storage: Vault) {
  if (!/^[a-f0-9]{64}$/.test(ownerHash)) throw new Error("本人恢复标识尚未核对");
  const prefix = STUDIO_TRANSFER_INTENT_PREFIX + ownerHash + ":";
  const key = (request: StudioTransferRequest) => prefix + request.requestId;
  const read = () => {
    try {
      const result: StudioTransferRequest[] = [];
      for (let index = 0; index < storage.length; index++) {
        const at = storage.key(index); if (!at?.startsWith(prefix)) continue;
        const raw = storage.getItem(at); if (!raw || raw.length > 2048) throw new Error("invalid marker");
        const request = StudioTransferRequestSchema.parse(JSON.parse(raw)); if (key(request) !== at) throw new Error("invalid marker"); result.push(request);
      }
      return result;
    } catch { throw new Error("无法读取本人原复制请求 本次不建立新请求"); }
  };
  return { read,
    save(request: StudioTransferRequest) {
      const value = StudioTransferRequestSchema.parse(request), prior = read().find(item => item.scope === value.scope);
      if (prior && !equal(prior, value)) throw new Error("仍有原复制请求待核对 不更换编号或原输入");
      try { const text = JSON.stringify(value); storage.setItem(key(value), text); if (storage.getItem(key(value)) !== text) throw new Error("unproven"); }
      catch { throw new Error("原复制请求未能可靠保存 本次未发送 请检查浏览器存储"); }
    },
    forget(request: StudioTransferRequest) {
      const prior = read().find(item => item.requestId === request.requestId);
      if (!prior || !equal(prior, request)) throw new Error("原恢复标识已变化 未清除其他请求");
      try { storage.removeItem(key(request)); if (storage.getItem(key(request)) !== null) throw new Error("unproven"); }
      catch { throw new Error("原恢复标识尚未清除 未建立第二份复制"); }
    },
  };
}
export function clearStudioTransferIntents(storage: Vault) {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => !!key?.startsWith(STUDIO_TRANSFER_INTENT_PREFIX));
  for (const key of keys) storage.removeItem(key);
}
export function createStudioDocumentTransfer(options: { scope: string; current: () => void; vault: ReturnType<typeof studioTransferVault>; call: (input: Record<string, unknown>) => Promise<unknown> }) {
  const proof = new Map<string, StudioTransferLookup>(), listed = new Map<string, StudioTransferLookup>();
  const originals = () => { options.current(); return options.vault.read().filter(item => item.scope === options.scope); };
  const known = (request: StudioTransferRequest) => {
    options.current(); if (request.scope !== options.scope) throw new Error("复制请求属于原工作区");
    const prior = options.vault.read().find(item => item.requestId === request.requestId);
    if (!prior || !equal(prior, request)) throw new Error("原复制请求已清除或变化 迟到操作未采用");
  };
  const invoke = async (operation: "document.prepare" | "document.commit" | "document.lookup" | "document.cancel", request: StudioTransferRequest) => {
    known(request); const result = StudioTransferLookupSchema.parse(await options.call({ operation, ...request })); options.current(); known(request);
    if (!equal(result.request, request) || result.receipt && (result.receipt.requestId !== request.requestId || result.receipt.manifestHash !== request.manifestHash || result.receipt.sourceScope !== request.scope || result.receipt.targetScope !== request.targetScope) || operation === "document.commit" && result.status !== "committed") throw new Error("原复制响应与固定输入不一致 请只读核对原请求");
    proof.set(request.requestId, structuredClone(result)); return result;
  };
  const requests = async (cursor?: string) => {
    options.current(); if (cursor !== undefined) StudioTransferPageSchema.shape.nextCursor.unwrap().parse(cursor);
    const page = StudioTransferPageSchema.parse(await options.call({ operation: "document.requests", scope: options.scope, limit: 25, ...(cursor ? { cursor } : {}) })); options.current();
    if (page.nextCursor && cursor && page.nextCursor.toLowerCase() >= cursor.toLowerCase()) throw new Error("复制历史游标未向更早记录推进 已停止读取 原请求保持");
    if (new Set(page.items.map(item => item.request.requestId)).size !== page.items.length || page.items.some(item => item.request.scope !== options.scope || item.status === "missing" || listed.has(item.request.requestId) && !equal(listed.get(item.request.requestId)!.request, item.request))) throw new Error("复制历史与当前本人来源不一致 原请求未替换");
    options.current(); for (const item of page.items) listed.set(item.request.requestId, structuredClone(item));
    return page;
  };
  const restore = (request: StudioTransferRequest, serverResult: StudioTransferLookup) => {
    options.current(); const original = StudioTransferRequestSchema.parse(request), result = StudioTransferLookupSchema.parse(serverResult), checked = listed.get(original.requestId);
    if (original.scope !== options.scope || !equal(original, result.request) || !checked || JSON.stringify(checked) !== JSON.stringify(result)) throw new Error("请先读取本人的服务端复制历史 原请求未采用");
    const active = originals()[0];
    if (active && !equal(active, original)) throw new Error("当前原复制请求仍保留 请先只读核对并明确结束当前记录 再选择历史");
    options.vault.save(original); options.current(); return invoke("document.lookup", original);
  };
  const recover = async () => {
    const prior = originals()[0];
    if (prior) return { found: await invoke("document.lookup", prior), items: [] as StudioTransferLookup[], nextCursor: null as string | null, unavailableOnPage: 0, historyLoaded: false };
    const items: StudioTransferLookup[] = [], seen = new Set<string>(); let cursor: string | undefined, unavailableOnPage = 0, fallback: StudioTransferLookup | undefined;
    for (;;) {
      options.current(); const page = await requests(cursor); options.current();
      items.push(...page.items); unavailableOnPage += page.unavailableOnPage;
      fallback ??= page.items.find(item => item.status === "committed" || item.status === "cancelled");
      const prepared = page.items.find(item => item.status === "prepared"), selected = prepared ?? (!page.nextCursor ? fallback : undefined);
      if (selected || !page.nextCursor) return { found: selected ? await restore(selected.request, selected) : undefined, items, nextCursor: page.nextCursor, unavailableOnPage, historyLoaded: true };
      const next = page.nextCursor.toLowerCase(); if (seen.has(next)) throw new Error("复制历史游标重复 已停止读取 原请求保持");
      seen.add(next); cursor = page.nextCursor;
    }
  };
  return {
    originals, requests, restore, recover,
    prepare(request: StudioTransferRequest) { options.current(); if (request.scope !== options.scope) throw new Error("复制归属已变化"); options.vault.save(request); return invoke("document.prepare", request); },
    lookup: (request: StudioTransferRequest) => invoke("document.lookup", request),
    commit: (request: StudioTransferRequest) => invoke("document.commit", request),
    cancel: (request: StudioTransferRequest) => invoke("document.cancel", request),
    beginAnother(request: StudioTransferRequest, found: StudioTransferLookup) { known(request); const checked = proof.get(request.requestId);
      if (!checked || !equal(checked.request, request) || checked.status !== found.status || !["committed", "cancelled"].includes(checked.status) || !equal(found.request, request)) throw new Error("请先只读核对原复制已完成或取消");
      options.vault.forget(request); proof.delete(request.requestId);
    },
  };
}
