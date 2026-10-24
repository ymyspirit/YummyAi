import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  MarketplaceAccountRemovalViewSchema,
  MarketplaceQuotaTelemetrySchema,
  createEntityId,
  type CreateMarketplaceAccountInput,
  type MarketplaceAccountView,
  type MarketplaceAccountRemovalView,
  type MarketplaceHealthStatus,
  type TenantContext,
  type UpdateMarketplaceAccountInput,
} from "@yummyai/contracts";
import { marketplaceAccounts, marketplaceAuthorizationSessions, marketplaceCapabilitySnapshots, marketplaceQuotaSnapshots, type DatabaseConnection, withTenant } from "@yummyai/database";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { permissionScope, Permission } from "@yummyai/authz";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { assertMarketplaceGeneration, currentMarketplaceAuthority, databaseNow, invalidateMarketplaceAuthorization,
  lockMarketplaceAccount, marketplaceAccountView } from "./marketplace-authority.js";

@Injectable()
export class MarketplaceAccountService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(context: TenantContext): Promise<MarketplaceAccountView[]> {
    return withTenant(this.database.db, context, async (tx) => {
      const authority = await currentMarketplaceAuthority(tx, context, Permission.StoreRead, { createdBy: context.userId });
      const [rows, quotaRows] = await Promise.all([
        tx.select().from(marketplaceAccounts).where(and(isNull(marketplaceAccounts.deletedAt),
          permissionScope(authority, Permission.StoreRead) === "tenant" ? undefined : eq(marketplaceAccounts.createdBy, authority.userId)))
          .orderBy(desc(marketplaceAccounts.updatedAt)),
        tx.selectDistinctOn([marketplaceQuotaSnapshots.accountId]).from(marketplaceQuotaSnapshots)
          .orderBy(marketplaceQuotaSnapshots.accountId, desc(marketplaceQuotaSnapshots.observedAt)),
      ]);
      return rows.map((row) => ({ ...marketplaceAccountView(row), quota: latestQuota(quotaRows, row.id) }));
    });
  }

  async get(context: TenantContext, id: string): Promise<MarketplaceAccountView> {
    return withTenant(this.database.db, context, async (tx) => {
      const { account } = await lockMarketplaceAccount(tx, context, id, Permission.StoreRead);
      const [quota] = await tx.select().from(marketplaceQuotaSnapshots)
        .where(eq(marketplaceQuotaSnapshots.accountId, id))
        .orderBy(desc(marketplaceQuotaSnapshots.observedAt))
        .limit(1);
      return { ...marketplaceAccountView(account), quota: quota ? toQuota(quota) : null };
    });
  }

  async create(context: TenantContext, input: CreateMarketplaceAccountInput): Promise<MarketplaceAccountView> {
    return withTenant(this.database.db, context, async (tx) => {
      const authority = await currentMarketplaceAuthority(tx, context, Permission.StoreManage, { createdBy: context.userId });
      const [existing] = await tx.select({ id: marketplaceAccounts.id }).from(marketplaceAccounts).where(and(
        eq(marketplaceAccounts.platform, input.platform),
        eq(marketplaceAccounts.displayName, input.displayName),
      )).limit(1);
      if (existing) throw new ConflictException("Marketplace account name already exists for this platform");
      const id = createEntityId();
      const [created] = await tx.insert(marketplaceAccounts).values({
        id,
        tenantId: context.tenantId,
        platform: input.platform,
        displayName: input.displayName,
        externalAccountId: input.externalAccountId ?? null,
        region: input.region,
        marketplaceIds: input.marketplaceIds,
        authorizationMode: input.authorizationMode,
        requestedScopes: input.requestedScopes,
        createdBy: authority.userId,
      }).returning();
      await this.audit.recordInTransaction(tx, authority, {
      action: "marketplace_account.create",
      resourceType: "marketplace_account",
      resourceId: id,
      result: "success",
      metadata: { platform: input.platform, authorizationMode: input.authorizationMode, region: input.region },
      });
      return marketplaceAccountView(created!);
    });
  }

  async remove(context: TenantContext, id: string): Promise<MarketplaceAccountRemovalView> {
    return withTenant(this.database.db, context, async (tx) => {
      await currentMarketplaceAuthority(tx, context, Permission.StoreManage, { createdBy: context.userId });
      const [current] = await tx.select().from(marketplaceAccounts)
        .where(eq(marketplaceAccounts.id, id)).for("update").limit(1);
      if (!current) throw new NotFoundException("Marketplace account not found");
      const authority = await currentMarketplaceAuthority(tx, context, Permission.StoreManage, current);
      if (current.deletedAt) return MarketplaceAccountRemovalViewSchema.parse({ id, deletedAt: current.deletedAt.toISOString() });
      const deletedAt = await databaseNow(tx);
      const invalidation = invalidateMarketplaceAuthorization(current);
      await tx.update(marketplaceAccounts).set({ ...invalidation, status: "disabled", deletedAt, updatedAt: deletedAt })
        .where(eq(marketplaceAccounts.id, id));
      await tx.update(marketplaceAuthorizationSessions).set({ consumedAt: deletedAt, failureCode: "account_removed" })
        .where(and(eq(marketplaceAuthorizationSessions.accountId, id), isNull(marketplaceAuthorizationSessions.consumedAt)));
      await this.audit.recordInTransaction(tx, authority, {
        action: "marketplace_account.remove",
        resourceType: "marketplace_account",
        resourceId: id,
        result: "success",
        metadata: { platform: current.platform, historicalReferencesPreserved: true, authorizationGeneration: invalidation.authorizationGeneration },
      });
      return MarketplaceAccountRemovalViewSchema.parse({ id, deletedAt: deletedAt.toISOString() });
    });
  }

  async update(context: TenantContext, id: string, input: UpdateMarketplaceAccountInput): Promise<MarketplaceAccountView> {
    return withTenant(this.database.db, context, async (tx) => {
    const { account: current, authority } = await lockMarketplaceAccount(tx, context, id, Permission.StoreManage);
    if (input.displayName !== undefined && input.displayName !== current.displayName) {
      const [duplicate] = await tx.select({ id: marketplaceAccounts.id }).from(marketplaceAccounts)
        .where(and(eq(marketplaceAccounts.platform, current.platform), eq(marketplaceAccounts.displayName, input.displayName), ne(marketplaceAccounts.id, id))).limit(1);
      if (duplicate) throw new ConflictException("Marketplace account name already exists for this platform");
    }
    if (input.authorizationMode !== undefined) {
      if ((current.credentialStatus === "valid" || current.credentialStatus === "expiring") && input.authorizationMode !== current.authorizationMode)
        throw new ConflictException("Revoke authorization before changing its mode");
      if ((current.platform === "amazon") !== input.authorizationMode.startsWith("amazon_")) throw new ConflictException("Authorization mode must match platform");
    }
    const configChanged = (input.authorizationMode !== undefined && input.authorizationMode !== current.authorizationMode)
      || (input.marketplaceIds !== undefined && JSON.stringify(input.marketplaceIds) !== JSON.stringify(current.marketplaceIds))
      || (input.requestedScopes !== undefined && JSON.stringify(input.requestedScopes) !== JSON.stringify(current.requestedScopes));
    const nextStatus = input.enabled === false
      ? "disabled"
      : input.enabled === true && current.status === "disabled"
        ? "pending_authorization"
        : configChanged && current.status !== "disabled" && current.status !== "revoked" ? "pending_authorization" : current.status;
    const now = await databaseNow(tx);
    const invalidation = invalidateMarketplaceAuthorization(current);
    const [updated] = await tx.update(marketplaceAccounts).set({
        ...invalidation,
        ...(input.authorizationMode === undefined ? {} : { authorizationMode: input.authorizationMode }),
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.marketplaceIds === undefined ? {} : { marketplaceIds: input.marketplaceIds }),
        ...(input.requestedScopes === undefined ? {} : { requestedScopes: input.requestedScopes }),
        ...(configChanged ? { capabilities: [], capabilityExpiresAt: null } : {}),
        status: nextStatus,
        updatedAt: now,
      }).where(and(eq(marketplaceAccounts.id, id), isNull(marketplaceAccounts.deletedAt))).returning();
    if (!updated) throw new NotFoundException("Marketplace account not found");
    await tx.update(marketplaceAuthorizationSessions).set({ consumedAt: now, failureCode: "account_changed" })
      .where(and(eq(marketplaceAuthorizationSessions.accountId, id), isNull(marketplaceAuthorizationSessions.consumedAt)));
    await this.audit.recordInTransaction(tx, authority, {
      action: "marketplace_account.update",
      resourceType: "marketplace_account",
      resourceId: id,
      result: "success",
      metadata: { enabled: input.enabled, requestedScopeCount: input.requestedScopes?.length, authorizationGeneration: invalidation.authorizationGeneration },
    });
    return marketplaceAccountView(updated);
    });
  }

  async recordHealth(
    context: TenantContext,
    id: string,
    healthStatus: Exclude<MarketplaceHealthStatus, "not_checked">,
    errorCode?: string,
    expectedGeneration?: string,
  ): Promise<MarketplaceAccountView> {
    return withTenant(this.database.db, context, async (tx) => {
    const { account: current, authority } = await lockMarketplaceAccount(tx, context, id, Permission.StoreManage);
    if (expectedGeneration !== undefined) assertMarketplaceGeneration(current, expectedGeneration);
    const now = await databaseNow(tx);
    const [capability] = await tx.select({ generation: marketplaceCapabilitySnapshots.authorizationGeneration, expiresAt: marketplaceCapabilitySnapshots.expiresAt })
      .from(marketplaceCapabilitySnapshots).where(eq(marketplaceCapabilitySnapshots.accountId, id))
      .orderBy(desc(marketplaceCapabilitySnapshots.version)).limit(1);
    const currentCapability = capability?.generation === current.authorizationGeneration && capability.expiresAt > now
      && current.capabilityExpiresAt !== null && current.capabilityExpiresAt > now;
    const status = current.status === "disabled" || current.status === "revoked"
      ? current.status
      : healthStatus === "unauthorized"
        ? "revoked"
        : healthStatus === "healthy" && (current.credentialStatus === "valid" || current.credentialStatus === "expiring")
          && current.credentialRefreshState === "known" && !current.credentialUseId && currentCapability
          ? "active"
          : healthStatus === "healthy"
            ? "pending_authorization"
            : "degraded";
    const [updated] = await tx.update(marketplaceAccounts).set({
        ...(healthStatus === "unauthorized" ? { ...invalidateMarketplaceAuthorization(current), credentialStatus: "revoked" } : {}),
        healthStatus,
        lastHealthAt: now,
        lastErrorCode: errorCode ?? null,
        status,
        updatedAt: now,
      }).where(and(eq(marketplaceAccounts.id, id), isNull(marketplaceAccounts.deletedAt))).returning();
    if (!updated) throw new NotFoundException("Marketplace account not found");
    if (healthStatus === "unauthorized") await tx.update(marketplaceAuthorizationSessions).set({ consumedAt: now, failureCode: "unauthorized" })
      .where(and(eq(marketplaceAuthorizationSessions.accountId, id), isNull(marketplaceAuthorizationSessions.consumedAt)));
    await this.audit.recordInTransaction(tx, authority, { action: "marketplace_account.health", resourceType: "marketplace_account",
      resourceId: id, result: "success", metadata: { healthStatus, authorizationGeneration: updated.authorizationGeneration } });
    return marketplaceAccountView(updated);
    });
  }
}

function latestQuota(
  rows: Array<typeof marketplaceQuotaSnapshots.$inferSelect>,
  accountId: string,
): MarketplaceAccountView["quota"] {
  const row = rows.find((candidate) => candidate.accountId === accountId);
  return row ? toQuota(row) : null;
}

function toQuota(row: typeof marketplaceQuotaSnapshots.$inferSelect): MarketplaceAccountView["quota"] {
  return MarketplaceQuotaTelemetrySchema.parse({
    platform: row.platform,
    windows: row.windows,
    observedAt: row.observedAt.toISOString(),
  });
}
