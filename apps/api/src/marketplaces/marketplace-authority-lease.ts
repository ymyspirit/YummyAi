import { ConflictException, UnauthorizedException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { Permission, type PermissionValue } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { marketplaceAccounts, marketplaceCredentials, type DatabaseConnection, type TenantTransaction, withTenant } from "@yummyai/database";
import { eq } from "drizzle-orm";

import type { AuditService } from "../audit/audit.service.js";
import { assertMarketplaceGeneration, databaseNow, lockMarketplaceAccount, type MarketplaceAccountRow } from "./marketplace-authority.js";

export const MARKETPLACE_KNOWN_LEASE_TTL_MS = 300_000;

/** An unknown refresh is never made retryable by expiration of a local lease. */
export class MarketplaceCredentialUse {
  checkpointed = false;
  private constructor(
    private readonly database: DatabaseConnection,
    private readonly secrets: SecretVault,
    private readonly audit: AuditService,
    readonly ceiling: TenantContext,
    readonly account: MarketplaceAccountRow,
    readonly authority: TenantContext,
    readonly generation: string,
    readonly useId: string,
    readonly credentialId: string,
    public credentialVersion: number,
    public encryptedEnvelope: string,
    readonly permission: PermissionValue,
  ) {}

  static async claim(database: DatabaseConnection, secrets: SecretVault, audit: AuditService,
    ceiling: TenantContext, accountId: string, permission: PermissionValue = Permission.StoreManage): Promise<MarketplaceCredentialUse> {
    return withTenant(database.db, ceiling, tx => this.claimInTransaction(database, secrets, audit, ceiling, accountId, tx, permission));
  }

  /** A durable node claim and the original credential lease are born together. */
  static async claimInTransaction(database: DatabaseConnection, secrets: SecretVault, audit: AuditService,
    ceiling: TenantContext, accountId: string, tx: TenantTransaction, permission: PermissionValue = Permission.StoreManage): Promise<MarketplaceCredentialUse> {
      const { account, authority } = await lockMarketplaceAccount(tx, ceiling, accountId, permission);
      requireUsableAccount(account);
      const now = await databaseNow(tx);
      if (account.credentialRefreshState !== "known") throw refreshUncertain();
      if (account.credentialUseId && account.credentialUseStartedAt
        && now.getTime() - account.credentialUseStartedAt.getTime() < MARKETPLACE_KNOWN_LEASE_TTL_MS) throw credentialBusy();
      const [credential] = await tx.select().from(marketplaceCredentials)
        .where(eq(marketplaceCredentials.accountId, account.id)).for("update").limit(1);
      if (!credential || (credential.expiresAt && credential.expiresAt <= now)) throw new UnauthorizedException("Marketplace account is not authorized");
      const useId = createEntityId();
      await tx.update(marketplaceAccounts).set({ credentialUseId: useId, credentialUseStartedAt: now })
        .where(eq(marketplaceAccounts.id, account.id));
      await audit.recordInTransaction(tx, authority, { action: "marketplace_credential.use.start", resourceType: "marketplace_account",
        resourceId: account.id, result: "success", metadata: { authorizationGeneration: account.authorizationGeneration, useId, credentialVersion: credential.version } });
      return new MarketplaceCredentialUse(database, secrets, audit, ceiling, account, authority,
        account.authorizationGeneration, useId, credential.id, credential.version, credential.encryptedEnvelope, permission);
  }

  /** Server-only reconstruction of an existing use, never a new refresh grant. */
  static async resumeInTransaction(database: DatabaseConnection, secrets: SecretVault, audit: AuditService, ceiling: TenantContext,
    accountId: string, pins: { generation: string; useId: string; credentialId: string; credentialVersion: number; checkpointed: boolean },
    tx: TenantTransaction, permission: PermissionValue = Permission.StoreManage): Promise<MarketplaceCredentialUse> {
    const [account] = await tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, accountId)).for("update").limit(1);
    if (!account || account.deletedAt) throw authorityChanged();
    const [credential] = await tx.select().from(marketplaceCredentials).where(eq(marketplaceCredentials.accountId, accountId)).for("update").limit(1);
    if (!credential || credential.id !== pins.credentialId || credential.version !== pins.credentialVersion || account.authorizationGeneration !== pins.generation
      || account.credentialUseId !== pins.useId) throw authorityChanged();
    requireUsableAccount(account);
    const lease = new MarketplaceCredentialUse(database, secrets, audit, ceiling, account, ceiling, pins.generation,
      pins.useId, credential.id, credential.version, credential.encryptedEnvelope, permission);
    lease.checkpointed = pins.checkpointed;
    return lease;
  }

  /** Current membership is required before every new upstream request or adoption. */
  async current(tx: TenantTransaction, allowPending = false) {
    const current = await lockMarketplaceAccount(tx, this.ceiling, this.account.id, this.permission);
    await this.assertPinned(tx, current.account, allowPending);
    return current;
  }

  async beforeRead(): Promise<void> {
    await withTenant(this.database.db, this.ceiling, async (tx) => { await this.current(tx); });
  }

  async beforeCredentialRefresh(): Promise<void> {
    await withTenant(this.database.db, this.ceiling, tx => this.beforeCredentialRefreshInTransaction(tx));
  }

  async beforeCredentialRefreshInTransaction(tx: TenantTransaction): Promise<void> {
      const { authority } = await this.current(tx);
      await tx.update(marketplaceAccounts).set({ credentialRefreshState: "pending" })
        .where(eq(marketplaceAccounts.id, this.account.id));
      await this.audit.recordInTransaction(tx, authority, { action: "marketplace_credential.refresh.start", resourceType: "marketplace_account",
        resourceId: this.account.id, result: "success", metadata: { authorizationGeneration: this.generation, useId: this.useId, credentialVersion: this.credentialVersion } });
  }

  /** Saving the one returned refresh token is not permission to perform another request. */
  async checkpointCredential(credential: Readonly<Record<string, string>>, expiresAt: Date): Promise<void> {
    const stored = await withTenant(this.database.db, this.ceiling, tx => this.checkpointCredentialInTransaction(tx, credential, expiresAt));
    this.credentialVersion = stored.version;
    this.encryptedEnvelope = stored.encryptedEnvelope;
    this.checkpointed = true;
  }

  /** Caller may atomically save the original distributed checkpoint receipt. */
  async checkpointCredentialInTransaction(tx: TenantTransaction, credential: Readonly<Record<string, string>>, expiresAt: Date): Promise<{ version: number; encryptedEnvelope: string }> {
    const encryptedEnvelope = this.secrets.encrypt(JSON.stringify(credential));
      const [account] = await tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, this.account.id)).for("update").limit(1);
      if (!account || account.deletedAt) throw authorityChanged();
      await this.assertPinned(tx, account, true);
      if (account.credentialRefreshState !== "pending") throw authorityChanged();
      const now = await databaseNow(tx);
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) throw new UnauthorizedException("Marketplace refreshed credential is expired");
      const nextVersion = this.credentialVersion + 1;
      await tx.update(marketplaceCredentials).set({ encryptedEnvelope, version: nextVersion, expiresAt, rotatedAt: now, updatedAt: now })
        .where(eq(marketplaceCredentials.id, this.credentialId));
      await tx.update(marketplaceAccounts).set({ credentialRefreshState: "known", credentialUseStartedAt: now,
        credentialStatus: expiresAt.getTime() - now.getTime() <= 14 * 86_400_000 ? "expiring" : "valid", updatedAt: now })
        .where(eq(marketplaceAccounts.id, this.account.id));
      await this.audit.recordInTransaction(tx, this.authority, { action: "marketplace_credential.refresh.checkpoint", resourceType: "marketplace_account",
        resourceId: this.account.id, result: "success", metadata: { authorizationGeneration: this.generation, useId: this.useId, credentialVersion: nextVersion } });
      return { version: nextVersion, encryptedEnvelope };
  }

  async releaseInTransaction(tx: TenantTransaction): Promise<boolean> {
    const [account] = await tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, this.account.id)).for("update").limit(1);
    if (!account || account.authorizationGeneration !== this.generation || account.credentialUseId !== this.useId) return false;
    const unknown = account.credentialRefreshState !== "known";
    await tx.update(marketplaceAccounts).set({ credentialUseId: null, credentialUseStartedAt: null,
      credentialRefreshState: unknown ? "unknown" : "known" }).where(eq(marketplaceAccounts.id, account.id));
    await this.audit.recordInTransaction(tx, this.authority, { action: unknown ? "marketplace_credential.refresh.unknown" : "marketplace_credential.use.finish",
      resourceType: "marketplace_account", resourceId: account.id, result: unknown ? "failure" : "success",
      metadata: { authorizationGeneration: this.generation, useId: this.useId, credentialVersion: this.credentialVersion } });
    return true;
  }

  async release(): Promise<void> {
    await withTenant(this.database.db, this.ceiling, (tx) => this.releaseInTransaction(tx));
  }

  private async assertPinned(tx: TenantTransaction, account: MarketplaceAccountRow, allowPending: boolean) {
    assertMarketplaceGeneration(account, this.generation);
    requireUsableAccount(account);
    if (account.credentialUseId !== this.useId) throw authorityChanged();
    if (account.credentialRefreshState !== "known" && !(allowPending && account.credentialRefreshState === "pending")) throw refreshUncertain();
    const [credential] = await tx.select({ id: marketplaceCredentials.id, version: marketplaceCredentials.version }).from(marketplaceCredentials)
      .where(eq(marketplaceCredentials.accountId, account.id)).for("update").limit(1);
    if (!credential || credential.id !== this.credentialId || credential.version !== this.credentialVersion) throw authorityChanged();
  }
}

function requireUsableAccount(account: MarketplaceAccountRow) {
  if (account.deletedAt || account.status === "disabled" || account.status === "revoked"
    || (account.credentialStatus !== "valid" && account.credentialStatus !== "expiring"))
    throw new UnauthorizedException("Marketplace account is not authorized");
}

function authorityChanged() {
  return new ConflictException({ code: "marketplace_authority_changed", message: "店铺授权已变化 请重新读取当前状态" });
}

function credentialBusy() {
  return new ConflictException({ code: "marketplace_credential_busy", message: "店铺凭据正在使用 请读取原任务状态" });
}

function refreshUncertain() {
  return new ConflictException({ code: "marketplace_credential_refresh_unknown", message: "店铺凭据刷新尚未确认 请重新授权" });
}
