import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { VisualDeliverySnapshotSchema, type ProductVisualProject, type VisualSlotKey } from "@yummyai/contracts/catalog/product-visuals";
import { CancelProductVisualImageSchema, CommitProductVisualImageSchema, PrepareProductVisualImageSchema, ProductVisualImageAddressSchema, ProductVisualImageOriginalSchema } from "@yummyai/contracts/catalog/product-visual-generation";
import { StudioPaidImageAbandonSchema, StudioPaidImageInputSchema, StudioPaidImageLookupSchema, StudioPaidImagePageSchema, publicStudioPaidImageError, type StudioPaidImageInput } from "@yummyai/contracts/pod/studio-paid-image";
import { assertStudioCurrent, StudioApiError, type StudioRequestContext } from "../creative-studio/studio-api";
import { createStudioImageGenerationClient } from "../creative-studio/studio-image-generation-client";

export const PRODUCT_VISUAL_DEFAULT_PROMPT = "按本步骤固定需求生成一张可审核候选。";
type Draft = { snapshot: ProductVisualProject["snapshot"]; slotKey: VisualSlotKey; selectionRevision: string; artworkVersionId?: string; prompt: string };
export function productVisualImageDraft(value: Draft): Omit<StudioPaidImageInput, "requestId"> {
  return { capability: "image", modelId: value.snapshot.modelId, selectionRevision: value.selectionRevision,
    visualSlotKey: value.slotKey, ...(value.slotKey !== "artwork" ? { visualArtworkVersionId: value.artworkVersionId } : {}),
    referenceKeys: [], prompt: value.prompt.trim() || PRODUCT_VISUAL_DEFAULT_PROMPT, size: value.snapshot.size,
    quality: "high", background: value.slotKey === "artwork" ? "transparent" : "opaque", seconds: 4 };
}

/** The catalog owns model, size, references and the real slot/project mapping.
 * Only this adapter addresses its producer endpoints. The shared intent keeps
 * the same original marker and never turns a lookup into a submit. */
export function createProductVisualGenerationClient(options: {
  planId: string; project: ProductVisualProject; slotKey: VisualSlotKey; context: StudioRequestContext; fetch?: typeof fetch;
}) {
  const context = options.context, transport = options.fetch ?? globalThis.fetch;
  const snapshot = VisualDeliverySnapshotSchema.parse({ ...options.project.snapshot, slotKey: options.slotKey });
  const matches = options.project.slots.filter(slot => slot.slotKey === options.slotKey);
  if (matches.length !== 1 || snapshot.salesPlanId !== options.planId || snapshot.groupId !== options.project.id)
    throw new StudioApiError("原交付的步骤与项目映射尚未核对 未猜测项目或调用模型", 409);
  const scope = ProductVisualImageOriginalSchema.shape.scope.parse(matches[0]!.projectId);
  const studio = createStudioImageGenerationClient({ scope, context });
  const base = `/api/sales-plans/${encodeURIComponent(options.planId)}/launch/visuals/${encodeURIComponent(options.project.id)}`;
  const current = () => { assertStudioCurrent(context); studio.current(); };
  async function request(path: string, body?: unknown): Promise<unknown> {
    current();
    const response = await transport(base + path, { method: body === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin",
      headers: { "x-yummyai-context-authority": context.authority, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]) });
    try { current(); } catch (cause) { await response.body?.cancel().catch(() => undefined); throw cause; }
    if (response.ok && response.headers.get("x-yummyai-context-authority") !== context.authority) {
      await response.body?.cancel().catch(() => undefined); throw new StudioApiError("当前本人身份已变化 旧交付回执未采用", 409, "authority_changed");
    }
    const maximum = 2 * 1024 * 1024, length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)
      || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      await response.body?.cancel().catch(() => undefined); throw new StudioApiError("原交付回执格式或大小无法核对 原编号保持", 502);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new StudioApiError("原交付回执正文不可读取 原编号保持", 502);
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { current(); const part = await reader.read(); current(); if (part.done) break; size += part.value.byteLength;
        if (size > maximum) throw new StudioApiError("原交付回执超过读取上限 原编号保持", 502); chunks.push(part.value); }
      if (length !== null && size !== Number(length)) throw new StudioApiError("原交付回执未完整读取 原编号保持", 502);
    } catch (cause) { await reader.cancel().catch(() => undefined); throw cause; } finally { reader.releaseLock(); }
    current(); const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new StudioApiError("原交付回执正文无法核对 原编号保持", 502); }
    current();
    if (!response.ok) {
      const code = value && typeof value === "object" && "code" in value ? value.code : undefined;
      const known = publicStudioPaidImageError(code, response.status);
      throw new StudioApiError(known?.message ?? (response.status === 401 ? "本人登录已失效 原交付内容已隐藏" : response.status === 403 ? "当前本人没有原交付读取或操作权限"
        : response.status === 404 ? "原交付不存在或当前不可读取" : "原操作结果尚未核对 请保留原编号并只读读取"), response.status, known?.code);
    }
    return value;
  }
  async function checked(raw: unknown, expected?: Parameters<typeof studio.checkRequest>[1]) {
    const value = await studio.checkRequest(raw, expected); current();
    if (!value.quote.visualDelivery || canonicalJson(value.quote.visualDelivery) !== canonicalJson(snapshot)
      || value.originalInput.referenceKeys.length || value.originalInput.modelId !== snapshot.modelId
      || value.originalInput.visualSlotKey !== options.slotKey) throw new StudioApiError("原交付回执与本方案 步骤或固定输入不一致 原编号保持", 502);
    return value;
  }
  return {
    ...studio,
    checkRequest: checked,
    async prepare(input: StudioPaidImageInput) {
      const original = StudioPaidImageInputSchema.parse(input);
      const expected = { ...productVisualImageDraft({ snapshot, slotKey: options.slotKey, selectionRevision: original.selectionRevision,
        artworkVersionId: original.visualArtworkVersionId, prompt: original.prompt }), requestId: original.requestId };
      if (canonicalJson(original) !== canonicalJson(expected)) throw new StudioApiError("本张输入未对应原交付固定参数 未发送准备", 409);
      const body = PrepareProductVisualImageSchema.parse({ requestId: original.requestId, slotKey: options.slotKey,
        selectionRevision: original.selectionRevision, ...(original.visualArtworkVersionId ? { artworkVersionId: original.visualArtworkVersionId } : {}), prompt: original.prompt });
      return checked(await request("/images/prepare", body), { requestId: original.requestId, input: original });
    },
    async commit(requestId: string, quoteHash: string) {
      const body = CommitProductVisualImageSchema.parse({ slotKey: options.slotKey, requestId, quoteHash, confirmed: true });
      return checked(await request("/images/commit", body), { requestId, quoteHash });
    },
    async lookup(requestId: string) {
      const address = ProductVisualImageAddressSchema.parse({ slotKey: options.slotKey, requestId });
      const value = StudioPaidImageLookupSchema.parse(await request(`/images/by-request/${encodeURIComponent(address.requestId)}?slotKey=${address.slotKey}`)); current();
      if (value.status === "missing") { if (value.scope !== scope || value.requestId !== requestId) throw new StudioApiError("原编号查询归属不一致", 502); return value; }
      return { status: "found" as const, request: await checked(value.request, { requestId }) };
    },
    async requests(cursor?: string) {
      const query = new URLSearchParams({ slotKey: options.slotKey, limit: "20", ...(cursor ? { cursor } : {}) });
      const page = StudioPaidImagePageSchema.parse(await request(`/images?${query}`)); current();
      const items = []; const seen = new Set<string>();
      for (const item of page.items) { if (seen.has(item.requestId)) throw new StudioApiError("原交付历史含重复编号 未合并替代记录", 502); seen.add(item.requestId); items.push(await checked(item)); }
      return { items, nextCursor: page.nextCursor };
    },
    async cancel(requestId: string, quoteHash: string) {
      return checked(await request("/images/cancel", CancelProductVisualImageSchema.parse({ slotKey: options.slotKey, requestId, quoteHash })), { requestId, quoteHash });
    },
    async abandon(requestId: string) {
      const result = StudioPaidImageAbandonSchema.parse(await request("/images/abandon", ProductVisualImageAddressSchema.parse({ slotKey: options.slotKey, requestId }))); current();
      if (result.scope !== scope || result.requestId !== requestId) throw new StudioApiError("放弃回执与原交付编号不一致 原编号保持", 502); return result;
    },
    async prepareOriginal(requestValue: Parameters<typeof studio.preview>[0]) {
      const value = await checked(requestValue);
      if (value.status !== "completed" || !value.result || !value.generationId) throw new StudioApiError("原任务尚无已登记的完整原件", 409);
      const result = ProductVisualImageOriginalSchema.parse(await request("/prepare-original", ProductVisualImageAddressSchema.parse({ slotKey: options.slotKey, requestId: value.requestId }))); current();
      if (result.scope !== scope || result.slotKey !== options.slotKey || result.requestId !== value.requestId || result.generationId !== value.generationId
        || result.inspection.source.assetId !== value.result.assetId || result.inspection.source.namespace !== value.result.namespace
        || result.inspection.source.checksumSha256 !== value.result.checksumSha256 || result.inspection.source.byteSize !== value.result.byteSize
        || result.inspection.source.mediaType !== value.result.mediaType) throw new StudioApiError("原件检查回执不对应本次原任务与资产 未送审", 502);
      return result;
    },
  };
}
export type ProductVisualGenerationClient = ReturnType<typeof createProductVisualGenerationClient>;
