import {
  BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException,
  UnauthorizedException, UnprocessableEntityException,
} from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { MarketplaceAuthorizationModeSchema, MarketplaceCapabilitySnapshotViewSchema, MarketplacePlatformSchema,
  MarketplaceRegionSchema, createEntityId, type MarketplaceCapabilitySnapshotView,
  type SyncMarketplaceCapabilitiesInput, type TenantContext } from "@yummyai/contracts";
import { marketplaceAccounts, marketplaceCapabilitySnapshots, marketplaceStoreNodeBindings, type DatabaseConnection, type TenantTransaction, withTenant } from "@yummyai/database";
import { MarketplaceConnectorError, type CapabilitySyncAccountContext, type MarketplaceCapabilityGateway,
  type MarketplaceCapabilitySyncResult } from "@yummyai/marketplace-connectors";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, MARKETPLACE_CAPABILITY_GATEWAY, MARKETPLACE_SECRET_VAULT } from "../platform.tokens.js";
import { MarketplaceAuthorizationService } from "./marketplace-authorization.service.js";
import { currentMarketplaceAuthority, databaseNow, invalidateMarketplaceAuthorization, lockMarketplaceAccount,
  type MarketplaceAccountRow } from "./marketplace-authority.js";
import type { MarketplaceCredentialUse } from "./marketplace-authority-lease.js";

const CredentialEnvelopeSchema = z.record(z.string(), z.string());

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
    return withTenant(this.database.db, context, async (tx) => {
      const { account } = await lockMarketplaceAccount(tx, context, accountId, Permission.StoreRead);
      const [snapshot] = await tx.select().from(marketplaceCapabilitySnapshots)
        .where(eq(marketplaceCapabilitySnapshots.accountId, accountId)).orderBy(desc(marketplaceCapabilitySnapshots.version)).limit(1);
      if (!snapshot) throw new NotFoundException("Marketplace capability snapshot not found");
      return toView(snapshot, await databaseNow(tx), account.authorizationGeneration);
    });
  }

  async sync(context: TenantContext, accountId: string,
    input: SyncMarketplaceCapabilitiesInput): Promise<MarketplaceCapabilitySnapshotView> {
    await this.requireCentralPath(context, accountId);
    const lease = await this.authorization.claimCredentialUse(context, accountId);
    try {
      this.validateSyncRequest(lease.account, input);
      let result: MarketplaceCapabilitySyncResult;
      try {
        result = await this.secrets.withSecret(lease.encryptedEnvelope, (raw) =>
          this.gateway.sync(toGatewayContext(lease.account), CredentialEnvelopeSchema.parse(JSON.parse(raw)), input, {
            beforeCredentialRefresh: () => lease.beforeCredentialRefresh(),
            checkpointCredential: (credential, expiresAt) => lease.checkpointCredential(credential, expiresAt),
            beforeRead: () => lease.beforeRead(),
          }));
        this.validateIdentity(lease.account, result);
        if (result.refreshedCredential && !lease.checkpointed)
          throw new ConflictException({ code: "marketplace_credential_checkpoint_missing", message: "店铺刷新回执缺少持久检查点 请重新核对" });
        return await withTenant(this.database.db, lease.ceiling, tx => this.adoptNodeResult(lease, result, tx));
      } catch (error) {
        await this.recordFailure(lease, error);
        throw toHttpError(error);
      }
    } finally { await lease.release(); }
  }

  /** Original snapshot owner, reused by the durable node operation in its transaction. */
  async adoptNodeResult(lease: MarketplaceCredentialUse, result: MarketplaceCapabilitySyncResult, tx: TenantTransaction): Promise<MarketplaceCapabilitySnapshotView> {
    const accountId = lease.account.id, context = lease.ceiling;
    this.validateIdentity(lease.account, result);
          const { account, authority } = await lease.current(tx);
          const now = await databaseNow(tx);
          this.validateResult(account, result, now);
          const [latest] = await tx.select({ version: marketplaceCapabilitySnapshots.version }).from(marketplaceCapabilitySnapshots)
            .where(eq(marketplaceCapabilitySnapshots.accountId, accountId)).orderBy(desc(marketplaceCapabilitySnapshots.version)).limit(1);
          const [snapshot] = await tx.insert(marketplaceCapabilitySnapshots).values({
            id: createEntityId(), tenantId: context.tenantId, accountId, authorizationGeneration: lease.generation,
            version: (latest?.version ?? 0) + 1, platform: account.platform, externalAccountId: result.externalAccountId,
            marketplaceIds: [...result.marketplaceIds], capabilities: [...result.capabilities], sourceVersion: result.sourceVersion,
            sourceChecksum: result.sourceChecksum, data: result.data, syncedAt: result.syncedAt, expiresAt: result.expiresAt,
            createdBy: authority.userId,
          }).returning();
          await tx.update(marketplaceAccounts).set({
            externalAccountId: result.externalAccountId, marketplaceIds: [...result.marketplaceIds], capabilities: [...result.capabilities],
            healthStatus: result.healthStatus, lastHealthAt: result.syncedAt, lastCapabilitySyncAt: result.syncedAt,
            capabilityExpiresAt: result.expiresAt, lastErrorCode: result.issues.find((issue) => issue.severity === "blocker")?.code ?? null,
            status: result.healthStatus === "healthy" ? "active" : "degraded", updatedAt: now,
          }).where(eq(marketplaceAccounts.id, accountId));
          await lease.releaseInTransaction(tx);
          await this.audit.recordInTransaction(tx, authority, {
            action: "marketplace_capabilities.sync", resourceType: "marketplace_account", resourceId: accountId, result: "success",
            metadata: { capabilityCount: result.capabilities.length, credentialRotated: lease.checkpointed,
              issueCount: result.issues.length, snapshotVersion: snapshot!.version, sourceChecksum: result.sourceChecksum,
              authorizationGeneration: lease.generation },
          });
          return toView(snapshot!, now, lease.generation);
  }

  async snapshotInTransaction(tx: TenantTransaction, context: TenantContext, accountId: string, snapshotId: string): Promise<MarketplaceCapabilitySnapshotView> {
    const { account } = await lockMarketplaceAccount(tx, context, accountId, Permission.StoreRead);
    const rows = await tx.select().from(marketplaceCapabilitySnapshots).where(eq(marketplaceCapabilitySnapshots.id, snapshotId)).limit(1);
    const row = rows[0];
    if (!row || row.accountId !== accountId) throw new NotFoundException("Marketplace capability snapshot not found");
    return toView(row, await databaseNow(tx), account.authorizationGeneration);
  }

  private async requireCentralPath(context: TenantContext, accountId: string): Promise<void> {
    await withTenant(this.database.db, context, async tx => {
      await lockMarketplaceAccount(tx, context, accountId, Permission.StoreManage);
      const [binding] = await tx.select().from(marketplaceStoreNodeBindings).where(eq(marketplaceStoreNodeBindings.accountId, accountId)).limit(1);
      if (process.env.STORE_NODE_EXECUTION_ENABLED === "1" || binding?.nodeId)
        throw new ConflictException({ code: "store_node_execution_required", message: "请保存原节点同步任务 离线时不会改由中央直接执行" });
    });
  }

  private async recordFailure(lease: MarketplaceCredentialUse, error: unknown): Promise<void> {
    await withTenant(this.database.db, lease.ceiling, tx => this.recordNodeFailure(lease, error, tx));
  }

  async recordNodeFailure(lease: MarketplaceCredentialUse, error: unknown, tx: TenantTransaction): Promise<void> {
      await currentMarketplaceAuthority(tx, lease.ceiling, Permission.StoreManage, { createdBy: lease.ceiling.userId });
      const [account] = await tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, lease.account.id)).for("update").limit(1);
      if (!account || account.deletedAt || account.authorizationGeneration !== lease.generation || account.credentialUseId !== lease.useId) return;
      const { authority } = await lease.current(tx, true);
      const connectorError = error instanceof MarketplaceConnectorError ? error : null;
      const authorizationFailure = connectorError?.code === "authorization";
      const code = connectorError ? `CAPABILITY_${connectorError.code.toUpperCase()}` : "CAPABILITY_SYNC_FAILED";
      const now = await databaseNow(tx);
      await tx.update(marketplaceAccounts).set({
        ...(authorizationFailure ? { ...invalidateMarketplaceAuthorization(account), credentialStatus: "revoked" } : {}),
        healthStatus: authorizationFailure ? "unauthorized" : "degraded", lastHealthAt: now, lastErrorCode: code,
        status: authorizationFailure ? "revoked" : "degraded", updatedAt: now,
      }).where(eq(marketplaceAccounts.id, account.id));
      await lease.releaseInTransaction(tx);
      await this.audit.recordInTransaction(tx, authority, { action: "marketplace_capabilities.sync", resourceType: "marketplace_account",
        resourceId: account.id, result: "failure", metadata: { errorCode: code, retryable: connectorError?.retryable ?? false,
          authorizationGeneration: lease.generation } });
  }

  private validateSyncRequest(account: MarketplaceAccountRow, input: SyncMarketplaceCapabilitiesInput): void {
    if (account.status === "disabled" || account.status === "revoked")
      throw new ConflictException("Marketplace account cannot synchronize capabilities in its current state");
    if (account.credentialStatus !== "valid" && account.credentialStatus !== "expiring")
      throw new UnauthorizedException("Marketplace account is not authorized");
    if (account.platform === "amazon" && input.etsyTaxonomyNodeIds.length > 0)
      throw new BadRequestException("Etsy taxonomy nodes cannot be synchronized for Amazon accounts");
    if (account.platform === "etsy" && input.amazonProductTypes.length > 0)
      throw new BadRequestException("Amazon product types cannot be synchronized for Etsy accounts");
  }

  private validateIdentity(account: MarketplaceAccountRow, result: MarketplaceCapabilitySyncResult): void {
    if ((account.platform === "amazon" || account.lastCapabilitySyncAt !== null) && account.externalAccountId !== result.externalAccountId)
      throw new ConflictException("Marketplace identity does not match the authorized account");
  }

  private validateResult(account: MarketplaceAccountRow, result: MarketplaceCapabilitySyncResult, now: Date): void {
    const platform = MarketplacePlatformSchema.parse(account.platform);
    if (result.expiresAt.getTime() <= result.syncedAt.getTime() || result.expiresAt <= now)
      throw new MarketplaceConnectorError(platform, "validation", "Capability snapshot is already stale");
    if (result.marketplaceIds.length === 0)
      throw new MarketplaceConnectorError(platform, "validation", "Capability snapshot has no marketplace identity");
  }
}

type MarketplaceCapabilitySnapshotRow = typeof marketplaceCapabilitySnapshots.$inferSelect;
function toGatewayContext(account: MarketplaceAccountRow): CapabilitySyncAccountContext {
  return { authorizationMode: MarketplaceAuthorizationModeSchema.parse(account.authorizationMode), externalAccountId: account.externalAccountId,
    grantedScopes: account.grantedScopes, marketplaceIds: account.marketplaceIds,
    platform: MarketplacePlatformSchema.parse(account.platform), region: MarketplaceRegionSchema.parse(account.region) };
}
function toView(snapshot: MarketplaceCapabilitySnapshotRow, now: Date, generation: string): MarketplaceCapabilitySnapshotView {
  return MarketplaceCapabilitySnapshotViewSchema.parse({
    id: snapshot.id, accountId: snapshot.accountId, version: snapshot.version, platform: snapshot.platform,
    externalAccountId: snapshot.externalAccountId, marketplaceIds: snapshot.marketplaceIds, capabilities: snapshot.capabilities,
    sourceVersion: snapshot.sourceVersion, sourceChecksum: snapshot.sourceChecksum, data: snapshot.data,
    syncedAt: snapshot.syncedAt.toISOString(), expiresAt: snapshot.expiresAt.toISOString(),
    stale: snapshot.expiresAt <= now || snapshot.authorizationGeneration !== generation,
  });
}
function toHttpError(error: unknown): Error {
  if (error instanceof Error && "status" in error) return error;
  if (!(error instanceof MarketplaceConnectorError)) return new ServiceUnavailableException("Marketplace capability synchronization failed");
  if (error.code === "authorization") return new UnauthorizedException("Marketplace authorization is invalid or expired");
  if (error.code === "validation") return new UnprocessableEntityException("Marketplace rejected the capability request");
  if (error.code === "conflict") return new ConflictException("Marketplace capability state conflicts with the account");
  return new ServiceUnavailableException({ message: "Marketplace capability service is unavailable", retryAfterMs: error.retryAfterMs });
}
