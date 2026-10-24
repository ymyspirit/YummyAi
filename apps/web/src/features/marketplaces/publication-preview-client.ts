import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { CreatePublicationPreviewInputSchema, PublicationPreviewLookupSchema, PublicationPreviewReceiptSchema,
  PublicationPreviewRequestViewSchema, PublicationPreviewWorkspaceInputSchema, PublicationPreviewWorkspaceSchema,
  publicationPreviewRequestText, publicationPreviewReadCheckInput, PublicationPreviewReadCheckInputSchema, type PublicationPreviewReadCheckInput, type CreatePublicationPreviewInput, type PublicationPreviewRequestView,
  type PublicationPreviewTarget, type PublicationPreviewWorkspace } from "@yummyai/contracts/marketplace/publication-preview";
import { CancelMarketplacePublicationInputSchema, MarketplacePublicationEventViewSchema,
  type MarketplacePublicationEventView } from "@yummyai/contracts/marketplace/publication";
import { readMarketplaceJson } from "./marketplace-lifecycle";

export const PUBLICATION_PREVIEW_BYTES = 8 * 1024 * 1024;
export const PUBLICATION_PREVIEW_RECHECK_EVENT = "yummyai.publication-preview-recheck";
export class PublicationPreviewError extends Error {
  constructor(readonly status: number, readonly code?: string, readonly submitted = false) { super("publication_preview_unavailable"); }
}
export const previewSameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const previewDenied = (error: PublicationPreviewError) => [401, 403, 404].includes(error.status) || error.status === 409 &&
  ["authority_changed", "marketplace_authority_changed", "publication_preview_authority_changed", "store_node_authority_changed"].includes(error.code ?? "");
export function previewErrorText(error: PublicationPreviewError) {
  if (previewDenied(error)) return "当前刊登或本人权限已变化 原预览资料与填写已隐藏 请重新读取";
  if (error.submitted) return "原预览结果尚待核对 请只读取原回执 不换键或再次准备";
  if ([409, 412].includes(error.status)) return "原版本 节点或授权依据已变化 请重新读取 已存原意图保持不变";
  if ([400, 413, 422].includes(error.status)) return "原预览目标格式需核对 请使用原版本与真实店铺来源";
  return "原预览资料暂时无法核对 请重新读取 原请求标识保持不变";
}
export async function previewHash(text: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), n => n.toString(16).padStart(2, "0")).join("");
}
export const previewTargetChecksum = (target: PublicationPreviewTarget) => previewHash(publicationPreviewRequestText(target));
export async function readPreviewCode(response: Response) {
  try { const value = z.object({ code: z.string().max(128) }).passthrough().safeParse(await readMarketplaceJson(response, 8192));
    return value.success && /^(?:authority_changed|(?:publication_preview|marketplace|store_node)_[a-z_]+)$/.test(value.data.code) ? value.data.code : undefined;
  } catch { return undefined; }
}
export type PublicationPreviewContext = { listingId: string; listingVersionId: string; actorId: string; tenantId: string; authority: string; signal?: AbortSignal };
const invalid = () => new PublicationPreviewError(502);
function notifyReadDenied(listingId: string, error: PublicationPreviewError) {
  if (typeof window === "undefined" || !previewDenied(error)) return;
  const id = EntityIdSchema.safeParse(listingId.toLowerCase());
  if (id.success) window.dispatchEvent(new CustomEvent(PUBLICATION_PREVIEW_RECHECK_EVENT, { detail: { listingId: id.data } }));
}
export async function verifyPublicationPreview(value: PublicationPreviewRequestView, expected: { listingId?: string; id?: string;
  requestKey?: string; requestChecksum?: string; target?: PublicationPreviewTarget } = {}) {
  const request = value.request;
  if (expected.listingId && !previewSameId(request.listingId, expected.listingId) || expected.id && !previewSameId(request.id, expected.id)) throw invalid();
  if (value.admission === "node_preview") {
    const intent = value.intent!, target = intent.target, execution = value.execution!;
    if (request.platform !== "amazon" || request.action !== "amazon_validation_preview" ||
      !previewSameId(request.accountId, target.accountId) || !previewSameId(request.listingId, target.listingId) ||
      !previewSameId(request.listingVersionId, target.listingVersionId) || request.marketplaceId !== target.marketplaceId ||
      !previewSameId(request.capabilitySnapshotId, target.capabilitySnapshotId) || request.payloadChecksum !== target.payloadChecksum ||
      !previewSameId(execution.nodeId, target.nodeId) || execution.certificateGeneration !== target.certificateGeneration ||
      !previewSameId(execution.authorizationGeneration, target.authorizationGeneration) || execution.bindingRevision !== target.bindingRevision ||
      await previewTargetChecksum(target) !== intent.requestChecksum || expected.requestKey && !previewSameId(intent.requestKey, expected.requestKey) ||
      expected.requestChecksum && intent.requestChecksum !== expected.requestChecksum ||
      expected.target && publicationPreviewRequestText(target) !== publicationPreviewRequestText(expected.target)) throw invalid();
  } else if (expected.requestKey || expected.requestChecksum || expected.target) throw invalid();
}
export async function verifyPublicationWorkspace(value: PublicationPreviewWorkspace, context: PublicationPreviewContext, variantSkuId?: string) {
  if (!previewSameId(value.context.actorId, context.actorId) || !previewSameId(value.context.tenantId, context.tenantId) || value.context.authority !== context.authority)
    throw new PublicationPreviewError(409, "authority_changed");
  if (!previewSameId(value.listing.id, context.listingId) || !previewSameId(value.listing.versionId, context.listingVersionId) ||
    new Set(value.recent.map(row => row.request.id.toLowerCase())).size !== value.recent.length ||
    new Set(value.sources.map(row => `${row.accountId.toLowerCase()}:${row.marketplaceId}`)).size !== value.sources.length) throw invalid();
  for (const source of value.sources) {
    const target = source.target;
    if (source.canPrepare && !target || target && (!previewSameId(target.accountId, source.accountId) || target.marketplaceId !== source.marketplaceId ||
      !previewSameId(target.listingId, context.listingId) || !previewSameId(target.listingVersionId, context.listingVersionId) ||
      variantSkuId !== undefined && target.variantSkuId !== variantSkuId)) throw invalid();
  }
  for (const row of value.recent) await verifyPublicationPreview(row, { listingId: context.listingId });
}
export function verifyPublicationEvents(events: MarketplacePublicationEventView[], value: PublicationPreviewRequestView) {
  if (!events.length || new Set(events.map(row => row.id.toLowerCase())).size !== events.length ||
    events.some((row, i) => i > 0 && row.sequence <= events[i - 1]!.sequence) || !events.some(row => previewSameId(row.id, value.request.current.id) &&
      row.sequence === value.request.current.sequence && row.status === value.request.current.status)) throw invalid();
}
async function request(context: PublicationPreviewContext, path: string, body?: unknown, status = body === undefined ? 200 : 201) {
  const submitted = body !== undefined;
  try {
    if (!/^[a-f0-9]{64}$/.test(context.authority)) throw new PublicationPreviewError(409, "authority_changed");
    context.signal?.throwIfAborted();
    const response = await fetch(`/api/erp-publication-preview/${path}`, { method: submitted ? "POST" : "GET", cache: "no-store", credentials: "same-origin",
      signal: AbortSignal.any([...(context.signal ? [context.signal] : []), AbortSignal.timeout(submitted ? 120000 : 30000)]),
      headers: { "x-yummyai-context-authority": context.authority, ...(submitted ? { "content-type": "application/json" } : {}) },
      ...(submitted ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new PublicationPreviewError(response.status, await readPreviewCode(response), submitted);
    const raw = await readMarketplaceJson(response, PUBLICATION_PREVIEW_BYTES);
    if (response.headers.get("x-yummyai-context-authority") !== context.authority) throw new PublicationPreviewError(409, "authority_changed", submitted);
    if (response.status !== status) throw new PublicationPreviewError(502, undefined, submitted);
    context.signal?.throwIfAborted(); return raw;
  } catch (error) { const failure = error instanceof PublicationPreviewError ? error : new PublicationPreviewError(0, undefined, submitted);
    notifyReadDenied(context.listingId, failure); throw failure; }
}
async function checkRead(context: Pick<PublicationPreviewContext, "authority" | "signal" | "listingId">, path: string, notify = true) {
  try {
    if (!/^[a-f0-9]{64}$/.test(context.authority)) throw new PublicationPreviewError(409, "authority_changed");
    context.signal?.throwIfAborted();
    const response = await fetch(`/api/erp-publication-preview/${path}`, { method: "HEAD", cache: "no-store", credentials: "same-origin",
      signal: AbortSignal.any([...(context.signal ? [context.signal] : []), AbortSignal.timeout(30000)]),
      headers: { "x-yummyai-context-authority": context.authority } });
    if (!response.ok) {
      const rawCode = response.headers.get("x-yummyai-error-code"), code = rawCode && previewDenied(new PublicationPreviewError(409, rawCode)) ? rawCode : undefined;
      throw new PublicationPreviewError(response.status, code);
    }
    if (response.headers.get("x-yummyai-context-authority") !== context.authority) throw new PublicationPreviewError(409, "authority_changed");
    if (response.status !== 200) throw invalid();
    context.signal?.throwIfAborted();
  } catch (error) { const failure = error instanceof PublicationPreviewError ? error : new PublicationPreviewError(0);
    if (notify) notifyReadDenied(context.listingId, failure); throw failure; }
}
export function checkPublicationWorkspaceRead(raw: PublicationPreviewReadCheckInput, authority: string, signal?: AbortSignal, notify = true) {
  const input = PublicationPreviewReadCheckInputSchema.parse(raw);
  return checkRead({ authority, signal, listingId: input.listingId }, `workspace?${new URLSearchParams(input)}`, notify);
}
export async function readPublicationWorkspace(context: PublicationPreviewContext, variantSkuId?: string) {
  const input = PublicationPreviewWorkspaceInputSchema.parse({ listingId: context.listingId, listingVersionId: context.listingVersionId, ...(variantSkuId ? { variantSkuId } : {}) });
  const value = PublicationPreviewWorkspaceSchema.safeParse(await request(context, `workspace?${new URLSearchParams(input)}`));
  if (!value.success) throw invalid(); await verifyPublicationWorkspace(value.data, context, variantSkuId);
  await checkPublicationWorkspaceRead(publicationPreviewReadCheckInput(value.data), context.authority, context.signal); return value.data;
}
export async function readPublicationPreview(context: PublicationPreviewContext, rawId: string) {
  const id = EntityIdSchema.parse(rawId.toLowerCase()), value = PublicationPreviewRequestViewSchema.safeParse(await request(context, `requests/${id}`));
  if (!value.success) throw invalid(); await verifyPublicationPreview(value.data, { listingId: context.listingId, id });
  await checkRead(context, `requests/${id}`); return value.data;
}
export async function readPublicationReceipt(context: PublicationPreviewContext, raw: z.infer<typeof PublicationPreviewLookupSchema>, target?: PublicationPreviewTarget) {
  const input = PublicationPreviewLookupSchema.parse(raw), value = PublicationPreviewReceiptSchema.safeParse(await request(context, `receipt?${new URLSearchParams(input)}`));
  if (!value.success || !previewSameId(value.data.requestKey, input.requestKey) || value.data.requestChecksum !== input.requestChecksum) throw invalid();
  if (value.data.request) { await verifyPublicationPreview(value.data.request, { listingId: context.listingId, ...input, target });
    await checkRead(context, `requests/${value.data.request.request.id}`); } return value.data;
}
export async function createPublicationPreview(context: PublicationPreviewContext, raw: CreatePublicationPreviewInput) {
  const input = CreatePublicationPreviewInputSchema.parse(raw);
  const { requestKey, requestChecksum, ...target } = input;
  if (!previewSameId(input.listingId, context.listingId) || !previewSameId(input.listingVersionId, context.listingVersionId) || await previewTargetChecksum(target) !== requestChecksum) throw new PublicationPreviewError(400);
  const value = PublicationPreviewRequestViewSchema.safeParse(await request(context, "requests", input));
  if (!value.success) throw new PublicationPreviewError(502, undefined, true);
  try { await verifyPublicationPreview(value.data, { listingId: context.listingId, requestKey, requestChecksum, target });
    await checkRead(context, `requests/${value.data.request.id}`); }
  catch (error) { throw error instanceof PublicationPreviewError ? new PublicationPreviewError(error.status, error.code, true) : new PublicationPreviewError(502, undefined, true); } return value.data;
}
export async function readPublicationPreviewEvents(context: PublicationPreviewContext, original: PublicationPreviewRequestView) {
  const value = z.array(MarketplacePublicationEventViewSchema.strict()).max(2000).safeParse(await request(context, `requests/${EntityIdSchema.parse(original.request.id)}/events`));
  if (!value.success) throw invalid(); verifyPublicationEvents(value.data, original);
  await checkRead(context, `requests/${original.request.id}`); return value.data;
}
export async function cancelPublicationPreview(context: PublicationPreviewContext, original: PublicationPreviewRequestView, reason: string) {
  const body = CancelMarketplacePublicationInputSchema.parse({ reason }), value = PublicationPreviewRequestViewSchema.safeParse(await request(context, `requests/${EntityIdSchema.parse(original.request.id)}/cancel`, body, 200));
  if (!value.success) throw new PublicationPreviewError(502, undefined, true);
  try { await verifyPublicationPreview(value.data, { listingId: context.listingId, id: original.request.id, ...(original.intent ?? {}) });
    await checkRead(context, `requests/${original.request.id}`); }
  catch (error) { throw error instanceof PublicationPreviewError ? new PublicationPreviewError(error.status, error.code, true) : new PublicationPreviewError(502, undefined, true); } return value.data;
}
