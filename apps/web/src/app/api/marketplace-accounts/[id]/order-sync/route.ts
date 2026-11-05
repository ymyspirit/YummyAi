import { authorize } from "@yummyai/authz/authorize";
import { Permission } from "@yummyai/authz/permissions";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { OrderSyncSettingsViewSchema, SaveOrderSyncSettingsSchema } from "@yummyai/contracts/order/sync";
import { apiFetch } from "../../../../../server-api";
import { assertErpIdentityCurrent, erpAuthFailure, erpRequestIdentity } from "../../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../../identity/core";
import { readMarketplaceJson } from "../../../../../features/marketplaces/marketplace-lifecycle";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
type Context = { params: Promise<{ id: string }> };
async function handle(request: Request, context: Context, post: boolean) {
  const failure = (status: number) => Response.json({ message: "自动拉单状态未核对 请重新读取店铺设置" }, { status, headers });
  try {
    const accountId = EntityIdSchema.parse((await context.params).id.toLowerCase()), url = new URL(request.url);
    if (url.search) return failure(400);
    if (post && request.headers.get("origin") !== url.origin) return failure(403);
    const identity = await erpRequestIdentity(request);
    try { authorize(identity.view, Permission.StoreRead);
      if (post) for (const permission of [Permission.StoreManage, Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead]) authorize(identity.view, permission);
    } catch { return failure(403); }
    if (request.headers.get("x-yummyai-context-authority") !== identity.authority) throw new PersonalSessionError(409, "authority_changed");
    let input: unknown;
    if (post) { const parsed = SaveOrderSyncSettingsSchema.safeParse(await readMarketplaceJson(request as unknown as Response, 4096));
      if (!parsed.success) return failure(400); input = parsed.data; }
    await assertErpIdentityCurrent(identity);
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    const upstream = await apiFetch(`${base}/v1/marketplace-accounts/${accountId}/order-sync`, { method: post ? "POST" : "GET", cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]), headers: { "x-yummyai-context-authority": identity.authority,
        ...(post ? { "content-type": "application/json" } : {}) }, ...(post ? { body: JSON.stringify(input) } : {}) });
    await assertErpIdentityCurrent(identity);
    if (!upstream.ok) return failure([400, 401, 403, 404, 409, 422, 503].includes(upstream.status) ? upstream.status : 502);
    const view = OrderSyncSettingsViewSchema.parse(await readMarketplaceJson(upstream, 8192));
    if (view.accountId !== accountId || upstream.headers.has("x-yummyai-context-authority") && upstream.headers.get("x-yummyai-context-authority") !== identity.authority) return failure(409);
    await assertErpIdentityCurrent(identity);
    return Response.json(view, { headers: { ...headers, "x-yummyai-context-authority": identity.authority } });
  } catch (error) { if (error instanceof PersonalSessionError) return erpAuthFailure(error, request); return failure(502); }
}
export const GET = (request: Request, context: Context) => handle(request, context, false);
export const POST = (request: Request, context: Context) => handle(request, context, true);
