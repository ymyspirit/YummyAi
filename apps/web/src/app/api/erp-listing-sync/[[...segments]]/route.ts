import { z } from "zod";
import { authorize } from "@yummyai/authz/authorize";
import { Permission } from "@yummyai/authz/permissions";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { ListingSyncIntentLookupSchema, ListingSyncIntentReceiptSchema, ListingSyncIntentWorkspaceSchema } from "@yummyai/contracts/marketplace/listing-sync-intent";
import { CreateMarketplaceListingSyncInputSchema, MarketplaceListingSyncEventViewSchema, MarketplaceListingSyncRequestViewSchema } from "@yummyai/contracts/marketplace/listing-operations";
import { apiFetch } from "../../../../server-api";
import { assertErpIdentityCurrent, erpAuthFailure, erpRequestIdentity } from "../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../identity/core";
import { readMarketplaceJson } from "../../../../features/marketplaces/marketplace-lifecycle";
import { LISTING_SYNC_WIRE_BYTES, ListingSyncError, listingSyncRequestChecksum, listingSyncSameId, readListingSyncCode,
  verifyListingSyncEvents, verifyListingSyncRequest, verifyListingSyncWorkspace, type ListingSyncCode } from "../../../../features/marketplaces/listing-sync-client";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ segments?: string[] }> };
const headers = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const failure = (status: number, code?: ListingSyncCode) => Response.json({ message: status === 403 ? "当前无原刊登同步权限" :
  status === 400 || status === 413 ? "原同步请求格式需要核对" : "原同步资料暂时无法核对 请保留原请求标识", ...(code ? { code } : {}) }, { status, headers });
async function handle(request: Request, context: Context, post: boolean) {
  try {
    if (request.method !== (post ? "POST" : "GET")) return failure(405);
    const path = (await context.params).segments ?? [], url = new URL(request.url), id = path[1] ? EntityIdSchema.safeParse(path[1].toLowerCase()) : null;
    const mode = post ? path.length === 1 && path[0] === "requests" ? "create" : null :
      path.length === 1 && path[0] === "workspace" ? "workspace" : path.length === 1 && path[0] === "receipt" ? "receipt" :
        path[0] === "requests" && id?.success ? path.length === 2 ? "view" : path.length === 3 && path[2] === "events" ? "events" : null : null;
    if (!mode || path.some(part => !part || part.includes("/"))) return failure(400);
    const allowed = mode === "workspace" ? ["listingId"] : mode === "receipt" ? ["requestKey", "requestChecksum"] : [];
    for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) return failure(400);
    const listing = mode === "workspace" ? EntityIdSchema.safeParse(url.searchParams.get("listingId")?.toLowerCase()) : null;
    const lookup = mode === "receipt" ? ListingSyncIntentLookupSchema.safeParse(Object.fromEntries(url.searchParams)) : null;
    if (mode === "workspace" && !listing?.success || mode === "receipt" && !lookup?.success) return failure(400);
    if (post && request.headers.get("origin") !== url.origin) return failure(403);
    const identity = await erpRequestIdentity(request);
    try { authorize(identity.view, Permission.ListingRead); if (post) authorize(identity.view, Permission.ListingPublish); } catch { return failure(403); }
    if (request.headers.get("x-yummyai-context-authority") !== identity.authority) throw new PersonalSessionError(409, "authority_changed");
    let input: z.infer<typeof CreateMarketplaceListingSyncInputSchema> | undefined;
    if (post) {
      let raw: unknown; try { raw = await readMarketplaceJson(request as unknown as Response, 16384); } catch { return failure(400); }
      const parsed = CreateMarketplaceListingSyncInputSchema.safeParse(raw); if (!parsed.success || !parsed.data.requestKey) return failure(400); input = parsed.data;
    }
    await assertErpIdentityCurrent(identity);
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    const upstreamRead = async (suffix: string, body?: typeof input) => {
      const response = await apiFetch(`${base}/v1/marketplace-listing-syncs${suffix}`, { method: body ? "POST" : "GET", cache: "no-store",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(body ? 120000 : 30000)]),
        headers: { "x-yummyai-context-authority": identity.authority, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) {
        const code = await readListingSyncCode(response); await assertErpIdentityCurrent(identity);
        throw new ListingSyncError([400, 401, 403, 404, 409, 412, 413, 422, 503].includes(response.status) ? response.status : 502, code);
      }
      const raw = await readMarketplaceJson(response, LISTING_SYNC_WIRE_BYTES); await assertErpIdentityCurrent(identity);
      if (response.status !== (body ? 201 : 200)) throw new ListingSyncError(502);
      if (response.headers.has("x-yummyai-context-authority") && response.headers.get("x-yummyai-context-authority") !== identity.authority) throw new PersonalSessionError(409, "authority_changed");
      return raw;
    };
    let result: unknown;
    if (mode === "workspace") {
      const listingId = listing!.success ? listing!.data : "", value = ListingSyncIntentWorkspaceSchema.parse(await upstreamRead(`/workspace?${new URLSearchParams({ listingId })}`));
      verifyListingSyncWorkspace(value, { listingId, actorId: identity.view.userId, tenantId: identity.view.tenantId, authority: identity.authority }); result = value;
    } else if (mode === "receipt" || mode === "create") {
      const expected = mode === "create" ? { requestKey: input!.requestKey!, requestChecksum: await listingSyncRequestChecksum(input!) } : lookup!.success ? lookup!.data : null;
      if (!expected) return failure(400);
      const saved = mode === "create" ? MarketplaceListingSyncRequestViewSchema.strict().parse(await upstreamRead("", input)) : null;
      if (saved) await verifyListingSyncRequest(saved, input!.listingId, { input });
      let receipt: unknown;
      try { receipt = await upstreamRead(`/receipt?${new URLSearchParams(expected)}`); }
      catch (error) { if (saved && error instanceof ListingSyncError && error.status === 404) throw new ListingSyncError(502); throw error; }
      const value = ListingSyncIntentReceiptSchema.parse(receipt);
      if (!listingSyncSameId(value.requestKey, expected.requestKey) || value.requestChecksum !== expected.requestChecksum) return failure(502);
      if (value.request) await verifyListingSyncRequest(value.request, saved?.listingId ?? value.request.listingId, { requestChecksum: expected.requestChecksum, ...(saved ? { id: saved.id, input } : {}) });
      if (saved && (!value.found || !value.request)) return failure(502);
      result = saved ? value.request : value;
    } else {
      const requestId = id!.success ? id!.data : "", value = MarketplaceListingSyncRequestViewSchema.strict().parse(await upstreamRead(`/${requestId}`));
      await verifyListingSyncRequest(value, value.listingId, { id: requestId });
      if (mode === "events") {
        const events = z.array(MarketplaceListingSyncEventViewSchema.strict()).parse(await upstreamRead(`/${requestId}/events`)); verifyListingSyncEvents(events, value); result = events;
      } else result = value;
    }
    await assertErpIdentityCurrent(identity);
    return Response.json(result, { status: post ? 201 : 200, headers: { ...headers, "x-yummyai-context-authority": identity.authority } });
  } catch (error) {
    if (error instanceof PersonalSessionError) return erpAuthFailure(error, request);
    if (error instanceof ListingSyncError) return failure(error.status, error.code);
    return failure(502);
  }
}
export const GET = (request: Request, context: Context) => handle(request, context, false);
export const POST = (request: Request, context: Context) => handle(request, context, true);
