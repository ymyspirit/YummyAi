import { NextResponse, type NextRequest } from "next/server";
import { erpIdentity, erpRequestIdentity, erpAuthFailure } from "./server";
import { requireIdentityOrigin } from "../identity/http";
import { erpReturnPath } from "../web-auth-mode";
import { PersonalSessionError } from "../identity/core";
import { factoryPublicPath } from "../factory-portal-mode";
const publicPaths = new Set([
  "/login",
  "/api/erp-auth/login",
  "/api/erp-auth/callback",
  "/api/erp-auth/logout",
  "/api/erp-auth/session",
  "/favicon.ico",
]);
export function erpPublicPath(path: string) {
  return (
    publicPaths.has(path) ||
    (path.startsWith("/_next/static/") && factoryPublicPath(path)) ||
    (process.env.NODE_ENV === "development" && path === "/_next/webpack-hmr")
  );
}
function privateHeaders(response: NextResponse) {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set(
    "vary",
    [
      ...new Set([
        ...(response.headers.get("vary") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        "Cookie",
      ]),
    ].join(", "),
  );
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}
export async function erpPersonalProxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (erpPublicPath(path)) return NextResponse.next();
  if (path === "/v1" || path.startsWith("/v1/"))
    return privateHeaders(NextResponse.json({ message: "未找到此入口" }, { status: 404 }));
  try {
    const identity = await erpRequestIdentity(request);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method))
      requireIdentityOrigin(request, identity.service.configuration.origin);
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.set("x-yummyai-return-path", erpReturnPath(path + request.nextUrl.search));
    return privateHeaders(NextResponse.next({ request: { headers } }));
  } catch (error) {
    const failure = erpAuthFailure(error, request);
    if (!["GET", "HEAD"].includes(request.method) || path.startsWith("/api/"))
      return privateHeaders(failure);
    const code = error instanceof PersonalSessionError ? error.code : "session_unavailable";
    let origin = request.url;
    try {
      origin = erpIdentity().configuration.origin;
    } catch {
      /* A missing configuration only returns to the requested login page. */
    }
    const destination = new URL("/login", origin);
    destination.searchParams.set("returnTo", erpReturnPath(path + request.nextUrl.search));
    destination.searchParams.set("reason", code);
    const response = NextResponse.redirect(destination);
    for (const value of failure.headers.getSetCookie())
      response.headers.append("set-cookie", value);
    return privateHeaders(response);
  }
}
