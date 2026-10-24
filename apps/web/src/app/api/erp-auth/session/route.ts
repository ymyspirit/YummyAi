import { erpRequestIdentity, erpAuthFailure } from "../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../identity/core";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    if (new URL(request.url).search) throw new PersonalSessionError(400, "login_invalid");
    const identity = await erpRequestIdentity(request);
    return Response.json(identity.view, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return erpAuthFailure(error, request);
  }
}
