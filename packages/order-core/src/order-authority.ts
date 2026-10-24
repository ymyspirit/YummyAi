import {
  ForbiddenError,
  requireTenantOrderPermissions,
  intersectPermissionContexts,
  type PermissionValue,
} from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import {
  loadCurrentMembershipContext,
  withTenant,
  type Database,
  type TenantTransaction,
} from "@yummyai/database";

export { requireTenantOrderPermissions } from "@yummyai/authz";

export function hasTenantOrderPermissions(
  context: TenantContext,
  required: readonly PermissionValue[],
) {
  try {
    requireTenantOrderPermissions(context, required);
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError) return false;
    throw error;
  }
}

export async function currentOrderAuthority(
  tx: TenantTransaction,
  input: TenantContext,
  required: readonly PermissionValue[],
  options: { lock?: boolean; requireMembership?: boolean } = {},
) {
  requireTenantOrderPermissions(input, required);
  // Explicit non-membership credential adapters retain their supplied ceiling.
  const current =
    input.permissionScopes !== undefined || options.requireMembership
      ? await loadCurrentMembershipContext(tx, input, { lock: options.lock ?? true })
      : input;
  requireTenantOrderPermissions(current, required);
  return intersectPermissionContexts(input, current);
}

/** Authorize inside the same tenant transaction that owns the read or write. */
export async function withOrderAuthority<T>(
  database: Database,
  input: TenantContext,
  required: readonly PermissionValue[],
  callback: (tx: TenantTransaction) => Promise<T>,
  options?: Parameters<typeof withTenant>[3],
) {
  requireTenantOrderPermissions(input, required);
  return withTenant(
    database,
    input,
    async (tx) => {
      await currentOrderAuthority(tx, input, required, {
        lock: options?.accessMode !== "read only",
      });
      return callback(tx);
    },
    options,
  );
}
