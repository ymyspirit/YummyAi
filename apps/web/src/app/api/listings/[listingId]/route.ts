import { z } from "zod";
import { authorize } from "@yummyai/authz/authorize";
import { Permission } from "@yummyai/authz/permissions";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { apiFetch } from "../../../../server-api";
import { assertErpIdentityCurrent, erpRequestIdentity, erpAuthFailure } from "../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../identity/core";
import { readMarketplaceJson } from "../../../../features/marketplaces/marketplace-lifecycle";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ listingId: string }> };
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const objectSchema = z.object({ listing: z.object({ id: EntityIdSchema, ownerUserId: EntityIdSchema.optional(),
  status: z.enum(["draft", "in_review", "approved", "archived"]) }).passthrough(), version: z.object({ id: EntityIdSchema }).passthrough() }).passthrough();
async function handle(request: Request, context: Context, head: boolean) {
  try {
    const id = EntityIdSchema.safeParse((await context.params).listingId.toLowerCase());
    if (!id.success) return failure(404);
    if (new URL(request.url).search) return failure(400);
    const identity = await erpRequestIdentity(request), authority = erpSessionAuthority(identity.view);
    try { authorize(identity.view, Permission.ListingRead); } catch { return failure(403); }
    const supplied = request.headers.get("x-yummyai-context-authority");
    if (supplied !== null && supplied !== authority) throw new PersonalSessionError(409, "authority_changed");
    await assertErpIdentityCurrent(identity);
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    const init = { cache: "no-store" as const, signal: AbortSignal.any([request.signal, AbortSignal.timeout(20000)]) };
    let value: z.infer<typeof objectSchema> | undefined;
    if (!head) {
      const response = await apiFetch(`${base}/v1/listings/${id.data}`, init);
      if (!response.ok) { await response.body?.cancel(); await assertErpIdentityCurrent(identity); return failure(safeStatus(response.status)); }
      if (response.status !== 200) { await response.body?.cancel(); return failure(502); }
      value = objectSchema.parse(await readMarketplaceJson(response, 8 * 1024 * 1024));
      if (value.listing.id.toLowerCase() !== id.data) return failure(502);
      await assertErpIdentityCurrent(identity);
    }
    const checked = await apiFetch(`${base}/v1/listings/${id.data}`, { ...init, method: "HEAD" });
    await checked.body?.cancel(); await assertErpIdentityCurrent(identity);
    if (!checked.ok) return failure(safeStatus(checked.status));
    if (checked.status !== 200) return failure(502);
    return head ? new Response(null, { status: 200, headers: { ...headers, "x-yummyai-context-authority": authority } }) :
      Response.json(value, { headers: { ...headers, "x-yummyai-context-authority": authority } });
  } catch (error) {
    if (error instanceof PersonalSessionError) {
      const response = erpAuthFailure(error, request);
      if (error.status === 409 && error.code === "authority_changed") response.headers.set("x-yummyai-error-code", error.code);
      return response;
    }
    return failure(502);
  }
}
function safeStatus(status: number) { return [400, 401, 403, 404, 409, 412, 503].includes(status) ? status : 502; }
function failure(status: number) {
  return Response.json({ message: [401, 403, 404].includes(status) ? "刊登不存在或当前账号不可读取" : "刊登暂时无法核对 请重试" }, { status, headers });
}
export const GET = (request: Request, context: Context) => handle(request, context, false);
export const HEAD = async (request: Request, context: Context) => { const response = await handle(request, context, true); return new Response(null, { status: response.status, headers: response.headers }); };
