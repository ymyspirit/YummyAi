import { authorize, intersectPermissionContexts, type PermissionValue } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { loadCurrentMembershipContext, type TenantTransaction } from "@yummyai/database";

export async function currentAssetAuthority(
  tx: TenantTransaction,
  input: TenantContext,
  permission: PermissionValue,
) {
  authorize(input, permission);
  // Explicit non-membership credential adapters retain their supplied ceiling.
  const current = input.permissionScopes === undefined
    ? input
    : await loadCurrentMembershipContext(tx, input, { lock: true });
  const authority = intersectPermissionContexts(input, current);
  authorize(authority, permission);
  return authority;
}

export { requireAssetAuthority } from "@yummyai/authz";
