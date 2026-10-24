import { NextResponse } from "next/server";
import {
  erpIdentity,
  erpCookieNames,
  readIdentityCookie,
  writeIdentityCookie,
  erpAuthFailure,
} from "../../../../erp-auth/server";
import { requireIdentityOrigin } from "../../../../identity/http";
import { PersonalSessionError } from "../../../../identity/core";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const service = erpIdentity(),
      origin = service.configuration.origin,
      names = erpCookieNames(origin);
    requireIdentityOrigin(request, origin);
    if (new URL(request.url).search) throw new PersonalSessionError(400, "login_invalid");
    await service.logout(readIdentityCookie(request, names.session));
    const response = NextResponse.json(
      { signedOut: true },
      { headers: { "cache-control": "private, no-store" } },
    );
    writeIdentityCookie(response, origin, names.session, "", 0);
    writeIdentityCookie(response, origin, names.flow, "", 0);
    return response;
  } catch (error) {
    return erpAuthFailure(error, request);
  }
}
