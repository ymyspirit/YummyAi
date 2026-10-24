import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import {
  ListingSyncIntentLookupSchema, ListingSyncIntentReceiptSchema, ListingSyncIntentWorkspaceSchema,
  listingSyncIntentRequestText,
  type ListingSyncIntentLookup, type ListingSyncIntentReceipt, type ListingSyncIntentWorkspace,
} from "@yummyai/contracts/marketplace/listing-sync-intent";
import { CreateMarketplaceListingSyncInputSchema, MarketplaceListingSyncEventViewSchema, MarketplaceListingSyncRequestViewSchema,
  type CreateMarketplaceListingSyncInput, type MarketplaceListingSyncEventView, type MarketplaceListingSyncRequestView } from "@yummyai/contracts/marketplace/listing-operations";
import { readMarketplaceJson } from "./marketplace-lifecycle";

export const LISTING_SYNC_WIRE_BYTES = 8 * 1024 * 1024;
const CodeSchema = z.enum(["authority_changed", "marketplace_authority_changed", "listing_sync_intent_conflict",
  "listing_sync_request_key_required", "listing_sync_request_conflict", "listing_sync_receipt_conflict", "listing_sync_access_denied"]);
export type ListingSyncCode = z.infer<typeof CodeSchema>;
export class ListingSyncError extends Error {
  constructor(readonly status: number, readonly code?: ListingSyncCode, readonly submitted = false) { super("listing_sync_request_unavailable"); }
}
export const listingSyncDenied = (error: ListingSyncError) => [401, 403, 404].includes(error.status) || error.status === 409 &&
  ["authority_changed", "marketplace_authority_changed"].includes(error.code ?? "");
export function listingSyncErrorText(error: ListingSyncError) {
  if (listingSyncDenied(error)) return "当前刊登或本人权限已变化 原同步资料和填写已隐藏 请重新读取";
  if (error.submitted) return "原同步请求尚待核对 请只读取原回执 不会换键或再次提交";
  if ([409, 412].includes(error.status)) return "原同步目标或依据需要重新核对 已保存的原请求保持不变";
  if ([400, 413, 422].includes(error.status)) return "同步请求格式需要核对 请使用真实来源和准确原请求 ID";
  return "同步资料暂时无法核对 请重新读取 原请求标识保持不变";
}
export const listingSyncSameId = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
export async function listingSyncHash(text: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function listingSyncRequestChecksum(input: CreateMarketplaceListingSyncInput) {
  return listingSyncHash(listingSyncIntentRequestText(input));
}
export async function readListingSyncCode(response: Response) {
  try { const parsed = z.object({ code: CodeSchema }).passthrough().safeParse(await readMarketplaceJson(response, 8192)); return parsed.success ? parsed.data.code : undefined; }
  catch { return undefined; }
}
export type ListingSyncContext = { listingId: string; actorId: string; tenantId: string; authority: string; signal?: AbortSignal };
export async function verifyListingSyncRequest(value: MarketplaceListingSyncRequestView, listingId: string,
  expected: { id?: string; requestChecksum?: string; input?: CreateMarketplaceListingSyncInput } = {}) {
  if (!listingSyncSameId(value.listingId, listingId) || expected.id && !listingSyncSameId(value.id, expected.id)) throw new ListingSyncError(502);
  const original = CreateMarketplaceListingSyncInputSchema.parse({ accountId: value.accountId, listingId: value.listingId,
    listingVersionId: value.listingVersionId, sourcePublicationRequestId: value.sourcePublicationRequestId, action: value.action });
  if (expected.requestChecksum && await listingSyncRequestChecksum(original) !== expected.requestChecksum) throw new ListingSyncError(502);
  if (expected.input && (value.action !== expected.input.action || !listingSyncSameId(value.accountId, expected.input.accountId) ||
    !listingSyncSameId(value.listingVersionId, expected.input.listingVersionId) || !listingSyncSameId(value.sourcePublicationRequestId, expected.input.sourcePublicationRequestId)))
    throw new ListingSyncError(502);
}
export function verifyListingSyncWorkspace(value: ListingSyncIntentWorkspace, context: ListingSyncContext) {
  if (!listingSyncSameId(value.listing.id, context.listingId) || !listingSyncSameId(value.context.actorId, context.actorId) ||
    !listingSyncSameId(value.context.tenantId, context.tenantId) || value.context.authority !== context.authority) throw new ListingSyncError(409, "authority_changed");
  if (value.recent.some(row => !listingSyncSameId(row.listingId, context.listingId)) || new Set(value.recent.map(row => row.id.toLowerCase())).size !== value.recent.length ||
    new Set(value.sources.map(row => row.sourcePublicationRequestId.toLowerCase())).size !== value.sources.length) throw new ListingSyncError(502);
}
export function verifyListingSyncEvents(events: MarketplaceListingSyncEventView[], request: MarketplaceListingSyncRequestView) {
  if (!events.length || new Set(events.map(row => row.id.toLowerCase())).size !== events.length ||
    events.some((row, index) => index > 0 && row.sequence <= events[index - 1]!.sequence) ||
    !events.some(row => listingSyncSameId(row.id, request.current.id) && row.sequence === request.current.sequence && row.status === request.current.status)) throw new ListingSyncError(502);
}
async function request(context: ListingSyncContext, path: string, body?: CreateMarketplaceListingSyncInput) {
  const submitted = body !== undefined;
  try {
    if (!/^[a-f0-9]{64}$/.test(context.authority)) throw new ListingSyncError(409, "authority_changed");
    context.signal?.throwIfAborted();
    const response = await fetch(`/api/erp-listing-sync/${path}`, { method: submitted ? "POST" : "GET", cache: "no-store", credentials: "same-origin",
      signal: AbortSignal.any([...(context.signal ? [context.signal] : []), AbortSignal.timeout(submitted ? 120000 : 30000)]),
      headers: { "x-yummyai-context-authority": context.authority, ...(submitted ? { "content-type": "application/json" } : {}) },
      ...(submitted ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new ListingSyncError(response.status, await readListingSyncCode(response), submitted);
    const value = await readMarketplaceJson(response, LISTING_SYNC_WIRE_BYTES);
    if (response.headers.get("x-yummyai-context-authority") !== context.authority) throw new ListingSyncError(409, "authority_changed", submitted);
    if (response.status !== (submitted ? 201 : 200)) throw new ListingSyncError(502, undefined, submitted);
    context.signal?.throwIfAborted(); return value;
  } catch (error) { throw error instanceof ListingSyncError ? error : new ListingSyncError(0, undefined, submitted); }
}
export async function readListingSyncWorkspace(context: ListingSyncContext) {
  const listingId = EntityIdSchema.parse(context.listingId), value = ListingSyncIntentWorkspaceSchema.safeParse(await request(context, `workspace?${new URLSearchParams({ listingId })}`));
  if (!value.success) throw new ListingSyncError(502); verifyListingSyncWorkspace(value.data, context); return value.data;
}
export async function readListingSyncRequest(context: ListingSyncContext, requestId: string) {
  const id = EntityIdSchema.parse(requestId.toLowerCase()), value = MarketplaceListingSyncRequestViewSchema.strict().safeParse(await request(context, `requests/${id}`));
  if (!value.success) throw new ListingSyncError(502); await verifyListingSyncRequest(value.data, context.listingId, { id }); return value.data;
}
export async function readListingSyncEvents(context: ListingSyncContext, original: MarketplaceListingSyncRequestView) {
  const id = EntityIdSchema.parse(original.id.toLowerCase()), value = z.array(MarketplaceListingSyncEventViewSchema.strict()).safeParse(await request(context, `requests/${id}/events`));
  if (!value.success) throw new ListingSyncError(502); verifyListingSyncEvents(value.data, original); return value.data;
}
export async function readListingSyncReceipt(context: ListingSyncContext, raw: ListingSyncIntentLookup): Promise<ListingSyncIntentReceipt> {
  const input = ListingSyncIntentLookupSchema.parse(raw), value = ListingSyncIntentReceiptSchema.safeParse(await request(context, `receipt?${new URLSearchParams(input)}`));
  if (!value.success || !listingSyncSameId(value.data.requestKey, input.requestKey) || value.data.requestChecksum !== input.requestChecksum) throw new ListingSyncError(502);
  if (value.data.request) await verifyListingSyncRequest(value.data.request, context.listingId, input); return value.data;
}
export async function createListingSyncRequest(context: ListingSyncContext, raw: CreateMarketplaceListingSyncInput) {
  const input = CreateMarketplaceListingSyncInputSchema.parse(raw); if (!input.requestKey || !listingSyncSameId(input.listingId, context.listingId)) throw new ListingSyncError(400);
  const value = MarketplaceListingSyncRequestViewSchema.strict().safeParse(await request(context, "requests", input));
  if (!value.success) throw new ListingSyncError(502, undefined, true);
  try { await verifyListingSyncRequest(value.data, context.listingId, { input }); } catch { throw new ListingSyncError(502, undefined, true); } return value.data;
}
