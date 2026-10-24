import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { authorize } from "@yummyai/authz/authorize";
import { Permission } from "@yummyai/authz/permissions";
import { MarketplaceAccountViewSchema, MarketplaceOAuthCompleteInputSchema } from "@yummyai/contracts/marketplace/store";
import { MarketplaceAuthorityWorkspaceSchema } from "@yummyai/contracts/marketplace/authority";

import { marketplaceOAuthCookieName, marketplaceOAuthStateDigest, parseMarketplaceOAuthCallback,
  readMarketplaceOAuthBinding } from "../../../../../features/marketplaces/marketplace-oauth";
import { marketplaceAuthorityMatches, readMarketplaceJson } from "../../../../../features/marketplaces/marketplace-lifecycle";
import { apiFetch } from "../../../../../server-api";
import { erpRequestIdentity, assertErpIdentityCurrent, type ErpRequestIdentity } from "../../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../../identity/core";

export async function GET(request: Request) {
  let cookieName: string | undefined, accountId: string | undefined;
  const finish = (reason: string | null) => {
    const target = new URL(accountId ? `/stores/${accountId}` : "/stores", request.url);
    target.searchParams.set("oauth", reason === null ? "success" : "failed");
    if (reason) target.searchParams.set("reason", reason);
    const response = NextResponse.redirect(target);
    response.headers.set("cache-control", "private, no-store"); response.headers.set("referrer-policy", "no-referrer");
    if (cookieName) response.cookies.set(cookieName, "", { maxAge: 0, path: "/stores/oauth/callback", httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
    return response;
  };
  let submitted = false;
  try {
    const callback = parseMarketplaceOAuthCallback(new URL(request.url));
    cookieName = marketplaceOAuthCookieName(callback.state);
    const binding = readMarketplaceOAuthBinding((await cookies()).get(cookieName)?.value);
    if (!binding || binding.stateDigest !== marketplaceOAuthStateDigest(callback.state) || Date.parse(binding.expiresAt) <= Date.now())
      return finish("invalid_callback");
    const identity = await erpRequestIdentity(request);
    try { authorize(identity.view, Permission.StoreAuthorize); } catch { return finish("authorization_denied"); }
    if (binding.actorId.toLowerCase() !== identity.view.userId.toLowerCase() || binding.tenantId.toLowerCase() !== identity.view.tenantId.toLowerCase() ||
      binding.authority !== identity.authority) return finish("session_changed");
    accountId = binding.accountId.toLowerCase();
    if (callback.error) return finish("platform_declined");
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return finish("api_unavailable");
    const before = await currentAuthority(base, identity, accountId);
    if (!before || !before.access.authorize || before.account.platform !== binding.platform ||
      before.lifecycle.authorizationGeneration !== binding.authorizationGeneration) return finish("authorization_state_changed");
    if (binding.platform === "amazon" && !callback.sellingPartnerId || binding.platform === "etsy" && callback.sellingPartnerId)
      return finish("invalid_callback");
    const input = MarketplaceOAuthCompleteInputSchema.parse({ code: callback.code, state: callback.state,
      ...(callback.sellingPartnerId ? { sellingPartnerId: callback.sellingPartnerId } : {}) });
    submitted = true;
    const response = await apiFetch(`${base}/v1/marketplace-accounts/${accountId}/authorization/oauth/complete`, {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(120000), body: JSON.stringify(input),
      headers: { "content-type": "application/json", "x-yummyai-context-authority": identity.authority },
    });
    if (!response.ok) { await response.body?.cancel(); await assertErpIdentityCurrent(identity);
      return finish(response.status >= 500 ? "authorization_unknown" : "authorization_rejected"); }
    const result = MarketplaceAccountViewSchema.strict().safeParse(await readMarketplaceJson(response, 1024 * 1024));
    await assertErpIdentityCurrent(identity);
    if (response.status !== 201 || !result.success || result.data.id.toLowerCase() !== accountId || result.data.platform !== binding.platform)
      return finish("authorization_unknown");
    const current = await currentAuthority(base, identity, accountId);
    if (!current || !current.account.hasCredential || current.account.status === "disabled" || current.account.status === "revoked" ||
      current.lifecycle.refreshState !== "known") return finish("authorization_state_changed");
    return finish(null);
  } catch (error) { if (error instanceof PersonalSessionError && [401, 403, 409].includes(error.status)) accountId = undefined;
    return finish(submitted ? "authorization_unknown" : "invalid_callback"); }
}

async function currentAuthority(base: string, identity: ErpRequestIdentity, accountId: string) {
  const response = await apiFetch(`${base}/v1/marketplace-accounts/${accountId}/authority`, { cache: "no-store",
    signal: AbortSignal.timeout(20000), headers: { "x-yummyai-context-authority": identity.authority } });
  if (!response.ok) { await response.body?.cancel(); await assertErpIdentityCurrent(identity); return null; }
  const parsed = MarketplaceAuthorityWorkspaceSchema.safeParse(await readMarketplaceJson(response, 1024 * 1024));
  await assertErpIdentityCurrent(identity);
  if (response.status !== 200 || !parsed.success || !marketplaceAuthorityMatches(parsed.data, { accountId,
    actorId: identity.view.userId, tenantId: identity.view.tenantId, authority: identity.authority }) ||
    response.headers.has("x-yummyai-context-authority") && response.headers.get("x-yummyai-context-authority") !== identity.authority) return null;
  return parsed.data;
}
