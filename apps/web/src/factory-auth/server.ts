import {NextResponse} from "next/server";
import {factoryPortalOnly} from "../factory-portal-mode";
import {FactoryAuthError} from "./core";
import {personalIdentity} from "../identity/services";
import {identityCookieNames,readIdentityCookie as factoryCookie,writeIdentityCookie as setFactoryCookie,requireIdentityOrigin as factoryWriteOrigin} from "../identity/http";
export {factoryCookie,setFactoryCookie,factoryWriteOrigin};
export const factoryCookieNames=(origin:string)=>identityCookieNames("factory",origin);
export function factoryIdentity(){if(!factoryPortalOnly())throw new FactoryAuthError(503,"session_unavailable");return personalIdentity("factory");}
export function factoryAuthFailure(error: unknown, request?: Request) {
  const known =
      error instanceof FactoryAuthError ? error : new FactoryAuthError(503, "session_unavailable"),
    message =
      known.status === 401
        ? "请登录已开通的工厂协作账户"
        : known.status === 400
          ? "登录或请求未完成 请重新核对"
          : "协作登录服务暂时不可用 请稍后重试";
  const response = NextResponse.json(
    { message, code: known.code },
    { status: known.status, headers: { "Cache-Control": "private, no-store" } },
  );
  if (known.status === 401 && request) {
    try {
      const service = factoryIdentity(),
        origin = service.configuration.origin;
      setFactoryCookie(response, origin, factoryCookieNames(origin).session, "", 0);
    } catch {
      /* Configuration failure never selects the internal identity. */
    }
  }
  return response;
}
export async function factoryUserFetch(request: Request, path: string, init: RequestInit = {}) {
  const service = factoryIdentity(),
    sessionId = factoryCookie(request, factoryCookieNames(service.configuration.origin).session),
    token = await service.token(sessionId),
    headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  const deadline = AbortSignal.timeout(path.endsWith("/file") ? 65000 : 20000),
    signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const response = await fetch(`${service.configuration.apiBase}/v1/factory-portal/${path}`, {
    ...init,
    headers,
    cache: "no-store",
    redirect: "error",
    signal,
  });
  try {
    await service.assertLiveSession(sessionId);
    if (response.status === 401) {
      await service.logout(sessionId).catch(() => {});
      throw new FactoryAuthError(401, "login_required");
    }
    return response;
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }
}
