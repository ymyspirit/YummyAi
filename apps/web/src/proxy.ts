import { type NextRequest, NextResponse } from "next/server";
import { factoryPortalOnly, factoryPublicPath } from "./factory-portal-mode";
import { localServiceAuth, localServiceRequest, invalidWebAuthMode } from "./web-auth-mode";
import { erpPersonalProxy, erpPublicPath } from "./erp-auth/proxy";
export function proxy(request: NextRequest) {
  if (!factoryPortalOnly()) {
    if (erpPublicPath(request.nextUrl.pathname)) return NextResponse.next();
    if (invalidWebAuthMode())
      return NextResponse.json(
        { message: "登录配置不可用" },
        { status: 503, headers: { "cache-control": "private, no-store" } },
      );
    if (localServiceAuth())
      return localServiceRequest(request)
        ? NextResponse.next()
        : NextResponse.json({ message: "本地开发入口不可公开访问" }, { status: 403 });
    return erpPersonalProxy(request);
  }
  const path = request.nextUrl.pathname;
  const response =
    path === "/"
      ? NextResponse.redirect(new URL("/factory-work-items", request.url))
      : factoryPublicPath(path)
        ? NextResponse.next()
        : NextResponse.json({ message: "未找到此入口" }, { status: 404 });
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  if (!path.startsWith("/_next/static/"))
    response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export const config = { matcher: ["/:path*"] };
