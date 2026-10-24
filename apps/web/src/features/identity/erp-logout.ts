/** A successful header is not confirmation: consume the original acknowledgement
 * before navigation can abort its body. The caller has already cleared private UI. */
export async function confirmErpLogout(): Promise<void> {
  const response = await fetch("/api/erp-auth/logout", {
    method: "POST", cache: "no-store", signal: AbortSignal.timeout(15_000),
  });
  const acknowledgement: unknown = await response.json();
  if (!response.ok || !acknowledgement || typeof acknowledgement !== "object" || Array.isArray(acknowledgement)
    || !("signedOut" in acknowledgement) || acknowledgement.signedOut !== true) throw new Error("erp_logout_unconfirmed");
}
