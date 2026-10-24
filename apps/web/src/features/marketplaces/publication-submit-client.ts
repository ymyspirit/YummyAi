import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { CreatePublicationSubmitInputSchema, CreatePublicationStatusInputSchema, PublicationSubmitWorkspaceInputSchema,
  PublicationSubmitWorkspaceSchema, PublicationSubmitRequestViewSchema, PublicationSubmitLookupSchema, PublicationSubmitReceiptSchema,
  PublicationStatusReadViewSchema, PublicationStatusReceiptSchema, publicationSubmitRequestText, publicationStatusRequestText,
  type CreatePublicationSubmitInput, type CreatePublicationStatusInput, type PublicationSubmitWorkspace, type PublicationSubmitRequestView,
  type PublicationStatusReadView, type PublicationSubmitLookup } from "@yummyai/contracts/marketplace/publication-submit";
import { CancelMarketplacePublicationInputSchema } from "@yummyai/contracts/marketplace/publication";
import { readMarketplaceJson } from "./marketplace-lifecycle";
import { previewHash, previewSameId, verifyPublicationPreview, PUBLICATION_PREVIEW_RECHECK_EVENT } from "./publication-preview-client";

export const PUBLICATION_SUBMIT_BYTES = 8 * 1024 * 1024;
export const publicationSubmitHash = previewHash;
export const submitSameId = previewSameId;
const Codes = z.enum(["authority_changed", "marketplace_authority_changed", "publication_authority_changed", "publication_preview_authority_changed",
  "publication_submit_authority_changed", "store_node_authority_changed", "publication_source_changed", "publication_input_invalid", "store_node_application_reauthorization_required"]);
export class PublicationSubmitError extends Error {
  constructor(readonly status: number, readonly code?: string, readonly submitted = false) { super("publication_submit_unavailable"); }
}
export const publicationSubmitDenied = (error: PublicationSubmitError) => [401, 403, 404].includes(error.status) || error.status === 409 &&
  ["authority_changed", "marketplace_authority_changed", "publication_authority_changed", "publication_preview_authority_changed", "publication_submit_authority_changed", "store_node_authority_changed"].includes(error.code ?? "");
export function publicationSubmitErrorText(error: PublicationSubmitError) {
  if (publicationSubmitDenied(error)) return "当前刊登 店铺或本人权限已变化 原正式提交资料与确认已隐藏 请重新读取";
  if (error.code === "store_node_application_reauthorization_required") return "节点公开应用依据需要重新授权 原任务保留 不自动重发正式提交";
  if (error.submitted) return "本次原操作结果尚待核对 请只读取原回执 不换键或再次提交";
  if ([409, 412].includes(error.status)) return "原预览 节点或授权依据已变化 请重新读取 原请求标识保持不变";
  return "正式提交资料暂时无法核对 请重新读取 原请求标识保持不变";
}
export type PublicationSubmitContext = { authority: string; actorId: string; tenantId: string; listingId: string; listingVersionId: string; previewRequestId: string; signal?: AbortSignal };
const invalid = () => new PublicationSubmitError(502);
const samePins = (left: { nodeId: string; certificateGeneration: number; authorizationGeneration: string; bindingRevision: number }, right: typeof left) =>
  submitSameId(left.nodeId, right.nodeId) && left.certificateGeneration === right.certificateGeneration && submitSameId(left.authorizationGeneration, right.authorizationGeneration) && left.bindingRevision === right.bindingRevision;
const sameSource = (left: { accountId: string; listingId: string; listingVersionId: string; marketplaceId: string; capabilitySnapshotId: string; payloadChecksum: string; assetManifestChecksum: string; variantSkuId?: string }, right: typeof left) =>
  submitSameId(left.accountId, right.accountId) && submitSameId(left.listingId, right.listingId) && submitSameId(left.listingVersionId, right.listingVersionId) && left.marketplaceId === right.marketplaceId &&
  submitSameId(left.capabilitySnapshotId, right.capabilitySnapshotId) && left.payloadChecksum === right.payloadChecksum && left.assetManifestChecksum === right.assetManifestChecksum && left.variantSkuId === right.variantSkuId;
export async function verifyPublicationStatus(value: PublicationStatusReadView, expected: { requestId?: string; requestKey?: string; requestChecksum?: string; parent?: PublicationSubmitRequestView } = {}) {
  const target = value.target;
  if (!submitSameId(value.requestId, target.publicationRequestId) || !samePins(value.execution, target) || await publicationSubmitHash(publicationStatusRequestText(target)) !== value.requestChecksum ||
    expected.requestId && !submitSameId(value.requestId, expected.requestId) || expected.requestKey && !submitSameId(value.requestKey, expected.requestKey) || expected.requestChecksum && value.requestChecksum !== expected.requestChecksum ||
    value.result && (!submitSameId(value.result.publicationRequestId, value.requestId) || value.result.payloadChecksum !== target.payloadChecksum || value.result.sourceSubmissionId !== target.sourceSubmissionId)) throw invalid();
  if (expected.parent && (!submitSameId(value.requestId, expected.parent.request.id) || !submitSameId(target.submissionExecutionId, expected.parent.execution.id) ||
    target.submissionTargetChecksum !== expected.parent.intent.requestChecksum || !sameSource(target, expected.parent.intent.target) || !submitSameId(target.authorizationGeneration, expected.parent.intent.target.authorizationGeneration) || target.sku !== expected.parent.intent.target.sku)) throw invalid();
}
export async function verifyPublicationSubmission(value: PublicationSubmitRequestView, expected: { id?: string; previewRequestId?: string; listingId?: string; listingVersionId?: string; requestKey?: string; requestChecksum?: string } = {}) {
  const { request, intent, execution } = value, target = intent.target;
  if (!submitSameId(request.accountId, target.accountId) || !submitSameId(request.listingId, target.listingId) || !submitSameId(request.listingVersionId, target.listingVersionId) || request.marketplaceId !== target.marketplaceId ||
    !submitSameId(request.capabilitySnapshotId, target.capabilitySnapshotId) || request.payloadChecksum !== target.payloadChecksum || request.parentRequestId === null || !submitSameId(request.parentRequestId, target.previewRequestId) ||
    !samePins(execution, target) || await publicationSubmitHash(publicationSubmitRequestText(target)) !== intent.requestChecksum ||
    expected.id && !submitSameId(request.id, expected.id) || expected.previewRequestId && !submitSameId(target.previewRequestId, expected.previewRequestId) ||
    expected.listingId && !submitSameId(request.listingId, expected.listingId) || expected.listingVersionId && !submitSameId(request.listingVersionId, expected.listingVersionId) ||
    expected.requestKey && !submitSameId(intent.requestKey, expected.requestKey) || expected.requestChecksum && intent.requestChecksum !== expected.requestChecksum ||
    value.result && (!submitSameId(value.result.publicationRequestId, request.id) || value.result.payloadChecksum !== target.payloadChecksum)) throw invalid();
  if (value.statusTarget && (!submitSameId(value.statusTarget.publicationRequestId, request.id) || !submitSameId(value.statusTarget.submissionExecutionId, execution.id) ||
    value.statusTarget.submissionTargetChecksum !== intent.requestChecksum || !sameSource(value.statusTarget, target) || !submitSameId(value.statusTarget.authorizationGeneration, target.authorizationGeneration) || value.statusTarget.sku !== target.sku)) throw invalid();
  if (new Set(value.statusReads.map(row => row.id.toLowerCase())).size !== value.statusReads.length) throw invalid();
  for (const row of value.statusReads) await verifyPublicationStatus(row, { parent: value });
}
export async function verifyPublicationSubmitWorkspace(value: PublicationSubmitWorkspace, expected: Pick<PublicationSubmitContext, "previewRequestId" | "actorId" | "tenantId" | "authority"> & Partial<Pick<PublicationSubmitContext, "listingId" | "listingVersionId">>) {
  if (!submitSameId(value.context.actorId, expected.actorId) || !submitSameId(value.context.tenantId, expected.tenantId) || value.context.authority !== expected.authority) throw new PublicationSubmitError(409, "authority_changed");
  await verifyPublicationPreview(value.preview, { id: expected.previewRequestId, listingId: expected.listingId });
  if (expected.listingVersionId && !submitSameId(value.preview.request.listingVersionId, expected.listingVersionId)) throw invalid();
  if (value.access.canSubmit && !value.target) throw invalid();
  if (value.target) {
    const target = value.target, preview = value.preview;
    if (!preview.intent || !preview.execution || !submitSameId(target.previewRequestId, preview.request.id) || !submitSameId(target.previewEventId, preview.request.current.id) || target.previewEventSequence !== preview.request.current.sequence ||
      !submitSameId(target.previewExecutionId, preview.execution.id) || !sameSource(target, preview.intent.target) || !samePins(target, preview.intent.target)) throw invalid();
  }
  if (new Set(value.recent.map(row => row.request.id.toLowerCase())).size !== value.recent.length) throw invalid();
  for (const row of value.recent) await verifyPublicationSubmission(row, { previewRequestId: expected.previewRequestId, listingId: expected.listingId, listingVersionId: expected.listingVersionId });
}
export async function readPublicationSubmitCode(response: Response) {
  try { const value = z.object({ code: Codes }).passthrough().safeParse(await readMarketplaceJson(response, 8192)); return value.success ? value.data.code : undefined; } catch { return undefined; }
}
function notifyDenied(context: PublicationSubmitContext, error: PublicationSubmitError) {
  if (typeof window !== "undefined" && publicationSubmitDenied(error)) window.dispatchEvent(new CustomEvent(PUBLICATION_PREVIEW_RECHECK_EVENT, { detail: { listingId: context.listingId } }));
}
async function request(context: PublicationSubmitContext, path: string, body?: unknown, status = body === undefined ? 200 : 201) {
  const submitted = body !== undefined;
  try {
    if (!/^[a-f0-9]{64}$/.test(context.authority)) throw new PublicationSubmitError(409, "authority_changed", submitted);
    context.signal?.throwIfAborted();
    const response = await fetch(`/api/erp-publication-submit/${path}`, { method: submitted ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
      signal: AbortSignal.any([...(context.signal ? [context.signal] : []), AbortSignal.timeout(submitted ? 120000 : 30000)]),
      headers: { "x-yummyai-context-authority": context.authority, ...(submitted ? { "content-type": "application/json" } : {}) }, ...(submitted ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new PublicationSubmitError(response.status, await readPublicationSubmitCode(response), submitted);
    const value = await readMarketplaceJson(response, PUBLICATION_SUBMIT_BYTES);
    if (response.headers.get("x-yummyai-context-authority") !== context.authority) throw new PublicationSubmitError(409, "authority_changed", submitted);
    if (response.status !== status) throw new PublicationSubmitError(502, undefined, submitted);
    context.signal?.throwIfAborted(); return value;
  } catch (error) { const failure = error instanceof PublicationSubmitError ? error : new PublicationSubmitError(0, undefined, submitted); notifyDenied(context, failure); throw failure; }
}
async function head(context: PublicationSubmitContext, path: string) {
  try {
    context.signal?.throwIfAborted(); const response = await fetch(`/api/erp-publication-submit/${path}`, { method: "HEAD", cache: "no-store", credentials: "same-origin",
      headers: { "x-yummyai-context-authority": context.authority }, signal: AbortSignal.any([...(context.signal ? [context.signal] : []), AbortSignal.timeout(30000)]) });
    if (!response.ok) { const code = response.headers.get("x-yummyai-error-code"); throw new PublicationSubmitError(response.status, code && publicationSubmitDenied(new PublicationSubmitError(409, code)) ? code : undefined); }
    if (response.status !== 200) throw invalid();
    if (response.headers.get("x-yummyai-context-authority") !== context.authority) throw new PublicationSubmitError(409, "authority_changed");
    context.signal?.throwIfAborted();
  } catch (error) { const failure = error instanceof PublicationSubmitError ? error : new PublicationSubmitError(0); notifyDenied(context, failure); throw failure; }
}
export async function readPublicationSubmitWorkspace(context: PublicationSubmitContext) {
  const query = PublicationSubmitWorkspaceInputSchema.parse({ previewRequestId: context.previewRequestId }), path = `workspace?${new URLSearchParams(query)}`;
  const value = PublicationSubmitWorkspaceSchema.parse(await request(context, path)); await verifyPublicationSubmitWorkspace(value, context); await head(context, path); return value;
}
export async function readPublicationSubmission(context: PublicationSubmitContext, id: string) {
  const path = `requests/${EntityIdSchema.parse(id.toLowerCase())}`, value = PublicationSubmitRequestViewSchema.parse(await request(context, path));
  await verifyPublicationSubmission(value, { ...context, id }); await head(context, path); return value;
}
export async function readPublicationSubmitReceipt(context: PublicationSubmitContext, raw: PublicationSubmitLookup) {
  const lookup = PublicationSubmitLookupSchema.parse(raw), path = `receipt?${new URLSearchParams(lookup)}`, value = PublicationSubmitReceiptSchema.parse(await request(context, path));
  if (!submitSameId(value.requestKey, lookup.requestKey) || value.requestChecksum !== lookup.requestChecksum) throw invalid();
  if (value.request) await verifyPublicationSubmission(value.request, { ...context, ...lookup }); await head(context, path); return value;
}
export async function readPublicationStatusReceipt(context: PublicationSubmitContext, raw: PublicationSubmitLookup, requestId: string) {
  const lookup = PublicationSubmitLookupSchema.parse(raw), path = `status-receipt?${new URLSearchParams(lookup)}`, value = PublicationStatusReceiptSchema.parse(await request(context, path));
  if (!submitSameId(value.requestKey, lookup.requestKey) || value.requestChecksum !== lookup.requestChecksum) throw invalid();
  if (value.operation) { const parent = await readPublicationSubmission(context, requestId); await verifyPublicationStatus(value.operation, { ...lookup, requestId, parent }); }
  await head(context, path); return value;
}
async function postChecked<T>(context: PublicationSubmitContext, path: string, body: unknown, parse: (raw: unknown) => T, verify: (value: T) => Promise<void>, finalPath: (value: T) => string, status = 201) {
  const raw = await request(context, path, body, status);
  try { const value = parse(raw); await verify(value); await head(context, finalPath(value)); return value; }
  catch (error) { throw error instanceof PublicationSubmitError ? new PublicationSubmitError(error.status, error.code, true) : new PublicationSubmitError(502, undefined, true); }
}
export async function createPublicationSubmission(context: PublicationSubmitContext, raw: CreatePublicationSubmitInput) {
  const input = CreatePublicationSubmitInputSchema.parse(raw);
  const { requestKey, requestChecksum, acknowledgeReplacement: _ack, ...target } = input; void _ack;
  if (!submitSameId(input.listingId, context.listingId) || !submitSameId(input.listingVersionId, context.listingVersionId) || !submitSameId(input.previewRequestId, context.previewRequestId) ||
    await publicationSubmitHash(publicationSubmitRequestText(target)) !== requestChecksum) throw new PublicationSubmitError(400);
  return postChecked(context, "requests", input, raw => PublicationSubmitRequestViewSchema.parse(raw), value => verifyPublicationSubmission(value, { ...context, requestKey, requestChecksum }), value => `requests/${value.request.id}`);
}
export async function createPublicationStatus(context: PublicationSubmitContext, parent: PublicationSubmitRequestView, raw: CreatePublicationStatusInput) {
  const input = CreatePublicationStatusInputSchema.parse(raw);
  const { requestKey: _key, requestChecksum, ...target } = input; void _key;
  await verifyPublicationSubmission(parent, context);
  if (!parent.statusTarget || publicationStatusRequestText(target) !== publicationStatusRequestText(parent.statusTarget) || await publicationSubmitHash(publicationStatusRequestText(target)) !== requestChecksum) throw new PublicationSubmitError(400);
  return postChecked(context, `requests/${EntityIdSchema.parse(parent.request.id)}/status`, input, raw => PublicationStatusReadViewSchema.parse(raw), value => verifyPublicationStatus(value, { ...input, requestId: parent.request.id, parent }),
    () => `status-receipt?${new URLSearchParams({ requestKey: input.requestKey, requestChecksum: input.requestChecksum })}`);
}
export function cancelPublicationSubmission(context: PublicationSubmitContext, parent: PublicationSubmitRequestView, reason: string) {
  const input = CancelMarketplacePublicationInputSchema.parse({ reason });
  return postChecked(context, `requests/${EntityIdSchema.parse(parent.request.id)}/cancel`, input, raw => PublicationSubmitRequestViewSchema.parse(raw), value => verifyPublicationSubmission(value, { ...context, id: parent.request.id, requestKey: parent.intent.requestKey, requestChecksum: parent.intent.requestChecksum }), value => `requests/${value.request.id}`, 200);
}
