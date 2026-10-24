import { authorize } from "@yummyai/authz/authorize";
import { Permission } from "@yummyai/authz/permissions";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { CreatePublicationSubmitInputSchema, CreatePublicationStatusInputSchema, PublicationSubmitWorkspaceInputSchema, PublicationSubmitLookupSchema,
  PublicationSubmitWorkspaceSchema, PublicationSubmitRequestViewSchema, PublicationSubmitReceiptSchema, PublicationStatusReadViewSchema, PublicationStatusReceiptSchema,
  publicationSubmitRequestText, publicationStatusRequestText } from "@yummyai/contracts/marketplace/publication-submit";
import { CancelMarketplacePublicationInputSchema } from "@yummyai/contracts/marketplace/publication";
import { apiFetch } from "../../../server-api";
import { erpRequestIdentity, assertErpIdentityCurrent, erpAuthFailure } from "../../../erp-auth/server";
import { PersonalSessionError } from "../../../identity/core";
import { readMarketplaceJson } from "../../../features/marketplaces/marketplace-lifecycle";
import { PUBLICATION_SUBMIT_BYTES, PublicationSubmitError, publicationSubmitDenied, publicationSubmitHash, readPublicationSubmitCode,
  verifyPublicationSubmission, verifyPublicationStatus, verifyPublicationSubmitWorkspace, submitSameId } from "../../../features/marketplaces/publication-submit-client";

type Mode = "workspace" | "create" | "view" | "receipt" | "status" | "status-receipt" | "cancel";
const privateHeaders = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const safeStatus = (status: number) => [400, 401, 403, 404, 409, 412, 413, 422, 503].includes(status) ? status : 502;
function failure(status: number, code?: string) { return Response.json({ message: [401, 403, 404].includes(status) ? "当前原正式提交不可读取或操作" : "原正式操作暂时无法核对 请保留原请求标识", ...(code ? { code } : {}) },
  { status, headers: { ...privateHeaders, ...(status === 409 && code && publicationSubmitDenied(new PublicationSubmitError(status, code)) ? { "x-yummyai-error-code": code } : {}) } }); }
export async function publicationSubmitProxy(request: Request, mode: Mode, rawId?: string): Promise<Response> {
  const response = await proxyResponse(request, mode, rawId);
  return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
}
async function proxyResponse(request: Request, mode: Mode, rawId?: string): Promise<Response> {
  const head = request.method === "HEAD", post = ["create", "status", "cancel"].includes(mode);
  let response: Response;
  try {
    if (post ? request.method !== "POST" : !["GET", "HEAD"].includes(request.method)) return failure(405);
    const url = new URL(request.url), allowed = mode === "workspace" ? ["previewRequestId"] : ["receipt", "status-receipt"].includes(mode) ? ["requestKey", "requestChecksum"] : [];
    for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) return failure(400);
    const id = rawId === undefined ? null : EntityIdSchema.safeParse(rawId.toLowerCase()); if (rawId !== undefined && !id?.success) return failure(400);
    const workspace = mode === "workspace" ? PublicationSubmitWorkspaceInputSchema.safeParse(Object.fromEntries(url.searchParams)) : null;
    const lookup = ["receipt", "status-receipt"].includes(mode) ? PublicationSubmitLookupSchema.safeParse(Object.fromEntries(url.searchParams)) : null;
    if (mode === "workspace" && !workspace?.success || lookup && !lookup.success) return failure(400);
    if (post && request.headers.get("origin") !== url.origin) return failure(403);
    const identity = await erpRequestIdentity(request);
    try { authorize(identity.view, Permission.ListingRead); authorize(identity.view, Permission.StoreRead); if (post) authorize(identity.view, Permission.ListingPublish); } catch { return failure(403); }
    if (request.headers.get("x-yummyai-context-authority") !== identity.authority) throw new PersonalSessionError(409, "authority_changed");
    await assertErpIdentityCurrent(identity); const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    const path = mode === "workspace" ? `/workspace?${new URLSearchParams(workspace!.success ? workspace!.data : {})}` : mode === "receipt" || mode === "status-receipt" ?
      `/${mode}?${new URLSearchParams(lookup!.success ? lookup!.data : {})}` : mode === "create" ? "/requests" : `/requests/${id!.success ? id!.data : ""}${mode === "view" ? "" : `/${mode}`}`;
    const currentHead = async (suffix: string) => {
      const check = await apiFetch(`${base}/v1/marketplace-publication-submissions${suffix}`, { method: "HEAD", cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(30000)]), headers: { "x-yummyai-context-authority": identity.authority } });
      await check.body?.cancel(); await assertErpIdentityCurrent(identity);
      if (!check.ok) { const code = check.headers.get("x-yummyai-error-code"); throw new PublicationSubmitError(safeStatus(check.status), code && publicationSubmitDenied(new PublicationSubmitError(409, code)) ? code : undefined); }
      if (check.status !== 200) throw new PublicationSubmitError(502);
      if (check.headers.has("x-yummyai-context-authority") && check.headers.get("x-yummyai-context-authority") !== identity.authority) throw new PersonalSessionError(409, "authority_changed");
    };
    const upstream = async (suffix: string, body?: unknown, status = body === undefined ? 200 : 201) => {
      const result = await apiFetch(`${base}/v1/marketplace-publication-submissions${suffix}`, { method: body === undefined ? "GET" : "POST", cache: "no-store",
        headers: { "x-yummyai-context-authority": identity.authority, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(body === undefined ? 30000 : 120000)]) });
      if (!result.ok) { const code = await readPublicationSubmitCode(result); await assertErpIdentityCurrent(identity); throw new PublicationSubmitError(safeStatus(result.status), code); }
      const value = await readMarketplaceJson(result, PUBLICATION_SUBMIT_BYTES); await assertErpIdentityCurrent(identity);
      if (result.status !== status) throw new PublicationSubmitError(502);
      if (result.headers.has("x-yummyai-context-authority") && result.headers.get("x-yummyai-context-authority") !== identity.authority) throw new PersonalSessionError(409, "authority_changed");
      return value;
    };
    if (head) { await currentHead(path); await assertErpIdentityCurrent(identity); return new Response(null, { status: 200, headers: { ...privateHeaders, "x-yummyai-context-authority": identity.authority } }); }
    let value: unknown;
    if (mode === "workspace") {
      const input = workspace!.success ? workspace!.data : null; if (!input) return failure(400);
      const view = PublicationSubmitWorkspaceSchema.parse(await upstream(path)); await verifyPublicationSubmitWorkspace(view, { ...input, actorId: identity.view.userId, tenantId: identity.view.tenantId, authority: identity.authority }); value = view; await currentHead(path);
    } else if (mode === "create") {
      let raw: unknown; try { raw = await readMarketplaceJson(request as unknown as Response, 16384); } catch { return failure(400); }
      const parsed = CreatePublicationSubmitInputSchema.safeParse(raw); if (!parsed.success) return failure(400);
      const { requestKey, requestChecksum, acknowledgeReplacement: _ack, ...target } = parsed.data; void _ack;
      if (await publicationSubmitHash(publicationSubmitRequestText(target)) !== requestChecksum) return failure(400);
      const saved = PublicationSubmitRequestViewSchema.parse(await upstream(path, parsed.data)); await verifyPublicationSubmission(saved, { ...target, requestKey, requestChecksum });
      let proof: unknown; try { proof = await upstream(`/receipt?${new URLSearchParams({ requestKey, requestChecksum })}`); } catch (error) { if (error instanceof PublicationSubmitError && error.status === 404) throw new PublicationSubmitError(502); throw error; }
      const receipt = PublicationSubmitReceiptSchema.parse(proof);
      if (!receipt.found || !receipt.request || !submitSameId(receipt.requestKey, requestKey) || receipt.requestChecksum !== requestChecksum) return failure(502);
      await verifyPublicationSubmission(receipt.request, { ...target, id: saved.request.id, requestKey, requestChecksum }); value = receipt.request; await currentHead(`/requests/${saved.request.id}`);
    } else if (mode === "receipt" || mode === "status-receipt") {
      const input = lookup!.success ? lookup!.data : null; if (!input) return failure(400);
      if (mode === "receipt") { const receipt = PublicationSubmitReceiptSchema.parse(await upstream(path)); if (!submitSameId(receipt.requestKey, input.requestKey) || receipt.requestChecksum !== input.requestChecksum) return failure(502);
        if (receipt.request) await verifyPublicationSubmission(receipt.request, input); value = receipt;
      } else { const receipt = PublicationStatusReceiptSchema.parse(await upstream(path)); if (!submitSameId(receipt.requestKey, input.requestKey) || receipt.requestChecksum !== input.requestChecksum) return failure(502);
        if (receipt.operation) { const parent = PublicationSubmitRequestViewSchema.parse(await upstream(`/requests/${receipt.operation.requestId}`)); await verifyPublicationSubmission(parent, { id: receipt.operation.requestId }); await verifyPublicationStatus(receipt.operation, { ...input, parent }); }
        value = receipt;
      } await currentHead(path);
    } else {
      const requestId = id!.success ? id!.data : "", parent = PublicationSubmitRequestViewSchema.parse(await upstream(`/requests/${requestId}`)); await verifyPublicationSubmission(parent, { id: requestId });
      if (mode === "view") { value = parent; await currentHead(path); }
      else {
        let raw: unknown; try { raw = await readMarketplaceJson(request as unknown as Response, 16384); } catch { return failure(400); }
        await currentHead(`/requests/${requestId}`);
        if (mode === "cancel") { const input = CancelMarketplacePublicationInputSchema.safeParse(raw); if (!input.success) return failure(400); if (!parent.access.canCancel) return failure(409);
          const changed = PublicationSubmitRequestViewSchema.parse(await upstream(path, input.data, 200)); await verifyPublicationSubmission(changed, { id: requestId, previewRequestId: parent.intent.target.previewRequestId, requestKey: parent.intent.requestKey, requestChecksum: parent.intent.requestChecksum }); value = changed; await currentHead(`/requests/${requestId}`);
        } else { const parsed = CreatePublicationStatusInputSchema.safeParse(raw); if (!parsed.success) return failure(400);
          const { requestKey, requestChecksum, ...target } = parsed.data;
          if (!parent.access.canReadStatus || !submitSameId(target.publicationRequestId, requestId) || !parent.statusTarget || publicationStatusRequestText(target) !== publicationStatusRequestText(parent.statusTarget) || await publicationSubmitHash(publicationStatusRequestText(target)) !== requestChecksum) return failure(409);
          const saved = PublicationStatusReadViewSchema.parse(await upstream(path, parsed.data)); await verifyPublicationStatus(saved, { requestId, requestKey, requestChecksum, parent });
          let proof: unknown; try { proof = await upstream(`/status-receipt?${new URLSearchParams({ requestKey, requestChecksum })}`); } catch (error) { if (error instanceof PublicationSubmitError && error.status === 404) throw new PublicationSubmitError(502); throw error; }
          const receipt = PublicationStatusReceiptSchema.parse(proof);
          if (!receipt.found || !receipt.operation || !submitSameId(receipt.operation.id, saved.id) || !submitSameId(receipt.requestKey, requestKey) || receipt.requestChecksum !== requestChecksum) return failure(502);
          await verifyPublicationStatus(receipt.operation, { requestId, requestKey, requestChecksum, parent }); value = receipt.operation; await currentHead(`/status-receipt?${new URLSearchParams({ requestKey, requestChecksum })}`);
        }
      }
    }
    await assertErpIdentityCurrent(identity); response = Response.json(value, { status: mode === "create" || mode === "status" ? 201 : 200, headers: { ...privateHeaders, "x-yummyai-context-authority": identity.authority } });
  } catch (error) {
    if (error instanceof PersonalSessionError) { response = erpAuthFailure(error, request); if (error.status === 409 && publicationSubmitDenied(new PublicationSubmitError(error.status, error.code))) response.headers.set("x-yummyai-error-code", error.code); }
    else response = error instanceof PublicationSubmitError ? failure(error.status, error.code) : failure(502);
  }
  return head ? new Response(null, { status: response.status, headers: response.headers }) : response;
}
