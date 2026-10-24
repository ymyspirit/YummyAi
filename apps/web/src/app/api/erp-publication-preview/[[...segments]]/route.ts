import { z } from "zod";
import { authorize } from "@yummyai/authz/authorize";
import { Permission } from "@yummyai/authz/permissions";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { CreatePublicationPreviewInputSchema, PublicationPreviewWorkspaceInputSchema, PublicationPreviewWorkspaceSchema,
  PublicationPreviewLookupSchema, PublicationPreviewReceiptSchema, PublicationPreviewRequestViewSchema,
  PublicationPreviewReadCheckInputSchema, publicationPreviewReadCheckInput } from "@yummyai/contracts/marketplace/publication-preview";
import { CancelMarketplacePublicationInputSchema, MarketplacePublicationEventViewSchema } from "@yummyai/contracts/marketplace/publication";
import { apiFetch } from "../../../../server-api";
import { assertErpIdentityCurrent, erpRequestIdentity, erpAuthFailure } from "../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../identity/core";
import { readMarketplaceJson } from "../../../../features/marketplaces/marketplace-lifecycle";
import { PUBLICATION_PREVIEW_BYTES, PublicationPreviewError, previewSameId, previewTargetChecksum, readPreviewCode,
  verifyPublicationPreview, verifyPublicationWorkspace, verifyPublicationEvents, previewDenied } from "../../../../features/marketplaces/publication-preview-client";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ segments?: string[] }> };
const privateHeaders = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const failure = (status: number, code?: string) => Response.json({ message: [401, 403, 404].includes(status) ? "当前刊登预览不可读取或操作" :
  [400, 413, 422].includes(status) ? "原预览请求格式需要核对" : "原预览结果暂时无法核对 请保留原请求标识", ...(code ? { code } : {}) }, { status, headers: { ...privateHeaders,
    ...(status === 409 && code && previewDenied(new PublicationPreviewError(status, code)) ? { "x-yummyai-error-code": code } : {}) } });
async function handle(request: Request, context: Context, method: "GET" | "POST" | "HEAD") {
  const post = method === "POST", head = method === "HEAD";
  try {
    const path = (await context.params).segments ?? [], url = new URL(request.url), id = path[1] ? EntityIdSchema.safeParse(path[1].toLowerCase()) : null;
    const mode = post ? path.length === 1 && path[0] === "requests" ? "create" : path.length === 3 && path[0] === "requests" && id?.success && path[2] === "cancel" ? "cancel" : null :
      path.length === 1 && path[0] === "workspace" ? "workspace" : path.length === 1 && path[0] === "receipt" ? "receipt" : path[0] === "requests" && id?.success ?
        path.length === 2 ? "view" : path.length === 3 && path[2] === "events" ? "events" : null : null;
    if (request.method !== method) return failure(405);
    if (!mode || head && !["workspace", "view"].includes(mode) || path.some(part => !part || part.includes("/"))) return failure(400);
    const allowed = mode === "workspace" ? head ? ["listingId", "listingVersionId", "accountIds"] : ["listingId", "listingVersionId", "variantSkuId"] : mode === "receipt" ? ["requestKey", "requestChecksum"] : [];
    for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) return failure(400);
    const workspaceInput = mode === "workspace" && !head ? PublicationPreviewWorkspaceInputSchema.safeParse(Object.fromEntries(url.searchParams)) : null;
    const readCheckInput = mode === "workspace" && head ? PublicationPreviewReadCheckInputSchema.safeParse(Object.fromEntries(url.searchParams)) : null;
    const lookup = mode === "receipt" ? PublicationPreviewLookupSchema.safeParse(Object.fromEntries(url.searchParams)) : null;
    if (mode === "workspace" && !(head ? readCheckInput?.success : workspaceInput?.success) || mode === "receipt" && !lookup?.success) return failure(400);
    if (post && request.headers.get("origin") !== url.origin) return failure(403);
    const identity = await erpRequestIdentity(request);
    try { authorize(identity.view, Permission.ListingRead); authorize(identity.view, Permission.StoreRead); if (post) authorize(identity.view, Permission.ListingPublish); } catch { return failure(403); }
    if (request.headers.get("x-yummyai-context-authority") !== identity.authority) throw new PersonalSessionError(409, "authority_changed");
    let input: z.infer<typeof CreatePublicationPreviewInputSchema> | undefined, cancellation: z.infer<typeof CancelMarketplacePublicationInputSchema> | undefined;
    if (post) {
      let raw: unknown; try { raw = await readMarketplaceJson(request as unknown as Response, 16384); } catch { return failure(400); }
      if (mode === "create") { const parsed = CreatePublicationPreviewInputSchema.safeParse(raw); if (!parsed.success) return failure(400); input = parsed.data;
        const { requestKey: _key, requestChecksum, ...target } = input; void _key;
        if (await previewTargetChecksum(target) !== requestChecksum) return failure(400);
      } else { const parsed = CancelMarketplacePublicationInputSchema.safeParse(raw); if (!parsed.success) return failure(400); cancellation = parsed.data; }
    }
    await assertErpIdentityCurrent(identity);
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    const checkRead = async (suffix: string) => {
      const response = await apiFetch(`${base}/v1/marketplace-publications${suffix}`, { method: "HEAD", cache: "no-store",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(30000)]), headers: { "x-yummyai-context-authority": identity.authority } });
      await response.body?.cancel(); await assertErpIdentityCurrent(identity);
      if (!response.ok) {
        const rawCode = response.headers.get("x-yummyai-error-code"), code = rawCode && previewDenied(new PublicationPreviewError(409, rawCode)) ? rawCode : undefined;
        throw new PublicationPreviewError([400, 401, 403, 404, 409, 412, 503].includes(response.status) ? response.status : 502, code);
      }
      if (response.status !== 200) throw new PublicationPreviewError(502);
      if (response.headers.has("x-yummyai-context-authority") && response.headers.get("x-yummyai-context-authority") !== identity.authority) throw new PersonalSessionError(409, "authority_changed");
    };
    if (head) {
      const suffix = mode === "workspace" && readCheckInput?.success ? `/preview/workspace?${new URLSearchParams(readCheckInput.data)}` : `/preview/${id!.success ? id!.data : ""}`;
      await checkRead(suffix); await assertErpIdentityCurrent(identity);
      return new Response(null, { status: 200, headers: { ...privateHeaders, "x-yummyai-context-authority": identity.authority } });
    }
    const upstream = async (suffix: string, body?: unknown, status = body === undefined ? 200 : 201) => {
      const response = await apiFetch(`${base}/v1/marketplace-publications${suffix}`, { method: body === undefined ? "GET" : "POST", cache: "no-store",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(body === undefined ? 30000 : 120000)]),
        headers: { "x-yummyai-context-authority": identity.authority, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) { const code = await readPreviewCode(response); await assertErpIdentityCurrent(identity);
        throw new PublicationPreviewError([400, 401, 403, 404, 409, 412, 413, 422, 503].includes(response.status) ? response.status : 502, code); }
      const raw = await readMarketplaceJson(response, PUBLICATION_PREVIEW_BYTES); await assertErpIdentityCurrent(identity);
      if (response.status !== status) throw new PublicationPreviewError(502);
      if (response.headers.has("x-yummyai-context-authority") && response.headers.get("x-yummyai-context-authority") !== identity.authority) throw new PersonalSessionError(409, "authority_changed");
      return raw;
    };
    let result: unknown;
    if (mode === "workspace") {
      const query = workspaceInput!.success ? workspaceInput!.data : null; if (!query) return failure(400);
      const value = PublicationPreviewWorkspaceSchema.parse(await upstream(`/preview/workspace?${new URLSearchParams(query)}`));
      await verifyPublicationWorkspace(value, { ...query, authority: identity.authority, actorId: identity.view.userId, tenantId: identity.view.tenantId }, query.variantSkuId);
      await checkRead(`/preview/workspace?${new URLSearchParams(publicationPreviewReadCheckInput(value))}`); result = value;
    } else if (mode === "receipt" || mode === "create") {
      const expected = mode === "create" ? { requestKey: input!.requestKey, requestChecksum: input!.requestChecksum } : lookup!.success ? lookup!.data : null;
      if (!expected) return failure(400);
      const saved = mode === "create" ? PublicationPreviewRequestViewSchema.parse(await upstream("/preview", input)) : null;
      const target = input ? (({ requestKey: _key, requestChecksum: _sum, ...pins }) => { void _key; void _sum; return pins; })(input) : undefined;
      if (saved) await verifyPublicationPreview(saved, { listingId: input!.listingId, ...expected, target });
      let raw: unknown; try { raw = await upstream(`/preview/receipt?${new URLSearchParams(expected)}`); }
      catch (error) { if (saved && error instanceof PublicationPreviewError && error.status === 404) throw new PublicationPreviewError(502); throw error; }
      const value = PublicationPreviewReceiptSchema.parse(raw);
      if (!previewSameId(value.requestKey, expected.requestKey) || value.requestChecksum !== expected.requestChecksum) return failure(502);
      if (value.request) await verifyPublicationPreview(value.request, { ...expected, ...(saved ? { id: saved.request.id, listingId: input!.listingId, target } : {}) });
      if (saved && (!value.found || !value.request)) return failure(502);
      if (value.request) await checkRead(`/preview/${value.request.request.id}`); result = saved ? value.request : value;
    } else {
      const requestId = id!.success ? id!.data : "", value = PublicationPreviewRequestViewSchema.parse(await upstream(`/preview/${requestId}`));
      await verifyPublicationPreview(value, { id: requestId });
      if (mode === "events") { const events = z.array(MarketplacePublicationEventViewSchema.strict()).max(2000).parse(await upstream(`/${requestId}/events`)); verifyPublicationEvents(events, value); result = events; }
      else if (mode === "cancel") { const changed = PublicationPreviewRequestViewSchema.parse(await upstream(`/preview/${requestId}/cancel`, cancellation, 200));
        await verifyPublicationPreview(changed, { id: requestId, listingId: value.request.listingId, ...(value.intent ?? {}) }); result = changed; }
      else result = value;
      await checkRead(`/preview/${requestId}`);
    }
    await assertErpIdentityCurrent(identity);
    return Response.json(result, { status: mode === "create" ? 201 : 200, headers: { ...privateHeaders, "x-yummyai-context-authority": identity.authority } });
  } catch (error) {
    if (error instanceof PersonalSessionError) { const response = erpAuthFailure(error, request);
      if (error.status === 409 && previewDenied(new PublicationPreviewError(error.status, error.code))) response.headers.set("x-yummyai-error-code", error.code); return response; }
    if (error instanceof PublicationPreviewError) return failure(error.status, error.code);
    return failure(502);
  }
}
export const GET = (request: Request, context: Context) => handle(request, context, "GET");
export const POST = (request: Request, context: Context) => handle(request, context, "POST");
export const HEAD = async (request: Request, context: Context) => { const response = await handle(request, context, "HEAD"); return new Response(null, { status: response.status, headers: response.headers }); };
