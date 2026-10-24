import { NextResponse } from "next/server";
import {
  erpIdentity,
  erpCookieNames,
  readIdentityCookie,
  writeIdentityCookie,
  erpAuthFailure,
} from "../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../identity/core";
import { erpReturnPath } from "../../../../web-auth-mode";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const service = erpIdentity(),
      c = service.configuration,
      names = erpCookieNames(c.origin),
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
      throw new PersonalSessionError(400, "login_invalid");
    const completed = await service.finish(
      readIdentityCookie(request, names.flow),
      query.get("state") ?? "",
      query.get("code") ?? "",
    );
    await service.logout(readIdentityCookie(request, names.session));
    const response = NextResponse.redirect(new URL(erpReturnPath(completed.returnPath), c.origin));
    writeIdentityCookie(response, c.origin, names.flow, "", 0);
    writeIdentityCookie(response, c.origin, names.session, completed.sessionId, completed.maxAge);
    response.headers.set("cache-control", "private, no-store");
    return response;
  } catch (error) {
    const failed = erpAuthFailure(error, request),
      code = error instanceof PersonalSessionError ? error.code : "session_unavailable",
      origin = process.env.WEB_ORIGIN;
    try {
      if (origin) {
        const destination = new URL("/login", origin);
        destination.searchParams.set("reason", code);
        const response = NextResponse.redirect(destination);
        for (const value of failed.headers.getSetCookie())
          response.headers.append("set-cookie", value);
        response.headers.set("cache-control", "private, no-store");
        return response;
      }
    } catch {
      /* Invalid configuration never redirects to caller input. */
    }
    return failed;
  }
}
