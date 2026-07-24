import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  MarketplaceAccountViewSchema,
  MarketplaceQuotaTelemetrySchema,
  createEntityId,
  type CreateMarketplaceAccountInput,
  type MarketplaceAccountView,
  type MarketplaceHealthStatus,
  type TenantContext,
  type UpdateMarketplaceAccountInput,
} from "@yummyai/contracts";
import { marketplaceAccounts, marketplaceQuotaSnapshots, type DatabaseConnection, withTenant } from "@yummyai/database";
import { and, desc, eq } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

@Injectable()
export class MarketplaceAccountService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(context: TenantContext): Promise<MarketplaceAccountView[]> {
    const [rows, quotaRows] = await withTenant(this.database.db, context, async (tx) => Promise.all([
      tx.select().from(marketplaceAccounts).orderBy(desc(marketplaceAccounts.updatedAt)),
      tx.selectDistinctOn([marketplaceQuotaSnapshots.accountId]).from(marketplaceQuotaSnapshots)
        .orderBy(marketplaceQuotaSnapshots.accountId, desc(marketplaceQuotaSnapshots.observedAt)),
    ]));
    return rows.map((row) => toView(row, latestQuota(quotaRows, row.id)));
  }

  async get(context: TenantContext, id: string): Promise<MarketplaceAccountView> {
    const [row] = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, id)).limit(1),
    );
    if (!row) throw new NotFoundException("Marketplace account not found");
    const [quota] = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(marketplaceQuotaSnapshots)
        .where(eq(marketplaceQuotaSnapshots.accountId, id))
        .orderBy(desc(marketplaceQuotaSnapshots.observedAt))
        .limit(1),
    );
    return toView(row, quota ? toQuota(quota) : null);
  }

  async create(context: TenantContext, input: CreateMarketplaceAccountInput): Promise<MarketplaceAccountView> {
    const [existing] = await withTenant(this.database.db, context, (tx) =>
      tx.select({ id: marketplaceAccounts.id }).from(marketplaceAccounts).where(and(
        eq(marketplaceAccounts.platform, input.platform),
        eq(marketplaceAccounts.displayName, input.displayName),
      )).limit(1),
    );
    if (existing) throw new ConflictException("Marketplace account name already exists for this platform");

    const id = createEntityId();
    const [created] = await withTenant(this.database.db, context, (tx) =>
      tx.insert(marketplaceAccounts).values({
        id,
        tenantId: context.tenantId,
        platform: input.platform,
        displayName: input.displayName,
        externalAccountId: input.externalAccountId ?? null,
        region: input.region,
        marketplaceIds: input.marketplaceIds,
        authorizationMode: input.authorizationMode,
        requestedScopes: input.requestedScopes,
        createdBy: context.userId,
      }).returning(),
    );
    await this.audit.record(context, {
      action: "marketplace_account.create",
      resourceType: "marketplace_account",
      resourceId: id,
      result: "success",
      metadata: { platform: input.platform, authorizationMode: input.authorizationMode, region: input.region },
    });
    return toView(created!);
  }

  async update(context: TenantContext, id: string, input: UpdateMarketplaceAccountInput): Promise<MarketplaceAccountView> {
    const current = await this.get(context, id);
    const nextStatus = input.enabled === false
      ? "disabled"
      : input.enabled === true && current.status === "disabled"
        ? "pending_authorization"
        : current.status;
    const [updated] = await withTenant(this.database.db, context, (tx) =>
      tx.update(marketplaceAccounts).set({
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.marketplaceIds === undefined ? {} : { marketplaceIds: input.marketplaceIds }),
        ...(input.requestedScopes === undefined ? {} : { requestedScopes: input.requestedScopes }),
        status: nextStatus,
        updatedAt: new Date(),
      }).where(eq(marketplaceAccounts.id, id)).returning(),
    );
    if (!updated) throw new NotFoundException("Marketplace account not found");
    await this.audit.record(context, {
      action: "marketplace_account.update",
      resourceType: "marketplace_account",
      resourceId: id,
      result: "success",
      metadata: { enabled: input.enabled, requestedScopeCount: input.requestedScopes?.length },
    });
    return toView(updated);
  }

  async recordHealth(
    context: TenantContext,
    id: string,
    healthStatus: Exclude<MarketplaceHealthStatus, "not_checked">,
    errorCode?: string,
  ): Promise<MarketplaceAccountView> {
    const current = await this.get(context, id);
    const status = current.status === "disabled"
      ? "disabled"
      : healthStatus === "unauthorized"
        ? "revoked"
        : healthStatus === "healthy" && current.credentialStatus === "valid"
          ? "active"
          : healthStatus === "healthy"
            ? "pending_authorization"
            : "degraded";
    const [updated] = await withTenant(this.database.db, context, (tx) =>
      tx.update(marketplaceAccounts).set({
        healthStatus,
        lastHealthAt: new Date(),
        lastErrorCode: errorCode ?? null,
        status,
        updatedAt: new Date(),
      }).where(eq(marketplaceAccounts.id, id)).returning(),
    );
    if (!updated) throw new NotFoundException("Marketplace account not found");
    return toView(updated);
  }
}

function toView(row: typeof marketplaceAccounts.$inferSelect, quota: MarketplaceAccountView["quota"] = null): MarketplaceAccountView {
  return MarketplaceAccountViewSchema.parse({
    id: row.id,
    platform: row.platform,
    displayName: row.displayName,
    externalAccountId: row.externalAccountId,
    region: row.region,
    marketplaceIds: row.marketplaceIds,
    authorizationMode: row.authorizationMode,
    status: row.status,
    requestedScopes: row.requestedScopes,
    grantedScopes: row.grantedScopes,
    capabilities: row.capabilities,
    credentialStatus: row.credentialStatus,
    hasCredential: row.credentialStatus === "valid" || row.credentialStatus === "expiring",
    healthStatus: row.healthStatus,
    lastHealthAt: row.lastHealthAt?.toISOString() ?? null,
    lastCapabilitySyncAt: row.lastCapabilitySyncAt?.toISOString() ?? null,
    capabilityExpiresAt: row.capabilityExpiresAt?.toISOString() ?? null,
    quota,
    lastErrorCode: row.lastErrorCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
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
