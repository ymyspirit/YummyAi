import { Permission } from "@yummyai/authz/permissions";
import { authorize } from "@yummyai/authz/authorize";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { MarketplaceAuthorityWorkspaceSchema } from "@yummyai/contracts/marketplace/authority";
import { apiFetch } from "../../../../../server-api";
import { erpRequestIdentity, assertErpIdentityCurrent, erpAuthFailure } from "../../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../../identity/core";
import { marketplaceAuthorityMatches, marketplaceResponseCode, readMarketplaceJson } from "../../../../../features/marketplaces/marketplace-lifecycle";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const failure = (status: number, code?: string) => Response.json({
  message: status === 401 ? "请登录自己的运营账户" : status === 403 ? "当前没有读取本店授权状态的权限" :
    status === 404 ? "当前无法读取这家店铺" : status === 400 ? "店铺读取请求格式需核对" :
      status === 409 ? "当前店铺或本人权限已变化 请重新读取" : "店铺授权状态暂时无法核对", ...(code ? { code } : {}),
}, { status, headers });
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = EntityIdSchema.safeParse((await context.params).id.toLowerCase());
  if (!id.success || new URL(request.url).search) return failure(400);
  try {
    const identity = await erpRequestIdentity(request);
    try { authorize(identity.view, Permission.StoreRead); } catch { return failure(403); }
    if (request.headers.get("x-yummyai-context-authority") !== identity.authority) throw new PersonalSessionError(409, "authority_changed");
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    const response = await apiFetch(`${base}/v1/marketplace-accounts/${id.data}/authority`, {
      cache: "no-store", headers: { "x-yummyai-context-authority": identity.authority },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(20000)]),
    });
    if (!response.ok) { const code = await marketplaceResponseCode(response); await assertErpIdentityCurrent(identity);
      return failure([400, 401, 403, 404, 409, 422, 503].includes(response.status) ? response.status : 502, code); }
    const parsed = MarketplaceAuthorityWorkspaceSchema.safeParse(await readMarketplaceJson(response, 1024 * 1024));
    await assertErpIdentityCurrent(identity);
    if (response.status !== 200 || !parsed.success) return failure(502);
    if (!marketplaceAuthorityMatches(parsed.data, { accountId: id.data, actorId: identity.view.userId,
      tenantId: identity.view.tenantId, authority: identity.authority }) ||
      response.headers.has("x-yummyai-context-authority") && response.headers.get("x-yummyai-context-authority") !== identity.authority)
      return failure(409, "authority_changed");
    return Response.json(parsed.data, { status: 200, headers: { ...headers, "x-yummyai-context-authority": identity.authority } });
  } catch (error) { return error instanceof PersonalSessionError ? erpAuthFailure(error, request) : failure(502); }
}
