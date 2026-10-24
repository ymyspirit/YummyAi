import { createHash } from "node:crypto";
import { NextResponse } from "next/server.js";
import {
  ErpSessionViewSchema,
  erpSessionAuthority,
  type ErpSessionView,
} from "@yummyai/contracts/auth/session";
import { PersonalSessionError, readIdentityJson } from "../identity/core";
import { personalIdentity } from "../identity/services";
import { identityCookieNames, readIdentityCookie, writeIdentityCookie } from "../identity/http";
import { factoryPortalOnly } from "../factory-portal-mode";
import { invalidWebAuthMode, localServiceAuth } from "../web-auth-mode";
export { identityCookieNames, readIdentityCookie, writeIdentityCookie };
export function erpIdentity() {
  if (factoryPortalOnly() || localServiceAuth() || invalidWebAuthMode())
    throw new PersonalSessionError(503, "session_unavailable");
  return personalIdentity("erp");
}
export const erpCookieNames = (origin: string) => identityCookieNames("erp", origin);
export function erpAuthority(view: ErpSessionView) {
  return createHash("sha256").update(erpSessionAuthority(view)).digest("hex");
}
export async function readErpSession(token: string) {
  const service = erpIdentity();
  let response: Response;
  try {
    response = await fetch(`${service.configuration.apiBase}/v1/identity/session`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new PersonalSessionError(503, "session_unavailable");
  }
  if ([401, 403].includes(response.status)) throw new PersonalSessionError(401, "login_required");
  if (!response.ok) throw new PersonalSessionError(503, "session_unavailable");
  const parsed = ErpSessionViewSchema.safeParse(await readIdentityJson(response, 65536));
  if (!parsed.success) throw new PersonalSessionError(503, "session_unavailable");
  if (!parsed.data.canUseErp) throw new PersonalSessionError(403, "erp_access_denied");
  return parsed.data;
}
export async function erpRequestIdentity(request: Request) {
  const service = erpIdentity(),
    sessionId = readIdentityCookie(request, erpCookieNames(service.configuration.origin).session),
    token = await service.token(sessionId);
  try {
    const view = await readErpSession(token);
    await service.assertLiveSession(sessionId);
    return { service, sessionId, token, view, authority: erpAuthority(view) };
  } catch (error) {
    if (error instanceof PersonalSessionError && [401, 403].includes(error.status)) {
      try {
        await service.logout(sessionId);
      } catch {
        throw new PersonalSessionError(503, "session_unavailable");
      }
    }
    throw error;
  }
}
export type ErpRequestIdentity = Awaited<ReturnType<typeof erpRequestIdentity>>;
export async function assertErpIdentityCurrent(identity: ErpRequestIdentity) {
  const view = await readErpSession(identity.token);
  await identity.service.assertLiveSession(identity.sessionId);
  if (erpAuthority(view) !== identity.authority)
    throw new PersonalSessionError(409, "authority_changed");
}
export function erpAuthFailure(error: unknown, request?: Request) {
  const known =
      error instanceof PersonalSessionError
        ? error
        : new PersonalSessionError(503, "session_unavailable"),
    message =
      known.status === 401
        ? "请登录自己的运营账户"
        : known.status === 403
          ? "当前账户尚无运营工作台权限 请联系管理员"
          : known.status === 409
          ? "当前权限或资料范围已变化 请重新核对原操作结果后再继续"
            : known.status === 400
              ? "登录或请求未完成 请重新核对"
              : "登录服务暂时不可用 请稍后重试";
  const response = NextResponse.json(
    { message, code: known.code },
    { status: known.status, headers: { "cache-control": "private, no-store" } },
  );
  if (request && [401, 403].includes(known.status)) {
    try {
      const service = erpIdentity();
      writeIdentityCookie(
        response,
        service.configuration.origin,
        erpCookieNames(service.configuration.origin).session,
        "",
        0,
      );
    } catch {
      /* Never select the service identity after a personal-session failure. */
    }
  }
  return response;
}
