import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { MARKETPLACE_OAUTH_ACCOUNT_COOKIE } from "../../../../../features/marketplaces/marketplace-oauth";
import { apiFetch } from "../../../../../server-api";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cookieStore = await cookies();
  const accountId = cookieStore.get(MARKETPLACE_OAUTH_ACCOUNT_COOKIE)?.value;
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code") ?? url.searchParams.get("spapi_oauth_code");
  const sellingPartnerId = url.searchParams.get("selling_partner_id");
  const target = new URL("/stores", request.url);
  if (!accountId || !state || !code) {
    target.searchParams.set("oauth", "failed");
    target.searchParams.set("reason", "missing_callback_data");
    return redirectAndClear(target);
  }
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) {
    target.searchParams.set("oauth", "failed");
    target.searchParams.set("reason", "api_unavailable");
    return redirectAndClear(target);
  }
  const response = await apiFetch(
    `${apiBase.replace(/\/$/, "")}/v1/marketplace-accounts/${accountId}/authorization/oauth/complete`,
    {
      body: JSON.stringify({ code, state, ...(sellingPartnerId ? { sellingPartnerId } : {}) }),
      cache: "no-store",
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  target.searchParams.set("oauth", response.ok ? "success" : "failed");
  if (!response.ok) target.searchParams.set("reason", `provider_${response.status}`);
  return redirectAndClear(target);
}

function redirectAndClear(target: URL): NextResponse {
  const response = NextResponse.redirect(target);
  response.cookies.delete(MARKETPLACE_OAUTH_ACCOUNT_COOKIE);
  return response;
}
