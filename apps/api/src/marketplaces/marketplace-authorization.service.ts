import { createHash, randomBytes } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import {
  MarketplaceAccountViewSchema,
  MarketplaceAuthorizationModeSchema,
  MarketplaceOAuthStartViewSchema,
  MarketplacePlatformSchema,
  MarketplaceRegionSchema,
  createEntityId,
  type AmazonPrivateAuthorizationInput,
  type MarketplaceAccountView,
  type MarketplaceOAuthCompleteInput,
  type MarketplaceOAuthStartView,
  type TenantContext,
} from "@yummyai/contracts";
import {
  marketplaceAccounts,
  marketplaceAuthorizationSessions,
  marketplaceCredentials,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  MarketplaceAuthorizationError,
  type AuthorizationAccountContext,
  type AuthorizationGrant,
  type MarketplaceAuthorizationGateway,
} from "@yummyai/marketplace-connectors";

import { AuditService } from "../audit/audit.service.js";
import {
  DATABASE_CONNECTION,
  MARKETPLACE_AUTHORIZATION_GATEWAY,
  MARKETPLACE_SECRET_VAULT,
} from "../platform.tokens.js";

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

  async authorizeAmazonPrivate(
    context: TenantContext,
    accountId: string,
    input: AmazonPrivateAuthorizationInput,
  ): Promise<MarketplaceAccountView> {
    const account = await this.loadAccount(context, accountId);
    this.requireEnabled(account);
    if (account.platform !== "amazon" || account.authorizationMode !== "amazon_private") {
      throw new BadRequestException("Account does not use Amazon private authorization");
    }
    try {
      const grant = await this.gateway.verifyAmazonPrivate(input, account.requestedScopes);
      const rotated = await this.persistGrant(context, account, grant);
      await this.audit.record(context, {
        action: rotated ? "marketplace_authorization.rotate" : "marketplace_authorization.create",
        resourceType: "marketplace_account",
        resourceId: accountId,
        result: "success",
        metadata: { platform: account.platform, authorizationMode: account.authorizationMode },
      });
      return this.loadAccountView(context, accountId);
    } catch (error) {
      await this.recordAuthorizationFailure(context, accountId, error);
      throw toHttpError(error);
    }
  }

  async startOAuth(context: TenantContext, accountId: string): Promise<MarketplaceOAuthStartView> {
    const account = await this.loadAccount(context, accountId);
    this.requireEnabled(account);
    if (account.authorizationMode === "amazon_private") {
      throw new BadRequestException("Amazon private accounts use direct credential authorization");
    }
    const state = randomBytes(32).toString("base64url");
    const pkceVerifier = account.platform === "etsy" ? randomBytes(64).toString("base64url") : null;
    const pkceChallenge = pkceVerifier
      ? createHash("sha256").update(pkceVerifier).digest("base64url")
      : null;
    let authorizationRequest;
    try {
      authorizationRequest = this.gateway.createAuthorizationRequest(toAuthorizationContext(account), state, pkceChallenge);
    } catch (error) {
      throw toHttpError(error);
    }
    const expiresAt = new Date(Date.now() + AUTHORIZATION_TTL_MS);
    await withTenant(this.database.db, context, async (tx) => {
      await tx.update(marketplaceAuthorizationSessions).set({
        consumedAt: new Date(),
        failureCode: "superseded",
      }).where(and(
        eq(marketplaceAuthorizationSessions.accountId, accountId),
        isNull(marketplaceAuthorizationSessions.consumedAt),
      ));
      await tx.insert(marketplaceAuthorizationSessions).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        accountId,
        authorizationMode: account.authorizationMode,
        stateDigest: digestState(state),
        encryptedPkceVerifier: pkceVerifier ? this.secrets.encrypt(pkceVerifier) : null,
        redirectUri: authorizationRequest.redirectUri,
        requestedScopes: account.requestedScopes,
        expiresAt,
        createdBy: context.userId,
      });
    });
    await this.audit.record(context, {
      action: "marketplace_authorization.start",
      resourceType: "marketplace_account",
      resourceId: accountId,
      result: "success",
      metadata: { platform: account.platform, authorizationMode: account.authorizationMode, expiresAt: expiresAt.toISOString() },
    });
    return MarketplaceOAuthStartViewSchema.parse({
      authorizationUrl: authorizationRequest.authorizationUrl,
      expiresAt: expiresAt.toISOString(),
    });
  }

  async completeOAuth(
    context: TenantContext,
    accountId: string,
    input: MarketplaceOAuthCompleteInput,
  ): Promise<MarketplaceAccountView> {
    const account = await this.loadAccount(context, accountId);
    this.requireEnabled(account);
    if (account.authorizationMode === "amazon_private") {
      throw new BadRequestException("Amazon private accounts do not use OAuth callbacks");
    }
    if (account.platform === "amazon" && !input.sellingPartnerId) {
      throw new BadRequestException("Amazon OAuth completion requires sellingPartnerId");
    }
    const [session] = await withTenant(this.database.db, context, (tx) =>
      tx.update(marketplaceAuthorizationSessions).set({ consumedAt: new Date() }).where(and(
        eq(marketplaceAuthorizationSessions.accountId, accountId),
        eq(marketplaceAuthorizationSessions.authorizationMode, account.authorizationMode),
        eq(marketplaceAuthorizationSessions.stateDigest, digestState(input.state)),
        isNull(marketplaceAuthorizationSessions.consumedAt),
        gt(marketplaceAuthorizationSessions.expiresAt, new Date()),
      )).returning(),
    );
    if (!session) {
      await this.audit.record(context, {
        action: "marketplace_authorization.reject_state",
        resourceType: "marketplace_account",
        resourceId: accountId,
        result: "denied",
        metadata: { platform: account.platform, authorizationMode: account.authorizationMode },
      });
      throw new BadRequestException("Authorization state is invalid, expired, or already used");
    }

    try {
      const exchange = (pkceVerifier: string | null) => this.gateway.exchangeAuthorizationCode(
        { ...toAuthorizationContext(account), requestedScopes: session.requestedScopes },
        {
          code: input.code,
          pkceVerifier,
          redirectUri: session.redirectUri,
          sellingPartnerId: input.sellingPartnerId,
        },
      );
      const grant = session.encryptedPkceVerifier
        ? await this.secrets.withSecret(session.encryptedPkceVerifier, exchange)
        : await exchange(null);
      const rotated = await this.persistGrant(context, account, grant);
      await this.audit.record(context, {
        action: rotated ? "marketplace_authorization.rotate" : "marketplace_authorization.complete",
        resourceType: "marketplace_account",
        resourceId: accountId,
        result: "success",
        metadata: { platform: account.platform, authorizationMode: account.authorizationMode },
      });
      return this.loadAccountView(context, accountId);
    } catch (error) {
      await withTenant(this.database.db, context, (tx) =>
        tx.update(marketplaceAuthorizationSessions).set({ failureCode: errorCode(error) })
          .where(eq(marketplaceAuthorizationSessions.id, session.id)),
      );
      await this.recordAuthorizationFailure(context, accountId, error);
      throw toHttpError(error);
    }
  }

  async revoke(context: TenantContext, accountId: string): Promise<MarketplaceAccountView> {
    const account = await this.loadAccount(context, accountId);
    await withTenant(this.database.db, context, async (tx) => {
      await tx.delete(marketplaceCredentials).where(eq(marketplaceCredentials.accountId, accountId));
      await tx.update(marketplaceAuthorizationSessions).set({
        consumedAt: new Date(),
        failureCode: "revoked",
      }).where(and(
        eq(marketplaceAuthorizationSessions.accountId, accountId),
        isNull(marketplaceAuthorizationSessions.consumedAt),
      ));
      await tx.update(marketplaceAccounts).set({
        credentialStatus: "revoked",
        grantedScopes: [],
        healthStatus: "unauthorized",
        lastHealthAt: new Date(),
        lastErrorCode: "AUTH_REVOKED",
        status: account.status === "disabled" ? "disabled" : "revoked",
        updatedAt: new Date(),
      }).where(eq(marketplaceAccounts.id, accountId));
    });
    await this.audit.record(context, {
      action: "marketplace_authorization.revoke",
      resourceType: "marketplace_account",
      resourceId: accountId,
      result: "success",
      metadata: { platform: account.platform, authorizationMode: account.authorizationMode },
    });
    return this.loadAccountView(context, accountId);
  }

  async withCredential<T>(
    context: TenantContext,
    accountId: string,
    callback: (credential: Readonly<Record<string, string>>) => Promise<T>,
  ): Promise<T> {
    const [credential] = await withTenant(this.database.db, context, (tx) =>
      tx.select({
        accountStatus: marketplaceAccounts.status,
        encryptedEnvelope: marketplaceCredentials.encryptedEnvelope,
      })
        .from(marketplaceCredentials)
        .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, marketplaceCredentials.accountId))
        .where(eq(marketplaceCredentials.accountId, accountId))
        .limit(1),
    );
    if (!credential || credential.accountStatus === "disabled" || credential.accountStatus === "revoked") {
      throw new UnauthorizedException("Marketplace account is not authorized");
    }
    return this.secrets.withSecret(credential.encryptedEnvelope, (raw) =>
      callback(CredentialEnvelopeSchema.parse(JSON.parse(raw))),
    );
  }

  private async persistGrant(
    context: TenantContext,
    account: MarketplaceAccountRow,
    grant: AuthorizationGrant,
  ): Promise<boolean> {
    const encryptedEnvelope = this.secrets.encrypt(JSON.stringify(grant.credential));
    return withTenant(this.database.db, context, async (tx) => {
      const [existing] = await tx.select({ id: marketplaceCredentials.id, version: marketplaceCredentials.version })
        .from(marketplaceCredentials)
        .where(eq(marketplaceCredentials.accountId, account.id))
        .limit(1);
      const now = new Date();
      if (existing) {
        await tx.update(marketplaceCredentials).set({
          kind: account.authorizationMode,
          encryptedEnvelope,
          version: existing.version + 1,
          expiresAt: grant.expiresAt,
          rotatedAt: now,
          updatedAt: now,
        }).where(eq(marketplaceCredentials.id, existing.id));
      } else {
        await tx.insert(marketplaceCredentials).values({
          id: createEntityId(),
          tenantId: context.tenantId,
          accountId: account.id,
          kind: account.authorizationMode,
          encryptedEnvelope,
          expiresAt: grant.expiresAt,
          createdBy: context.userId,
        });
      }
      await tx.update(marketplaceAccounts).set({
        externalAccountId: grant.externalAccountId,
        grantedScopes: [...grant.grantedScopes],
        credentialStatus: "valid",
        healthStatus: "not_checked",
        lastHealthAt: null,
        lastErrorCode: null,
        status: "pending_authorization",
        updatedAt: now,
      }).where(eq(marketplaceAccounts.id, account.id));
      return Boolean(existing);
    });
  }

  private async recordAuthorizationFailure(context: TenantContext, accountId: string, error: unknown): Promise<void> {
    const code = errorCode(error);
    await withTenant(this.database.db, context, (tx) =>
      tx.update(marketplaceAccounts).set({ lastErrorCode: code, updatedAt: new Date() })
        .where(eq(marketplaceAccounts.id, accountId)),
    );
    await this.audit.record(context, {
      action: "marketplace_authorization.failure",
      resourceType: "marketplace_account",
      resourceId: accountId,
      result: "failure",
      metadata: { errorCode: code },
    });
  }

  private async loadAccount(context: TenantContext, accountId: string): Promise<MarketplaceAccountRow> {
    const [account] = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, accountId)).limit(1),
    );
    if (!account) throw new NotFoundException("Marketplace account not found");
    return account;
  }

  private async loadAccountView(context: TenantContext, accountId: string): Promise<MarketplaceAccountView> {
    const account = await this.loadAccount(context, accountId);
    return MarketplaceAccountViewSchema.parse({
      id: account.id,
      platform: account.platform,
      displayName: account.displayName,
      externalAccountId: account.externalAccountId,
      region: account.region,
      marketplaceIds: account.marketplaceIds,
      authorizationMode: account.authorizationMode,
      status: account.status,
      requestedScopes: account.requestedScopes,
      grantedScopes: account.grantedScopes,
      capabilities: account.capabilities,
      credentialStatus: account.credentialStatus,
      hasCredential: account.credentialStatus === "valid" || account.credentialStatus === "expiring",
      healthStatus: account.healthStatus,
      lastHealthAt: account.lastHealthAt?.toISOString() ?? null,
      lastCapabilitySyncAt: account.lastCapabilitySyncAt?.toISOString() ?? null,
      capabilityExpiresAt: account.capabilityExpiresAt?.toISOString() ?? null,
      lastErrorCode: account.lastErrorCode,
      createdAt: account.createdAt.toISOString(),
      updatedAt: account.updatedAt.toISOString(),
    });
  }

  private requireEnabled(account: MarketplaceAccountRow): void {
    if (account.status === "disabled") throw new ConflictException("Marketplace account is disabled");
  }
}

type MarketplaceAccountRow = typeof marketplaceAccounts.$inferSelect;

function toAuthorizationContext(account: MarketplaceAccountRow): AuthorizationAccountContext {
  return {
    authorizationMode: MarketplaceAuthorizationModeSchema.parse(account.authorizationMode),
    platform: MarketplacePlatformSchema.parse(account.platform),
    region: MarketplaceRegionSchema.parse(account.region),
    requestedScopes: account.requestedScopes,
  };
}

function digestState(state: string): string {
  return createHash("sha256").update(state).digest("base64url");
}

function errorCode(error: unknown): string {
  return error instanceof MarketplaceAuthorizationError
    ? `AUTH_${error.code.toUpperCase()}`
    : "AUTH_FAILED";
}

function toHttpError(error: unknown): Error {
  if (error instanceof MarketplaceAuthorizationError) {
    if (error.code === "rejected") return new UnauthorizedException("Marketplace authorization was rejected");
    return new ServiceUnavailableException("Marketplace authorization is unavailable");
  }
  if (error instanceof Error && "status" in error) return error;
  return new ServiceUnavailableException("Marketplace authorization is unavailable");
}
