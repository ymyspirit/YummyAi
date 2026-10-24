import { createHash, randomBytes } from "node:crypto";

import { BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { intersectPermissionContexts, Permission } from "@yummyai/authz";
import {
  MarketplaceAuthorizationModeSchema, MarketplaceOAuthStartViewSchema, MarketplacePlatformSchema, MarketplaceRegionSchema,
  TenantContextSchema, createEntityId, type AmazonPrivateAuthorizationInput, type MarketplaceAccountView,
  type MarketplaceOAuthCompleteInput, type MarketplaceOAuthStartView, type TenantContext,
} from "@yummyai/contracts";
import { marketplaceAccounts, marketplaceAuthorizationSessions, marketplaceCredentials,
  type DatabaseConnection, withTenant } from "@yummyai/database";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { MarketplaceAuthorizationError, type AuthorizationAccountContext, type AuthorizationGrant,
  type MarketplaceAuthorizationGateway } from "@yummyai/marketplace-connectors";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, MARKETPLACE_AUTHORIZATION_GATEWAY, MARKETPLACE_SECRET_VAULT } from "../platform.tokens.js";
import { assertMarketplaceGeneration, currentMarketplaceAuthority, databaseNow, invalidateMarketplaceAuthorization,
  lockMarketplaceAccount, marketplaceAccountView, type MarketplaceAccountRow } from "./marketplace-authority.js";
import { MarketplaceCredentialUse } from "./marketplace-authority-lease.js";

const CredentialEnvelopeSchema = z.record(z.string(), z.string());
const AUTHORIZATION_TTL_MS = 10 * 60 * 1_000;

@Injectable()
export class MarketplaceAuthorizationService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(MARKETPLACE_SECRET_VAULT) private readonly secrets: SecretVault,
    @Inject(MARKETPLACE_AUTHORIZATION_GATEWAY) private readonly gateway: MarketplaceAuthorizationGateway,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async authorizeAmazonPrivate(context: TenantContext, accountId: string,
    input: AmazonPrivateAuthorizationInput): Promise<MarketplaceAccountView> {
    const operation = await withTenant(this.database.db, context, async (tx) => {
      const { account, authority } = await lockMarketplaceAccount(tx, context, accountId, Permission.StoreAuthorize);
      requireEnabled(account);
      if (account.platform !== "amazon" || account.authorizationMode !== "amazon_private")
        throw new BadRequestException("Account does not use Amazon private authorization");
      const now = await databaseNow(tx);
      const invalidation = invalidateMarketplaceAuthorization(account);
      const [fenced] = await tx.update(marketplaceAccounts).set({ ...invalidation, credentialStatus: "revoked",
        status: "pending_authorization", grantedScopes: [], capabilities: [], capabilityExpiresAt: null, updatedAt: now })
        .where(eq(marketplaceAccounts.id, accountId)).returning();
      await tx.update(marketplaceAuthorizationSessions).set({ consumedAt: now, failureCode: "superseded" })
        .where(and(eq(marketplaceAuthorizationSessions.accountId, accountId), isNull(marketplaceAuthorizationSessions.consumedAt)));
      await this.audit.recordInTransaction(tx, authority, { action: "marketplace_authorization.begin", resourceType: "marketplace_account",
        resourceId: accountId, result: "success", metadata: { authorizationGeneration: invalidation.authorizationGeneration, authorizationMode: account.authorizationMode } });
      return { account: fenced!, authority };
    });
    try {
      const grant = await this.gateway.verifyAmazonPrivate(input, operation.account.requestedScopes);
      return await this.persistGrant(operation.authority, operation.account, grant, "marketplace_authorization.create");
    } catch (error) {
      await this.recordAuthorizationFailure(operation.authority, operation.account, error);
      throw toHttpError(error);
    }
  }

  async startOAuth(context: TenantContext, accountId: string): Promise<MarketplaceOAuthStartView> {
    const state = randomBytes(32).toString("base64url");
    return withTenant(this.database.db, context, async (tx) => {
      const { account, authority } = await lockMarketplaceAccount(tx, context, accountId, Permission.StoreAuthorize);
      requireEnabled(account);
      if (account.authorizationMode === "amazon_private")
        throw new BadRequestException("Amazon private accounts use direct credential authorization");
      const pkceVerifier = account.platform === "etsy" ? randomBytes(64).toString("base64url") : null;
      const challenge = pkceVerifier ? createHash("sha256").update(pkceVerifier).digest("base64url") : null;
      let authorizationRequest;
      try { authorizationRequest = this.gateway.createAuthorizationRequest(toAuthorizationContext(account), state, challenge); }
      catch (error) { throw toHttpError(error); }
      const now = await databaseNow(tx);
      const expiresAt = new Date(now.getTime() + AUTHORIZATION_TTL_MS);
      const invalidation = invalidateMarketplaceAuthorization(account);
      await tx.update(marketplaceAccounts).set({ ...invalidation, credentialStatus: "revoked", grantedScopes: [], capabilities: [],
        capabilityExpiresAt: null, status: "pending_authorization", updatedAt: now }).where(eq(marketplaceAccounts.id, accountId));
      await tx.update(marketplaceAuthorizationSessions).set({ consumedAt: now, failureCode: "superseded" })
        .where(and(eq(marketplaceAuthorizationSessions.accountId, accountId), isNull(marketplaceAuthorizationSessions.consumedAt)));
      await tx.insert(marketplaceAuthorizationSessions).values({
        id: createEntityId(), tenantId: context.tenantId, accountId, authorizationMode: account.authorizationMode,
        authorizationGeneration: invalidation.authorizationGeneration, authorityCeiling: authority,
        stateDigest: digestState(state), encryptedPkceVerifier: pkceVerifier ? this.secrets.encrypt(pkceVerifier) : null,
        redirectUri: authorizationRequest.redirectUri, requestedScopes: account.requestedScopes, expiresAt, createdBy: authority.userId,
      });
      await this.audit.recordInTransaction(tx, authority, { action: "marketplace_authorization.start", resourceType: "marketplace_account",
        resourceId: accountId, result: "success", metadata: { platform: account.platform, authorizationMode: account.authorizationMode,
          authorizationGeneration: invalidation.authorizationGeneration, expiresAt: expiresAt.toISOString() } });
      return MarketplaceOAuthStartViewSchema.parse({ authorizationUrl: authorizationRequest.authorizationUrl, expiresAt: expiresAt.toISOString() });
    });
  }

  async completeOAuth(context: TenantContext, accountId: string,
    input: MarketplaceOAuthCompleteInput): Promise<MarketplaceAccountView> {
    const operation = await withTenant(this.database.db, context, async (tx) => {
      const { account, authority } = await lockMarketplaceAccount(tx, context, accountId, Permission.StoreAuthorize);
      requireEnabled(account);
      if (account.authorizationMode === "amazon_private")
        throw new BadRequestException("Amazon private accounts do not use OAuth callbacks");
      if (account.platform === "amazon" && !input.sellingPartnerId)
        throw new BadRequestException("Amazon OAuth completion requires sellingPartnerId");
      const [session] = await tx.select().from(marketplaceAuthorizationSessions).where(and(
        eq(marketplaceAuthorizationSessions.accountId, accountId),
        eq(marketplaceAuthorizationSessions.stateDigest, digestState(input.state)),
      )).for("update").limit(1);
      const now = await databaseNow(tx);
      const ceiling = TenantContextSchema.safeParse(session?.authorityCeiling);
      if (!session || session.createdBy !== context.userId || session.consumedAt || session.expiresAt <= now
        || session.authorizationMode !== account.authorizationMode || session.authorizationGeneration !== account.authorizationGeneration
        || !ceiling.success || ceiling.data.tenantId !== context.tenantId || ceiling.data.userId !== context.userId) {
        await this.audit.recordInTransaction(tx, authority, { action: "marketplace_authorization.reject_state", resourceType: "marketplace_account",
          resourceId: accountId, result: "denied", metadata: { platform: account.platform, authorizationMode: account.authorizationMode } });
        return null;
      }
      const original = intersectPermissionContexts(context, ceiling.data);
      const completionAuthority = await currentMarketplaceAuthority(tx, original, Permission.StoreAuthorize, account);
      await tx.update(marketplaceAuthorizationSessions).set({ consumedAt: now }).where(eq(marketplaceAuthorizationSessions.id, session.id));
      await this.audit.recordInTransaction(tx, completionAuthority, { action: "marketplace_authorization.exchange", resourceType: "marketplace_account",
        resourceId: accountId, result: "success", metadata: { authorizationGeneration: account.authorizationGeneration, sessionId: session.id } });
      return { account, authority: completionAuthority, session };
    });
    if (!operation) throw new BadRequestException("Authorization state is invalid, expired, or already used");
    try {
      const exchange = (pkceVerifier: string | null) => this.gateway.exchangeAuthorizationCode(
        { ...toAuthorizationContext(operation.account), requestedScopes: operation.session.requestedScopes },
        { code: input.code, pkceVerifier, redirectUri: operation.session.redirectUri, sellingPartnerId: input.sellingPartnerId },
      );
      const grant = operation.session.encryptedPkceVerifier
        ? await this.secrets.withSecret(operation.session.encryptedPkceVerifier, exchange) : await exchange(null);
      return await this.persistGrant(operation.authority, operation.account, grant, "marketplace_authorization.complete");
    } catch (error) {
      await this.recordAuthorizationFailure(operation.authority, operation.account, error, operation.session.id);
      throw toHttpError(error);
    }
  }

  async revoke(context: TenantContext, accountId: string): Promise<MarketplaceAccountView> {
    return withTenant(this.database.db, context, async (tx) => {
      const { account, authority } = await lockMarketplaceAccount(tx, context, accountId, Permission.StoreAuthorize);
      const now = await databaseNow(tx);
      const invalidation = invalidateMarketplaceAuthorization(account);
      await tx.delete(marketplaceCredentials).where(eq(marketplaceCredentials.accountId, accountId));
      await tx.update(marketplaceAuthorizationSessions).set({ consumedAt: now, failureCode: "revoked" })
        .where(and(eq(marketplaceAuthorizationSessions.accountId, accountId), isNull(marketplaceAuthorizationSessions.consumedAt)));
      const [updated] = await tx.update(marketplaceAccounts).set({ ...invalidation, credentialStatus: "revoked", grantedScopes: [],
        capabilities: [], capabilityExpiresAt: null, healthStatus: "unauthorized", lastHealthAt: now, lastErrorCode: "AUTH_REVOKED",
        status: account.status === "disabled" ? "disabled" : "revoked", updatedAt: now }).where(eq(marketplaceAccounts.id, accountId)).returning();
      await this.audit.recordInTransaction(tx, authority, { action: "marketplace_authorization.revoke", resourceType: "marketplace_account",
        resourceId: accountId, result: "success", metadata: { platform: account.platform, authorizationMode: account.authorizationMode,
          authorizationGeneration: invalidation.authorizationGeneration } });
      return marketplaceAccountView(updated!);
    });
  }

  /** Server-only use: the raw credential remains inside the original owning service. */
  claimCredentialUse(context: TenantContext, accountId: string): Promise<MarketplaceCredentialUse> {
    return MarketplaceCredentialUse.claim(this.database, this.secrets, this.audit, context, accountId);
  }

  async withCredential<T>(context: TenantContext, accountId: string,
    callback: (credential: Readonly<Record<string, string>>) => Promise<T>): Promise<T> {
    const lease = await this.claimCredentialUse(context, accountId);
    try {
      const result = await this.secrets.withSecret(lease.encryptedEnvelope, (raw) => callback(CredentialEnvelopeSchema.parse(JSON.parse(raw))));
      await withTenant(this.database.db, lease.ceiling, async (tx) => {
        await lease.current(tx);
        await lease.releaseInTransaction(tx);
      });
      return result;
    } finally { await lease.release(); }
  }

  private async persistGrant(context: TenantContext, original: MarketplaceAccountRow,
    grant: AuthorizationGrant, action: string): Promise<MarketplaceAccountView> {
    const encryptedEnvelope = this.secrets.encrypt(JSON.stringify(grant.credential));
    return withTenant(this.database.db, context, async (tx) => {
      const { account, authority } = await lockMarketplaceAccount(tx, context, original.id, Permission.StoreAuthorize);
      assertMarketplaceGeneration(account, original.authorizationGeneration);
      requireEnabled(account);
      const now = await databaseNow(tx);
      const [existing] = await tx.select().from(marketplaceCredentials).where(eq(marketplaceCredentials.accountId, account.id)).for("update").limit(1);
      if (existing) {
        await tx.update(marketplaceCredentials).set({ kind: account.authorizationMode, encryptedEnvelope, version: existing.version + 1,
          expiresAt: grant.expiresAt, rotatedAt: now, updatedAt: now }).where(eq(marketplaceCredentials.id, existing.id));
      } else {
        await tx.insert(marketplaceCredentials).values({ id: createEntityId(), tenantId: context.tenantId, accountId: account.id,
          kind: account.authorizationMode, encryptedEnvelope, expiresAt: grant.expiresAt, createdBy: authority.userId });
      }
      // Etsy's OAuth subject is a user; an already verified account identity is its shop.
      const externalAccountId = account.platform === "etsy" && account.lastCapabilitySyncAt !== null && account.externalAccountId !== null
        ? account.externalAccountId : grant.externalAccountId;
      const [updated] = await tx.update(marketplaceAccounts).set({ externalAccountId,
        grantedScopes: [...grant.grantedScopes], credentialStatus: "valid", credentialRefreshState: "known", credentialUseId: null,
        credentialUseStartedAt: null, healthStatus: "not_checked", lastHealthAt: null, lastErrorCode: null,
        status: "pending_authorization", updatedAt: now }).where(eq(marketplaceAccounts.id, account.id)).returning();
      await this.audit.recordInTransaction(tx, authority, { action: existing ? "marketplace_authorization.rotate" : action,
        resourceType: "marketplace_account", resourceId: account.id, result: "success", metadata: { platform: account.platform,
          authorizationMode: account.authorizationMode, authorizationGeneration: account.authorizationGeneration } });
      return marketplaceAccountView(updated!);
    });
  }

  private async recordAuthorizationFailure(context: TenantContext, original: MarketplaceAccountRow,
    error: unknown, sessionId?: string): Promise<void> {
    await withTenant(this.database.db, context, async (tx) => {
      await currentMarketplaceAuthority(tx, context, Permission.StoreAuthorize, { createdBy: context.userId });
      // Membership precedes the account lock, as in the successful lifecycle paths.
      const [account] = await tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, original.id)).for("update").limit(1);
      if (!account || account.deletedAt || account.authorizationGeneration !== original.authorizationGeneration) return;
      const authority = await currentMarketplaceAuthority(tx, context, Permission.StoreAuthorize, account);
      const code = errorCode(error);
      const now = await databaseNow(tx);
      await tx.update(marketplaceAccounts).set({ lastErrorCode: code, updatedAt: now }).where(eq(marketplaceAccounts.id, account.id));
      if (sessionId) await tx.update(marketplaceAuthorizationSessions).set({ failureCode: code })
        .where(and(eq(marketplaceAuthorizationSessions.id, sessionId),
          eq(marketplaceAuthorizationSessions.authorizationGeneration, original.authorizationGeneration)));
      await this.audit.recordInTransaction(tx, authority, { action: "marketplace_authorization.failure", resourceType: "marketplace_account",
        resourceId: account.id, result: "failure", metadata: { errorCode: code, authorizationGeneration: original.authorizationGeneration } });
    });
  }
}

function requireEnabled(account: MarketplaceAccountRow) {
  if (account.status === "disabled") throw new ConflictException("Marketplace account is disabled");
}
function toAuthorizationContext(account: MarketplaceAccountRow): AuthorizationAccountContext {
  return { authorizationMode: MarketplaceAuthorizationModeSchema.parse(account.authorizationMode),
    platform: MarketplacePlatformSchema.parse(account.platform), region: MarketplaceRegionSchema.parse(account.region),
    requestedScopes: account.requestedScopes };
}
function digestState(state: string): string { return createHash("sha256").update(state).digest("base64url"); }
function errorCode(error: unknown): string {
  return error instanceof MarketplaceAuthorizationError ? `AUTH_${error.code.toUpperCase()}` : "AUTH_FAILED";
}
function toHttpError(error: unknown): Error {
  if (error instanceof MarketplaceAuthorizationError) {
    if (error.code === "rejected") return new UnauthorizedException("Marketplace authorization was rejected");
    return new ServiceUnavailableException("Marketplace authorization is unavailable");
  }
  if (error instanceof Error && "status" in error) return error;
  return new ServiceUnavailableException("Marketplace authorization is unavailable");
}
