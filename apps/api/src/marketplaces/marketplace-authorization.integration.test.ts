import { createHash, randomBytes } from "node:crypto";

import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import {
  CreateMarketplaceAccountInputSchema,
  createEntityId,
  type AmazonPrivateAuthorizationInput,
  type MarketplaceOAuthCompleteInput,
  type TenantContext,
} from "@yummyai/contracts";
import {
  auditEvents,
  connectDatabase,
  marketplaceAuthorizationSessions,
  marketplaceCredentials,
  migrateDatabase,
  withTenant,
} from "@yummyai/database";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AuthorizationAccountContext,
  AuthorizationGrant,
  AuthorizationRequest,
  MarketplaceAuthorizationGateway,
  OAuthExchangeInput,
} from "@yummyai/marketplace-connectors";

import { AuditService } from "../audit/audit.service.js";
import { MarketplaceAccountService } from "./marketplace-account.service.js";
import { MarketplaceAuthorizationService } from "./marketplace-authorization.service.js";

class FakeAuthorizationGateway implements MarketplaceAuthorizationGateway {
  exchangeCalls = 0;
  lastChallenge: string | null = null;
  lastExchange: { account: AuthorizationAccountContext; input: OAuthExchangeInput } | null = null;

  createAuthorizationRequest(
    account: AuthorizationAccountContext,
    state: string,
    pkceChallenge: string | null,
  ): AuthorizationRequest {
    this.lastChallenge = pkceChallenge;
    const url = new URL(`https://authorize.example.test/${account.platform}`);
    url.searchParams.set("state", state);
    if (pkceChallenge) url.searchParams.set("code_challenge", pkceChallenge);
    return { authorizationUrl: url.toString(), redirectUri: "https://erp.example.test/oauth/callback" };
  }

  exchangeAuthorizationCode(
    account: AuthorizationAccountContext,
    input: OAuthExchangeInput,
  ): Promise<AuthorizationGrant> {
    this.exchangeCalls += 1;
    this.lastExchange = { account, input };
    return Promise.resolve({
      credential: { kind: "etsy_oauth", refreshToken: "etsy-refresh-secret", userId: "12345678" },
      externalAccountId: "12345678",
      expiresAt: new Date("2026-10-17T00:00:00.000Z"),
      grantedScopes: account.requestedScopes,
    });
  }

  verifyAmazonPrivate(
    input: AmazonPrivateAuthorizationInput,
    requestedScopes: readonly string[],
  ): Promise<AuthorizationGrant> {
    return Promise.resolve({
      credential: {
        kind: "amazon_private",
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        refreshToken: input.refreshToken,
        sellingPartnerId: input.sellingPartnerId,
      },
      externalAccountId: input.sellingPartnerId,
      expiresAt: null,
      grantedScopes: requestedScopes,
    });
  }
}

describe("marketplace authorization", () => {
  const database = connectDatabase();
  const vault = new SecretVault(randomBytes(32));
  const gateway = new FakeAuthorizationGateway();
  const audit = new AuditService(database);
  const accountService = new MarketplaceAccountService(database, audit);
  const service = new MarketplaceAuthorizationService(database, vault, gateway, audit);
  const tenantId = createEntityId();
  const otherTenantId = createEntityId();
  const userId = createEntityId();
  const context: TenantContext = {
    tenantId,
    userId,
    permissions: [Permission.StoreRead, Permission.StoreManage, Permission.StoreAuthorize],
    dataScope: "tenant",
  };
  const otherContext: TenantContext = { ...context, tenantId: otherTenantId };
  let amazonAccountId: string;
  let etsyAccountId: string;

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, 'Authorization tenant', $2), ($3, 'Other authorization tenant', $4)`,
      [tenantId, `authorization-${tenantId}`, otherTenantId, `other-authorization-${otherTenantId}`],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1, $2, $3, 'Authorization Admin')`,
      [userId, `authorization-${userId}`, `${userId}@example.test`],
    );
    amazonAccountId = (await accountService.create(context, CreateMarketplaceAccountInputSchema.parse({
      platform: "amazon",
      displayName: "Amazon private",
      region: "NA",
      marketplaceIds: ["ATVPDKIKX0DER"],
      authorizationMode: "amazon_private",
      requestedScopes: ["product-listing"],
    }))).id;
    etsyAccountId = (await accountService.create(context, CreateMarketplaceAccountInputSchema.parse({
      platform: "etsy",
      displayName: "Etsy OAuth",
      region: "GLOBAL",
      marketplaceIds: ["etsy"],
      authorizationMode: "etsy_oauth",
      requestedScopes: ["listings_r", "listings_w", "shops_r"],
    }))).id;
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("encrypts, redacts, and rotates Amazon private credentials", async () => {
    const authorized = await service.authorizeAmazonPrivate(context, amazonAccountId, {
      sellingPartnerId: "A1SELLER",
      clientId: "lwa-client",
      clientSecret: "lwa-client-secret",
      refreshToken: "Atzr|first-refresh-token",
    });
    expect(authorized).toMatchObject({
      externalAccountId: "A1SELLER",
      credentialStatus: "valid",
      hasCredential: true,
      status: "pending_authorization",
    });
    expect(JSON.stringify(authorized)).not.toMatch(/lwa-client-secret|Atzr\|/);

    const [first] = await withTenant(database.db, context, (tx) =>
      tx.select().from(marketplaceCredentials).where(eq(marketplaceCredentials.accountId, amazonAccountId)),
    );
    expect(first!.version).toBe(1);
    expect(first!.encryptedEnvelope).not.toMatch(/lwa-client-secret|Atzr\|/);
    await expect(service.withCredential(context, amazonAccountId, async (credential) => credential.refreshToken))
      .resolves.toBe("Atzr|first-refresh-token");

    await service.authorizeAmazonPrivate(context, amazonAccountId, {
      sellingPartnerId: "A1SELLER",
      clientId: "lwa-client",
      clientSecret: "lwa-rotated-secret",
      refreshToken: "Atzr|rotated-refresh-token",
    });
    const [rotated] = await withTenant(database.db, context, (tx) =>
      tx.select().from(marketplaceCredentials).where(eq(marketplaceCredentials.accountId, amazonAccountId)),
    );
    expect(rotated!.version).toBe(2);
    expect(rotated!.encryptedEnvelope).not.toBe(first!.encryptedEnvelope);
    await expect(service.withCredential(context, amazonAccountId, async (credential) => credential.refreshToken))
      .resolves.toBe("Atzr|rotated-refresh-token");

    const events = await withTenant(database.db, context, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, amazonAccountId)),
    );
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "marketplace_authorization.create" }),
      expect.objectContaining({ action: "marketplace_authorization.rotate" }),
    ]));
    expect(JSON.stringify(events)).not.toMatch(/lwa-rotated-secret|Atzr\|rotated/);
  });

  it("uses one-time state, encrypted PKCE, and the scopes frozen at OAuth start", async () => {
    const started = await service.startOAuth(context, etsyAccountId);
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    expect(state).toHaveLength(43);
    const [session] = await withTenant(database.db, context, (tx) =>
      tx.select().from(marketplaceAuthorizationSessions).where(and(
        eq(marketplaceAuthorizationSessions.accountId, etsyAccountId),
        isNull(marketplaceAuthorizationSessions.consumedAt),
      )),
    );
    expect(session!.stateDigest).not.toBe(state);
    expect(session!.encryptedPkceVerifier).not.toContain(state);
    const verifier = vault.withSecret(session!.encryptedPkceVerifier!, (value) => value);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(gateway.lastChallenge);

    await accountService.update(context, etsyAccountId, {
      requestedScopes: ["listings_r", "listings_w", "shops_r", "transactions_r"],
    });
    const completed = await service.completeOAuth(context, etsyAccountId, {
      state,
      code: "etsy-one-time-code",
    } satisfies MarketplaceOAuthCompleteInput);
    expect(completed).toMatchObject({
      externalAccountId: "12345678",
      credentialStatus: "valid",
      grantedScopes: ["listings_r", "listings_w", "shops_r"],
      status: "pending_authorization",
    });
    expect(gateway.lastExchange?.input.pkceVerifier).toBe(verifier);
    expect(gateway.lastExchange?.account.requestedScopes).toEqual(["listings_r", "listings_w", "shops_r"]);

    await expect(service.completeOAuth(context, etsyAccountId, { state, code: "replayed-code" }))
      .rejects.toMatchObject({ status: 400 });
    expect(gateway.exchangeCalls).toBe(1);
  });

  it("rejects expired state without invoking the exchange", async () => {
    const started = await service.startOAuth(context, etsyAccountId);
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await withTenant(database.db, context, (tx) =>
      tx.update(marketplaceAuthorizationSessions).set({ expiresAt: new Date("2020-01-01T00:00:00.000Z") }).where(and(
        eq(marketplaceAuthorizationSessions.accountId, etsyAccountId),
        isNull(marketplaceAuthorizationSessions.consumedAt),
      )),
    );
    await expect(service.completeOAuth(context, etsyAccountId, { state, code: "expired-code" }))
      .rejects.toMatchObject({ status: 400 });
    expect(gateway.exchangeCalls).toBe(1);
  });

  it("revokes by cryptographically erasing the credential and blocks cross-tenant access", async () => {
    await expect(service.revoke(otherContext, etsyAccountId)).rejects.toMatchObject({ status: 404 });
    const revoked = await service.revoke(context, etsyAccountId);
    expect(revoked).toMatchObject({ status: "revoked", credentialStatus: "revoked", hasCredential: false });
    const credentials = await withTenant(database.db, context, (tx) =>
      tx.select().from(marketplaceCredentials).where(eq(marketplaceCredentials.accountId, etsyAccountId)),
    );
    expect(credentials).toEqual([]);
    await expect(service.withCredential(context, etsyAccountId, async (credential) => credential))
      .rejects.toMatchObject({ status: 401 });
  });

  it("does not release a preserved credential while an account is disabled", async () => {
    await accountService.update(context, amazonAccountId, { enabled: false });
    await expect(service.withCredential(context, amazonAccountId, async (credential) => credential))
      .rejects.toMatchObject({ status: 401 });
    await expect(service.startOAuth(context, amazonAccountId)).rejects.toMatchObject({ status: 409 });
  });
});
