import { NextResponse } from "next/server";
import { factoryPortalOnly } from "../../../../factory-portal-mode";
import {
  factoryIdentity,
  factoryCookieNames,
  setFactoryCookie,
  factoryAuthFailure,
} from "../../../../factory-auth/server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!factoryPortalOnly()) return new Response(null, { status: 404 });
  try {
    if (new URL(request.url).search)
      return NextResponse.json({ message: "登录请求无效" }, { status: 400 });
    const service = factoryIdentity(),
      flow = await service.start(),
      response = NextResponse.redirect(flow.url);
    setFactoryCookie(
      response,
      service.configuration.origin,
      factoryCookieNames(service.configuration.origin).flow,
      flow.flowId,
      600,
    );
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return factoryAuthFailure(error, request);
  }
}
