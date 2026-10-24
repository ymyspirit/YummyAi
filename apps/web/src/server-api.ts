import { factoryPortalOnly } from "./factory-portal-mode";
import { isolatedWebFixture, invalidWebAuthMode, localServiceAuth } from "./web-auth-mode";
import { PersonalSessionError } from "./identity/core";
import { getLocalApiHeaders, localApiFetch } from "./local-service-api";
import { erpAmbientIdentity, hasNextRequestContext } from "./erp-auth/request";
import { assertErpIdentityCurrent, erpAuthFailure } from "./erp-auth/server";
async function useLocalService() {
  if (invalidWebAuthMode()) throw new PersonalSessionError(503, "session_unavailable");
  if (isolatedWebFixture() && !(await hasNextRequestContext())) return true;
  if (factoryPortalOnly()) throw new PersonalSessionError(403, "erp_access_denied");
  return localServiceAuth();
}
export async function getApiHeaders(
  options: { forceRefresh?: boolean } = {},
): Promise<Record<string, string>> {
  if (await useLocalService()) return getLocalApiHeaders(options);
  const identity = await erpAmbientIdentity();
  return { authorization: `Bearer ${identity.token}` };
}
export async function apiFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  try {
    if (await useLocalService()) return localApiFetch(url, init);
    const identity = await erpAmbientIdentity(),
      target = new URL(url),
      base = new URL(identity.service.configuration.apiBase);
    if (
      target.origin !== base.origin ||
      !target.pathname.startsWith(base.pathname.replace(/\/$/, "") + "/v1/")
    )
      throw new PersonalSessionError(400, "login_invalid");
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${identity.token}`);
    const response = await fetch(target, {
      ...init,
      headers,
      cache: "no-store",
      redirect: "error",
    });
    try {
      await assertErpIdentityCurrent(identity);
      if (response.status === 401) {
        await identity.service.logout(identity.sessionId).catch(() => {});
        throw new PersonalSessionError(401, "login_required");
      }
      return response;
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }
  } catch (error) {
    if (error instanceof PersonalSessionError) return erpAuthFailure(error);
    throw error;
  }
}
