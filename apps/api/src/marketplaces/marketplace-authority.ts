import { ConflictException, NotFoundException } from "@nestjs/common";
import { authorize, ForbiddenError, intersectPermissionContexts, permissionScope, type PermissionValue } from "@yummyai/authz";
import { createEntityId, MarketplaceAccountViewSchema, type TenantContext } from "@yummyai/contracts";
import { loadCurrentMembershipContext, marketplaceAccounts, type TenantTransaction } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";

export type MarketplaceAccountRow = typeof marketplaceAccounts.$inferSelect;

/** A request can lose authority while outside the database. It cannot gain it. */
export async function currentMarketplaceAuthority(tx: TenantTransaction, ceiling: TenantContext,
  permission: PermissionValue, account?: Pick<MarketplaceAccountRow, "createdBy">): Promise<TenantContext> {
  const authority = intersectPermissionContexts(ceiling, await loadCurrentMembershipContext(tx, ceiling, { lock: true }));
  authorize(authority, permission, account ? { ownerId: account.createdBy } : undefined);
  if (!account && permissionScope(authority, permission) !== "tenant")
    throw new ForbiddenError(permission, "outside_data_scope");
  return authority;
}

/** Every lifecycle writer uses this lock; no caller holds it during provider I/O. */
export async function lockMarketplaceAccount(tx: TenantTransaction, ceiling: TenantContext,
  accountId: string, permission: PermissionValue) {
  const authority = intersectPermissionContexts(ceiling, await loadCurrentMembershipContext(tx, ceiling, { lock: true }));
  authorize(authority, permission);
  const [account] = await tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, accountId)).for("update");
  if (!account || account.deletedAt) throw new NotFoundException("Marketplace account not found");
  authorize(authority, permission, { ownerId: account.createdBy });
  return { account, authority };
}

export async function databaseNow(tx: TenantTransaction): Promise<Date> {
  const [row] = await tx.execute<{ now: string | Date }>(sql`select clock_timestamp() as now`);
  return new Date(row!.now);
}

export function assertMarketplaceGeneration(account: MarketplaceAccountRow, generation: string) {
  if (account.authorizationGeneration !== generation)
    throw new ConflictException({ code: "marketplace_authority_changed", message: "店铺授权已变化 请重新读取当前状态" });
}

export function invalidateMarketplaceAuthorization(account: MarketplaceAccountRow) {
  return { authorizationGeneration: createEntityId(), credentialUseId: null, credentialUseStartedAt: null,
    credentialRefreshState: account.credentialRefreshState === "known" ? "known" as const : "unknown" as const };
}

export function marketplaceAccountView(row: MarketplaceAccountRow) {
  return MarketplaceAccountViewSchema.parse({ id: row.id, platform: row.platform, displayName: row.displayName,
    externalAccountId: row.externalAccountId, region: row.region, marketplaceIds: row.marketplaceIds,
    authorizationMode: row.authorizationMode, status: row.status, requestedScopes: row.requestedScopes,
    grantedScopes: row.grantedScopes, capabilities: row.capabilities, credentialStatus: row.credentialStatus,
    hasCredential: row.credentialStatus === "valid" || row.credentialStatus === "expiring", healthStatus: row.healthStatus,
    lastHealthAt: row.lastHealthAt?.toISOString() ?? null, lastCapabilitySyncAt: row.lastCapabilitySyncAt?.toISOString() ?? null,
    capabilityExpiresAt: row.capabilityExpiresAt?.toISOString() ?? null, quota: null, lastErrorCode: row.lastErrorCode,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
}
