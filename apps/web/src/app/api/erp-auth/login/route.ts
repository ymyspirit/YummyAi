import { NextResponse } from "next/server";
import {
  erpIdentity,
  erpCookieNames,
  writeIdentityCookie,
  erpAuthFailure,
} from "../../../../erp-auth/server";
import { erpReturnPath } from "../../../../web-auth-mode";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some((key) => key !== "returnTo" || query.getAll(key).length !== 1))
      return Response.json({ message: "登录请求无效" }, { status: 400 });
    const service = erpIdentity(),
      flow = await service.start(erpReturnPath(query.get("returnTo"))),
      response = NextResponse.redirect(flow.url);
    writeIdentityCookie(
      response,
      service.configuration.origin,
      erpCookieNames(service.configuration.origin).flow,
      flow.flowId,
      600,
    );
    response.headers.set("cache-control", "private, no-store");
    return response;
  } catch (error) {
    return erpAuthFailure(error, request);
  }
}
