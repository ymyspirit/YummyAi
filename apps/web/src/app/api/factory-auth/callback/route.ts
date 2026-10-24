import { NextResponse } from "next/server";
import { factoryPortalOnly } from "../../../../factory-portal-mode";
import {
  factoryIdentity,
  factoryCookieNames,
  setFactoryCookie,
  factoryCookie,
  factoryAuthFailure,
} from "../../../../factory-auth/server";
import { FactoryAuthError } from "../../../../factory-auth/core";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!factoryPortalOnly()) return new Response(null, { status: 404 });
  try {
    const service = factoryIdentity(),
      c = service.configuration,
      names = factoryCookieNames(c.origin),
      query = new URL(request.url).searchParams;
    if (
      [...query.keys()].some(
        (key) =>
          !["code", "state", "session_state", "iss", "error", "error_description"].includes(key) ||
          query.getAll(key).length !== 1,
      ) ||
      query.has("error") ||
      (query.has("iss") && query.get("iss") !== c.issuer)
    )
      throw new FactoryAuthError(400, "login_invalid");
    const completed = await service.finish(
      factoryCookie(request, names.flow),
      query.get("state") ?? "",
      query.get("code") ?? "",
    );
    await service.logout(factoryCookie(request, names.session));
    const response = NextResponse.redirect(new URL("/factory-work-items", c.origin));
    setFactoryCookie(response, c.origin, names.flow, "", 0);
    setFactoryCookie(response, c.origin, names.session, completed.sessionId, completed.maxAge);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return factoryAuthFailure(error, request);
  }
}
