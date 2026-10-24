import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { authorize, erpPermissionContext, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { MarketplaceAuthorityWorkspaceSchema } from "@yummyai/contracts/marketplace/authority";
import { marketplaceCredentials, marketplaceCapabilitySnapshots, marketplaceAuthorizationSessions, withTenant, type DatabaseConnection } from "@yummyai/database";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { databaseNow, lockMarketplaceAccount, marketplaceAccountView } from "./marketplace-authority.js";

@Injectable()
export class MarketplaceAuthorityWorkspaceService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}

  async get(context: TenantContext, accountId: string) {
    return withTenant(this.database.db, context, async tx => {
      const { account, authority } = await lockMarketplaceAccount(tx, context, accountId, Permission.StoreRead);
      const now = await databaseNow(tx);
      const [credential] = await tx.select({ version: marketplaceCredentials.version }).from(marketplaceCredentials)
        .where(eq(marketplaceCredentials.accountId, accountId));
      const [capability] = await tx.select({ generation: marketplaceCapabilitySnapshots.authorizationGeneration,
        expiresAt: marketplaceCapabilitySnapshots.expiresAt }).from(marketplaceCapabilitySnapshots)
        .where(eq(marketplaceCapabilitySnapshots.accountId, accountId)).orderBy(desc(marketplaceCapabilitySnapshots.version)).limit(1);
      const [pendingOAuth] = await tx.select({ digest: marketplaceAuthorizationSessions.stateDigest }).from(marketplaceAuthorizationSessions)
        .where(and(eq(marketplaceAuthorizationSessions.accountId, accountId), eq(marketplaceAuthorizationSessions.createdBy, authority.userId),
          eq(marketplaceAuthorizationSessions.authorizationGeneration, account.authorizationGeneration), isNull(marketplaceAuthorizationSessions.consumedAt),
          gt(marketplaceAuthorizationSessions.expiresAt, now))).limit(1);
      const can = (permission: Permission) => {
        try { authorize(authority, permission, { ownerId: account.createdBy }); return true; } catch { return false; }
      };
      const ready = !account.deletedAt && account.status !== "disabled" && account.status !== "revoked";
      const known = account.credentialRefreshState === "known";
      return MarketplaceAuthorityWorkspaceSchema.parse({ version: "erp-store-authority-v1", account: marketplaceAccountView(account),
        lifecycle: { authorizationGeneration: account.authorizationGeneration, credentialVersion: credential?.version ?? null,
          useState: !known ? "refresh_unknown" : account.credentialUseId ? "in_flight" : "idle", refreshState: account.credentialRefreshState,
          capabilityGeneration: capability?.generation ?? null, pendingOAuthStateDigest: pendingOAuth?.digest ?? null,
          capabilityCurrent: ready && known && Boolean(credential) && capability?.generation === account.authorizationGeneration && capability.expiresAt > now },
        access: { authorize: account.status !== "disabled" && can(Permission.StoreAuthorize), manage: can(Permission.StoreManage),
          sync: ready && known && !account.credentialUseId && Boolean(credential) && can(Permission.StoreManage) },
        context: { actorId: authority.userId, tenantId: authority.tenantId,
          authority: createHash("sha256").update(erpSessionAuthority(erpPermissionContext(authority))).digest("hex") }, observedAt: now.toISOString() });
    });
  }
}
