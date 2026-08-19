import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import {
  MarketplaceAuthorizationModeSchema,
  MarketplaceCapabilitySnapshotViewSchema,
  MarketplacePlatformSchema,
  MarketplaceRegionSchema,
  createEntityId,
  type MarketplaceCapabilitySnapshotView,
  type SyncMarketplaceCapabilitiesInput,
  type TenantContext,
} from "@yummyai/contracts";
import {
  marketplaceAccounts,
  marketplaceCapabilitySnapshots,
  marketplaceCredentials,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import {
  MarketplaceConnectorError,
  type CapabilitySyncAccountContext,
  type MarketplaceCapabilityGateway,
  type MarketplaceCapabilitySyncResult,
} from "@yummyai/marketplace-connectors";
import { desc, eq, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import {
  DATABASE_CONNECTION,
  MARKETPLACE_CAPABILITY_GATEWAY,
  MARKETPLACE_SECRET_VAULT,
} from "../platform.tokens.js";
import { MarketplaceAuthorizationService } from "./marketplace-authorization.service.js";

@Injectable()
export class MarketplaceCapabilityService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(MARKETPLACE_SECRET_VAULT) private readonly secrets: SecretVault,
    @Inject(MARKETPLACE_CAPABILITY_GATEWAY) private readonly gateway: MarketplaceCapabilityGateway,
    @Inject(MarketplaceAuthorizationService) private readonly authorization: MarketplaceAuthorizationService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async latest(context: TenantContext, accountId: string): Promise<MarketplaceCapabilitySnapshotView> {
    await this.loadAccount(context, accountId);
    const [snapshot] = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(marketplaceCapabilitySnapshots)
        .where(eq(marketplaceCapabilitySnapshots.accountId, accountId))
        .orderBy(desc(marketplaceCapabilitySnapshots.version))
        .limit(1),
    );
    if (!snapshot) throw new NotFoundException("Marketplace capability snapshot not found");
    return toView(snapshot);
  }

  async sync(
    context: TenantContext,
    accountId: string,
    input: SyncMarketplaceCapabilitiesInput,
  ): Promise<MarketplaceCapabilitySnapshotView> {
    const account = await this.loadAccount(context, accountId);
    this.validateSyncRequest(account, input);
    let result: MarketplaceCapabilitySyncResult;
    try {
      result = await this.authorization.withCredential(context, accountId, (credential) =>
        this.gateway.sync(toGatewayContext(account), credential, input),
      );
      this.validateResult(account, result);
      this.validateIdentity(account, result);
    } catch (error) {
      await this.recordFailure(context, account, error);
      throw toHttpError(error);
    }

    const snapshot = await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${accountId}, 0))`);
      const [latest] = await tx.select({ version: marketplaceCapabilitySnapshots.version })
        .from(marketplaceCapabilitySnapshots)
        .where(eq(marketplaceCapabilitySnapshots.accountId, accountId))
        .orderBy(desc(marketplaceCapabilitySnapshots.version))
        .limit(1);
      const version = (latest?.version ?? 0) + 1;
      const [created] = await tx.insert(marketplaceCapabilitySnapshots).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        accountId,
        version,
        platform: account.platform,
        externalAccountId: result.externalAccountId,
        marketplaceIds: [...result.marketplaceIds],
        capabilities: [...result.capabilities],
        sourceVersion: result.sourceVersion,
        sourceChecksum: result.sourceChecksum,
        data: result.data,
        syncedAt: result.syncedAt,
        expiresAt: result.expiresAt,
        createdBy: context.userId,
      }).returning();
      if (result.refreshedCredential) {
        const [stored] = await tx.select({ id: marketplaceCredentials.id, version: marketplaceCredentials.version })
          .from(marketplaceCredentials)
          .where(eq(marketplaceCredentials.accountId, accountId))
          .limit(1);
        if (!stored) throw new UnauthorizedException("Marketplace account is not authorized");
        await tx.update(marketplaceCredentials).set({
          encryptedEnvelope: this.secrets.encrypt(JSON.stringify(result.refreshedCredential)),
          version: stored.version + 1,
          expiresAt: result.refreshedCredentialExpiresAt ?? null,
          rotatedAt: result.syncedAt,
          updatedAt: result.syncedAt,
        }).where(eq(marketplaceCredentials.id, stored.id));
      }
      await tx.update(marketplaceAccounts).set({
        externalAccountId: result.externalAccountId,
        marketplaceIds: [...result.marketplaceIds],
        capabilities: [...result.capabilities],
        ...(result.refreshedCredential ? { credentialStatus: credentialStatus(result.refreshedCredentialExpiresAt) } : {}),
        healthStatus: result.healthStatus,
        lastHealthAt: result.syncedAt,
        lastCapabilitySyncAt: result.syncedAt,
        capabilityExpiresAt: result.expiresAt,
        lastErrorCode: result.issues.find((issue) => issue.severity === "blocker")?.code ?? null,
        status: result.healthStatus === "healthy" ? "active" : "degraded",
        updatedAt: result.syncedAt,
      }).where(eq(marketplaceAccounts.id, accountId));
      return created!;
    });
    await this.audit.record(context, {
      action: "marketplace_capabilities.sync",
      resourceType: "marketplace_account",
      resourceId: accountId,
      result: "success",
      metadata: {
        capabilityCount: result.capabilities.length,
        credentialRotated: Boolean(result.refreshedCredential),
        issueCount: result.issues.length,
        snapshotVersion: snapshot.version,
        sourceChecksum: result.sourceChecksum,
      },
    });
    return toView(snapshot);
  }

  private async recordFailure(context: TenantContext, account: MarketplaceAccountRow, error: unknown): Promise<void> {
    const connectorError = error instanceof MarketplaceConnectorError ? error : null;
    const authorizationFailure = connectorError?.code === "authorization";
    const code = connectorError ? `CAPABILITY_${connectorError.code.toUpperCase()}` : "CAPABILITY_SYNC_FAILED";
    await withTenant(this.database.db, context, (tx) =>
      tx.update(marketplaceAccounts).set({
        ...(authorizationFailure ? { credentialStatus: "revoked" } : {}),
        healthStatus: authorizationFailure ? "unauthorized" : "degraded",
        lastHealthAt: new Date(),
        lastErrorCode: code,
        status: account.status === "disabled" ? "disabled" : authorizationFailure ? "revoked" : "degraded",
        updatedAt: new Date(),
      }).where(eq(marketplaceAccounts.id, account.id)),
    );
    await this.audit.record(context, {
      action: "marketplace_capabilities.sync",
      resourceType: "marketplace_account",
      resourceId: account.id,
      result: "failure",
      metadata: { errorCode: code, retryable: connectorError?.retryable ?? false },
    });
  }

  private validateSyncRequest(account: MarketplaceAccountRow, input: SyncMarketplaceCapabilitiesInput): void {
    if (account.status === "disabled" || account.status === "revoked") {
      throw new ConflictException("Marketplace account cannot synchronize capabilities in its current state");
    }
    if (account.credentialStatus !== "valid" && account.credentialStatus !== "expiring") {
      throw new UnauthorizedException("Marketplace account is not authorized");
    }
    if (account.platform === "amazon" && input.etsyTaxonomyNodeIds.length > 0) {
      throw new BadRequestException("Etsy taxonomy nodes cannot be synchronized for Amazon accounts");
    }
    if (account.platform === "etsy" && input.amazonProductTypes.length > 0) {
      throw new BadRequestException("Amazon product types cannot be synchronized for Etsy accounts");
    }
  }

  private validateIdentity(account: MarketplaceAccountRow, result: MarketplaceCapabilitySyncResult): void {
    const identityAlreadyVerified = account.lastCapabilitySyncAt !== null;
    if ((account.platform === "amazon" || identityAlreadyVerified) && account.externalAccountId !== result.externalAccountId) {
      throw new ConflictException("Marketplace identity does not match the authorized account");
    }
  }

  private validateResult(account: MarketplaceAccountRow, result: MarketplaceCapabilitySyncResult): void {
    const platform = MarketplacePlatformSchema.parse(account.platform);
    if (result.expiresAt.getTime() <= result.syncedAt.getTime() || result.expiresAt.getTime() <= Date.now()) {
      throw new MarketplaceConnectorError(platform, "validation", "Capability snapshot is already stale");
    }
    if (result.marketplaceIds.length === 0) {
      throw new MarketplaceConnectorError(platform, "validation", "Capability snapshot has no marketplace identity");
    }
  }

  private async loadAccount(context: TenantContext, accountId: string): Promise<MarketplaceAccountRow> {
    const [account] = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, accountId)).limit(1),
    );
    if (!account) throw new NotFoundException("Marketplace account not found");
    return account;
  }
}

type MarketplaceAccountRow = typeof marketplaceAccounts.$inferSelect;
type MarketplaceCapabilitySnapshotRow = typeof marketplaceCapabilitySnapshots.$inferSelect;

function toGatewayContext(account: MarketplaceAccountRow): CapabilitySyncAccountContext {
  return {
    authorizationMode: MarketplaceAuthorizationModeSchema.parse(account.authorizationMode),
    externalAccountId: account.externalAccountId,
    grantedScopes: account.grantedScopes,
    marketplaceIds: account.marketplaceIds,
    platform: MarketplacePlatformSchema.parse(account.platform),
    region: MarketplaceRegionSchema.parse(account.region),
  };
}

function toView(snapshot: MarketplaceCapabilitySnapshotRow): MarketplaceCapabilitySnapshotView {
  return MarketplaceCapabilitySnapshotViewSchema.parse({
    id: snapshot.id,
    accountId: snapshot.accountId,
    version: snapshot.version,
    platform: snapshot.platform,
    externalAccountId: snapshot.externalAccountId,
    marketplaceIds: snapshot.marketplaceIds,
    capabilities: snapshot.capabilities,
    sourceVersion: snapshot.sourceVersion,
    sourceChecksum: snapshot.sourceChecksum,
    data: snapshot.data,
    syncedAt: snapshot.syncedAt.toISOString(),
    expiresAt: snapshot.expiresAt.toISOString(),
    stale: snapshot.expiresAt.getTime() <= Date.now(),
  });
}

function credentialStatus(expiresAt: Date | undefined): "valid" | "expiring" {
  if (!expiresAt) return "valid";
  return expiresAt.getTime() - Date.now() <= 14 * 24 * 60 * 60 * 1_000 ? "expiring" : "valid";
}

function toHttpError(error: unknown): Error {
  if (error instanceof ConflictException) return error;
  if (!(error instanceof MarketplaceConnectorError)) return new ServiceUnavailableException("Marketplace capability synchronization failed");
  if (error.code === "authorization") return new UnauthorizedException("Marketplace authorization is invalid or expired");
  if (error.code === "validation") return new UnprocessableEntityException("Marketplace rejected the capability request");
  if (error.code === "conflict") return new ConflictException("Marketplace capability state conflicts with the account");
  return new ServiceUnavailableException({
    message: "Marketplace capability service is unavailable",
    retryAfterMs: error.retryAfterMs,
  });
}
