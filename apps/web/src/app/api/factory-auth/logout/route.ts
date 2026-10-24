import { NextResponse } from "next/server";
import { factoryPortalOnly } from "../../../../factory-portal-mode";
import {
  factoryIdentity,
  factoryCookieNames,
  setFactoryCookie,
  factoryCookie,
  factoryWriteOrigin,
  factoryAuthFailure,
} from "../../../../factory-auth/server";
import { FactoryAuthError } from "../../../../factory-auth/core";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  if (!factoryPortalOnly()) return new Response(null, { status: 404 });
  try {
    const service = factoryIdentity(),
      origin = service.configuration.origin,
      names = factoryCookieNames(origin);
    factoryWriteOrigin(request, origin);
    if (new URL(request.url).search) throw new FactoryAuthError(400, "login_invalid");
    await service.logout(factoryCookie(request, names.session));
    const response = NextResponse.json(
      { signedOut: true },
      { headers: { "Cache-Control": "private, no-store" } },
    );
    setFactoryCookie(response, origin, names.session, "", 0);
    setFactoryCookie(response, origin, names.flow, "", 0);
    return response;
  } catch (error) {
    return factoryAuthFailure(error, request);
  }
}
