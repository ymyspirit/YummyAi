import { authorize,ForbiddenError,intersectPermissionContexts,Permission } from "@yummyai/authz";
import { catalogContextAuthority } from "@yummyai/catalog-core";
import type { TenantContext } from "@yummyai/contracts";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import { loadCurrentMembershipContext,marketplaceAccounts,type TenantTransaction } from "@yummyai/database";
import { and,eq,isNull } from "drizzle-orm";

const operations = [Permission.CustomerIntelligenceRead, Permission.CustomerIntelligenceWrite,
  Permission.CustomerIntelligenceReview] as const;
export type AdvertisingOperation = (typeof operations)[number];

export async function currentAdvertisingAuthority(tx: TenantTransaction, ceiling: TenantContext) {
  return intersectPermissionContexts(ceiling, await loadCurrentMembershipContext(tx, ceiling, { lock: true }));
}

export function advertisingAccess(context: TenantContext, ownerId?: string | null) {
  const permitted = (operation: AdvertisingOperation) => {
    try {
      // Accounts have no trusted team binding. A team grant can therefore only
      // reach the actor's own account; a null owner requires tenant scope.
      authorize(context, operation, ownerId === undefined ? undefined : { ownerId, teamId: null });
      return true;
    } catch (error) {
      if (error instanceof ForbiddenError) return false;
      throw error;
    }
  };
  return { canRead: permitted(operations[0]), canWrite: permitted(operations[1]), canReview: permitted(operations[2]) };
}

export function requireAnyAdvertisingPermission(context: TenantContext) {
  if (!Object.values(advertisingAccess(context)).some(Boolean)) throw new ForbiddenError(operations[0]);
}

export async function requireAdvertisingAccount(tx: TenantTransaction, context: TenantContext,
  id: string, operation: AdvertisingOperation | null, includeDeleted = false) {
  const [row] = await tx.select().from(marketplaceAccounts).where(and(
    eq(marketplaceAccounts.id, id), eq(marketplaceAccounts.platform, "amazon"),
    includeDeleted ? undefined : isNull(marketplaceAccounts.deletedAt),
  )).for("share").limit(1);
  if (!row) throw new OriginalOwnerError(404, "Amazon 店铺不存在或不可访问");
  const access = advertisingAccess(context, row.createdBy);
  const allowed = operation === null ? Object.values(access).some(Boolean)
    : operation === operations[0] ? access.canRead : operation === operations[1] ? access.canWrite : access.canReview;
  if (!allowed) throw new OriginalOwnerError(404, "Amazon 店铺不存在或不可访问");
  return row;
}

export { catalogContextAuthority as advertisingContextAuthority };
