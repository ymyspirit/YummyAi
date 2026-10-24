import { redirect } from "next/navigation";
import { ErpLogin } from "../../features/identity/erp-login";
import { erpReturnPath, localServiceAuth } from "../../web-auth-mode";
import { erpIdentity } from "../../erp-auth/server";
import { factoryPortalOnly } from "../../factory-portal-mode";
export const dynamic = "force-dynamic";
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string; reason?: string }>;
}) {
  if (factoryPortalOnly()) redirect("/factory-work-items");
  if (localServiceAuth()) redirect("/");
  const query = await searchParams;
  let configured = true;
  try {
    erpIdentity();
  } catch {
    configured = false;
  }
  return (
    <ErpLogin
      returnTo={erpReturnPath(query.returnTo)}
      reason={typeof query.reason === "string" ? query.reason : ""}
      configured={configured}
    />
  );
}
