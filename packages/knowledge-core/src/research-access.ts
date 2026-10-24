import { authorize,ForbiddenError,permissionScope,type PermissionValue } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import {
loadCurrentMembershipContext,
researchItems,
type TenantTransaction,
} from "@yummyai/database";
import { eq,type SQLWrapper } from "drizzle-orm";

export function currentResearchAuthority(tx: TenantTransaction, context: TenantContext) {
  // Explicit non-membership credential adapters retain their supplied ceiling.
  // Membership contexts additionally recheck current grants in this transaction.
  return context.permissionScopes === undefined
    ? Promise.resolve(context)
    : loadCurrentMembershipContext(tx, context, { lock: true });
}

export function requireResearchResource(
  context: TenantContext,
  current: TenantContext,
  permission: PermissionValue,
  ownerId: string | null,
) {
  // Research has no trusted team binding. A team grant does not imply access to
  // another owner's record, and one permission never borrows another's scope.
  authorize(context, permission, { ownerId });
  authorize(current, permission, { ownerId });
}

export function canReadResearchResource(
  context: TenantContext,
  current: TenantContext,
  permission: PermissionValue,
  ownerId: string | null,
) {
  try {
    requireResearchResource(context, current, permission, ownerId);
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError) return false;
    throw error;
  }
}

export function researchOwnerFilter(
  context: TenantContext,
  current: TenantContext,
  permission: PermissionValue,
  owner: SQLWrapper = researchItems.ownerUserId,
) {
  authorize(context, permission);
  authorize(current, permission);
  return permissionScope(context, permission) === "tenant" &&
    permissionScope(current, permission) === "tenant"
    ? undefined
    : eq(owner, context.userId);
}
