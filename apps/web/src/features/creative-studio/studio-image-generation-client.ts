import { ErpContextAuthoritySchema } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { ConfigurationSnapshotSchema } from "@yummyai/contracts/ai/model-configuration";
import { StudioImagePricingSchema, type StudioImagePricing } from "@yummyai/contracts/ai/studio-image-pricing";
import { StudioScopeSchema } from "@yummyai/contracts/pod/creative-studio";
import { STUDIO_IMAGE_DRAFT_KEY } from "@yummyai/contracts/pod/studio-document-transfer";
import { StudioImageBudgetSettingsSchema, StudioImageBudgetWorkspaceSchema, type StudioImageBudgetSettings, type StudioImageBudgetWorkspace } from "@yummyai/contracts/pod/studio-image-budget";
import { StudioModelSchema, studioPersonalDataSchemas } from "@yummyai/contracts/pod/studio-personal";
import {
  StudioPaidImageAbandonSchema, StudioPaidImageInputSchema, StudioPaidImageLookupSchema, StudioPaidImagePageSchema, StudioPaidImageRequestSchema,
  type StudioPaidImageInput, type StudioPaidImageRequest,
} from "@yummyai/contracts/pod/studio-paid-image";
import { assertStudioCurrent, studioApi, studioRpc, StudioApiError, type StudioRequestContext } from "./studio-api";

export type StudioImageDraftProjection = {
  prompt: string; model: string; size: string; quality: "auto" | "low" | "medium" | "high";
  references: Array<{ key: string; name: string }>; revision: number; activeId: string;
};
export type StudioImageGenerationClient = ReturnType<typeof createStudioImageGenerationClient>;
export type StudioImageGenerationPage = ReturnType<typeof StudioPaidImagePageSchema.parse>;
const mismatch = () => new StudioApiError("生图记录与当前本人 原编号或固定报价不一致 旧内容未采用", 502);
export const studioImageInputText = (input: StudioPaidImageInput) => canonicalJson(StudioPaidImageInputSchema.parse(input));
export function studioImageDecimal(value: string, places: 6 | 8) {
  const match = /^(0|[1-9]\d{0,7})(?:\.(\d+))?$/.exec(value.trim());
  if (!match || (match[2]?.length ?? 0) > places) throw new Error(`金额最多保留 ${places} 位小数 请填写美元金额`);
  return `${match[1]}.${(match[2] ?? "").padEnd(places, "0")}`;
}
export async function studioImageHash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function studioImagePrincipal(authority: string) {
  const raw = JSON.parse(ErpContextAuthoritySchema.parse(authority)) as { tenantId: string; userId: string };
  return JSON.stringify([raw.tenantId, raw.userId]);
}

/** Only paid.image.* can create this slice's prepared request. Old generate,
 * generation.get and any provider polling are deliberately absent here. */
export function createStudioImageGenerationClient(options: {
  scope: string; context: StudioRequestContext;
  call?: (input: Record<string, unknown>) => Promise<unknown>;
  configure?: (input: Record<string, unknown>) => Promise<unknown>;
}) {
  const scope = StudioScopeSchema.parse(options.scope), context = options.context;
  const current = () => { assertStudioCurrent(context); if (context.localDevelopment) throw new StudioApiError("单张生图费用需要本人运营会话", 409); };
  const principal = studioImagePrincipal(context.authority);
  let budgetProof: StudioImageBudgetWorkspace | undefined;
  const invoke = async (input: Record<string, unknown>) => {
    current(); const result = await (options.call ? options.call(input) : studioRpc(scope, input, context.signal, context)); current(); return result;
  };
  async function checked(raw: unknown, expected?: { requestId: string; quoteHash?: string; input?: StudioPaidImageInput }) {
    current(); const parsed = StudioPaidImageRequestSchema.safeParse(raw); if (!parsed.success) throw mismatch();
    const value = parsed.data, quote = value.quote, input = value.input, original = value.originalInput;
    if (value.scope !== scope || value.requestId !== input.requestId || value.requestId !== original.requestId || input.capability !== "image"
      || original.modelId.toLowerCase() !== input.modelId.toLowerCase() || original.selectionRevision !== input.selectionRevision
      || studioImagePrincipal(quote.contextAuthority) !== principal || quote.modelId !== input.modelId
      || quote.selectionRevision !== input.selectionRevision || quote.size !== input.size || quote.quality !== input.quality || quote.background !== input.background
      || new Date(quote.expiresAt).getTime() <= new Date(quote.createdAt).getTime()
      || expected && (value.requestId !== expected.requestId || expected.quoteHash !== undefined && quote.quoteHash !== expected.quoteHash
        || expected.input !== undefined && studioImageInputText(original) !== studioImageInputText(expected.input))
      || value.status === "completed" && (!value.result || !value.generationId || !value.committedAt)) throw mismatch();
    const adoption = value.responseAdoption;
    if (adoption) {
      const artifact = adoption.artifacts[0], result = value.result;
      if (value.status !== "completed" || !value.generationId || !result || adoption.kind !== "studio_generation"
        || adoption.ownerId !== value.generationId || adoption.stepKey !== "generate" || adoption.parentId !== null && adoption.parentId !== scope
        || adoption.originalPhase !== value.execution.phase || adoption.originalCostUsd !== value.execution.costUsd
        || adoption.disposition !== "studio_image_ready" || adoption.artifacts.length !== 1 || !artifact
        || artifact.assetId !== result.assetId || artifact.version !== 1 || artifact.checksumSha256 !== result.checksumSha256
        || artifact.byteSize !== result.byteSize || artifact.mediaType !== result.mediaType) throw mismatch();
    }
    const visual = quote.visualDelivery;
    if (visual) {
      const background = visual.slotKey === "artwork" ? "transparent" : "opaque";
      if (scope === "unassigned" || visual.modelId !== input.modelId || visual.modelId !== original.modelId
        || visual.providerConfigId !== quote.providerConfigId || visual.providerFingerprint !== quote.providerFingerprint
        || input.visualSlotKey !== visual.slotKey || original.visualSlotKey !== visual.slotKey
        || input.size !== visual.size || original.size !== visual.size || input.quality !== "high" || original.quality !== "high"
        || input.background !== background || original.background !== background
        || input.visualArtworkVersionId !== original.visualArtworkVersionId
        || (visual.slotKey === "artwork" ? !!input.visualArtworkVersionId : !input.visualArtworkVersionId)
        || !quote.references.some(reference => reference.assetId === visual.sampleAssetId)) throw mismatch();
    } else if (input.visualSlotKey || original.visualSlotKey || input.visualArtworkVersionId || original.visualArtworkVersionId) throw mismatch();
    const inputHash = await studioImageHash(visual ? canonicalJson({ input, visualDelivery: visual }) : studioImageInputText(input)); current();
    const { quoteHash: fixedHash, ...fixed } = quote;
    const computedQuote = await studioImageHash(canonicalJson(fixed)); current();
    if (inputHash !== quote.inputFingerprint || fixedHash !== computedQuote) throw mismatch();
    return value;
  }
  function checkedBudget(raw: unknown) {
    current(); const parsed = StudioImageBudgetWorkspaceSchema.safeParse(raw);
    if (!parsed.success || Date.parse(parsed.data.periodEnd) <= Date.parse(parsed.data.periodStart)) throw new StudioApiError("组织预算记录未通过核对 未采用替代额度", 502);
    return parsed.data;
  }
  return {
    current,
    authority: context.authority,
    scope,
    checkRequest: checked,
    async budget() {
      budgetProof = undefined;
      const result = checkedBudget(await invoke({ operation: "paid.image.budget.get" })); current();
      budgetProof = structuredClone(result); return result;
    },
    async saveBudget(settings: StudioImageBudgetSettings) {
      current(); const parsed = StudioImageBudgetSettingsSchema.parse(settings);
      if (!budgetProof || parsed.revision !== budgetProof.revision) throw new Error("请先只读刷新组织预算并核对原版本 未发送保存");
      budgetProof = undefined;
      const result = checkedBudget(await invoke({ operation: "paid.image.budget.save", settings: parsed })); current();
      if (!result.revision || !result.policy || result.policy.monthlyCapUsd !== parsed.monthlyCapUsd
        || result.policy.defaultTaskCapUsd !== parsed.defaultTaskCapUsd || result.policy.imageTaskCapUsd !== parsed.imageTaskCapUsd || result.policy.imageCapSource !== "specific")
        throw new StudioApiError("组织预算回执与本次填写不一致 请保留输入并只读刷新 未自动再次保存", 502);
      budgetProof = structuredClone(result); return result;
    },
    async models() {
      const result = StudioModelSchema.array().max(1000).parse(await invoke({ operation: "models" }));
      if (new Set(result.map(model => model.id)).size !== result.length) throw mismatch();
      return result.filter(model => model.capability === "image");
    },
    async assets() {
      return studioPersonalDataSchemas.assets.parse(await invoke({ operation: "assets" }))
        .filter(asset => asset.namespace === "image_files" && asset.rightsStatus === "approved");
    },
    async prepare(input: StudioPaidImageInput) {
      const parsed = StudioPaidImageInputSchema.parse(input); current();
      return checked(await invoke({ operation: "paid.image.prepare", input: parsed }), { requestId: parsed.requestId, input: parsed });
    },
    async commit(requestId: string, quoteHash: string) {
      return checked(await invoke({ operation: "paid.image.commit", requestId, quoteHash, confirmed: true }), { requestId, quoteHash });
    },
    async lookup(requestId: string) {
      const result = StudioPaidImageLookupSchema.parse(await invoke({ operation: "paid.image.lookup", requestId }));
      if (result.status === "missing") { if (result.scope !== scope || result.requestId !== requestId) throw mismatch(); return result; }
      return { status: "found" as const, request: await checked(result.request, { requestId }) };
    },
    async requests(cursor?: string): Promise<StudioImageGenerationPage> {
      const page = StudioPaidImagePageSchema.parse(await invoke({ operation: "paid.image.requests", ...(cursor ? { cursor } : {}), limit: 20 }));
      const items = await Promise.all(page.items.map(item => checked(item))); current();
      const last = items.at(-1);
      if (new Set(items.map(item => item.id)).size !== items.length || new Set(items.map(item => item.requestId)).size !== items.length
        || items.some((item, index) => { const previous = items[index - 1]; return !!(cursor && item.id >= cursor || previous && item.id >= previous.id); })
        || page.nextCursor && (!last || page.nextCursor !== last.id || cursor && page.nextCursor >= cursor)) throw mismatch();
      return { items, nextCursor: page.nextCursor };
    },
    async cancel(requestId: string, quoteHash: string) {
      return checked(await invoke({ operation: "paid.image.cancel", requestId, quoteHash }), { requestId, quoteHash });
    },
    async abandon(requestId: string) {
      const result = StudioPaidImageAbandonSchema.parse(await invoke({ operation: "paid.image.abandon", requestId }));
      if (result.scope !== scope || result.requestId !== requestId) throw mismatch();
      return result;
    },
    async draft(): Promise<StudioImageDraftProjection | null> {
      const raw = studioPersonalDataSchemas["state.get"].parse(await invoke({ operation: "state.get", namespace: "app_state", key: STUDIO_IMAGE_DRAFT_KEY }));
      if (!("value" in raw)) throw new Error("原输入草稿结构不可读取 未采用替代内容");
      if (raw.value === null) return null;
      const document = raw.value as { version?: unknown; activeId?: unknown; drafts?: unknown };
      if (!document || typeof document !== "object" || document.version !== 1 || !Array.isArray(document.drafts)
        || document.drafts.length > 1000 || !(document.activeId === null || typeof document.activeId === "string")) throw new Error("原输入草稿结构不可读取 原稿保持");
      if (document.activeId === null) return null;
      const active = document.drafts.filter((item: unknown) => !!item && typeof item === "object" && "id" in item && item.id === document.activeId);
      if (active.length !== 1) throw new Error("未找到唯一的当前输入草稿 原稿保持");
      const item = active[0] as { prompt?: unknown; references?: unknown; config?: unknown };
      if (typeof item.prompt !== "string" || item.prompt.length > 8000 || !Array.isArray(item.references) || item.references.length > 10
        || !item.config || typeof item.config !== "object" || Array.isArray(item.config)) throw new Error("原草稿字段尚未核对 原稿保持");
      const config = item.config as Record<string, unknown>, quality = config.quality ?? "auto", size = config.size ?? "1024x1024";
      if (!["auto", "low", "medium", "high"].includes(String(quality)) || typeof size !== "string") throw new Error("原草稿参数不能直接带入 请手工核对本面板参数");
      const references = item.references.map((value: unknown) => {
        if (!value || typeof value !== "object" || !("storageKey" in value) || typeof value.storageKey !== "string" || !value.storageKey)
          throw new Error("原草稿含尚未保存为项目素材的参考图 请先在原工作台保存并核对权利");
        const name = "name" in value && typeof value.name === "string" ? value.name : "原草稿参考图";
        return { key: value.storageKey, name };
      });
      return { prompt: item.prompt, model: typeof config.imageModel === "string" ? config.imageModel : typeof config.model === "string" ? config.model : "",
        size, quality: quality as StudioImageDraftProjection["quality"], references, revision: raw.revision, activeId: document.activeId };
    },
    async configuration() {
      current(); const input = { operation: "configuration.get" };
      const result = await (options.configure ? options.configure(input) : studioApi("configuration", input, "POST", context.signal, context)); current();
      return ConfigurationSnapshotSchema.parse(result);
    },
    async savePricing(channelId: string, modelId: string, revision: string, pricing: StudioImagePricing) {
      const parsed = StudioImagePricingSchema.parse(pricing), input = { operation: "studio.image-pricing.save", channelId, modelId, revision, pricing: parsed };
      current(); const result = await (options.configure ? options.configure(input) : studioApi("configuration", input, "POST", context.signal, context)); current();
      return ConfigurationSnapshotSchema.parse(result);
    },
    async preview(request: StudioPaidImageRequest) {
      const source = await checked(request), result = source.result;
      if (source.status !== "completed" || !result || result.namespace !== "image_files") throw new Error("本次任务尚无已登记原图 请只读核对");
      const raw = studioPersonalDataSchemas["state.get"].parse(await invoke({ operation: "state.get", namespace: "image_files", key: result.key }));
      if (!("media" in raw) || raw.assetId !== result.assetId || raw.media.mediaType !== result.mediaType || result.byteSize > 20 * 1024 * 1024) throw mismatch();
      const binary = atob(raw.media.contentBase64); current();
      if (binary.length !== result.byteSize) throw mismatch();
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0)), digest = await crypto.subtle.digest("SHA-256", bytes); current();
      const checksum = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      if (checksum !== result.checksumSha256 || !["image/png", "image/jpeg", "image/webp", "image/tiff"].includes(result.mediaType)) throw mismatch();
      return { blob: new Blob([bytes], { type: result.mediaType }), checksum, assetId: result.assetId };
    },
  };
}
