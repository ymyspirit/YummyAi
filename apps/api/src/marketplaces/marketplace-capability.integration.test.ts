import { randomBytes } from "node:crypto";

import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import {
  CreateMarketplaceAccountInputSchema,
  createEntityId,
  type AmazonPrivateAuthorizationInput,
  type TenantContext,
} from "@yummyai/contracts";
import {
  auditEvents,
  connectDatabase,
  marketplaceAccounts,
  marketplaceCapabilitySnapshots,
  marketplaceCredentials,
  migrateDatabase,
  withTenant,
} from "@yummyai/database";
import {
  MarketplaceConnectorError,
  type AuthorizationGrant,
  type AuthorizationRequest,
  type MarketplaceAuthorizationGateway,
  type MarketplaceCapabilityGateway,
  type MarketplaceCapabilitySyncResult,
} from "@yummyai/marketplace-connectors";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { MarketplaceAccountService } from "./marketplace-account.service.js";
import { MarketplaceAuthorizationService } from "./marketplace-authorization.service.js";
import { MarketplaceCapabilityService } from "./marketplace-capability.service.js";

class PrivateAuthorizationGateway implements MarketplaceAuthorizationGateway {
  createAuthorizationRequest(): AuthorizationRequest {
    throw new Error("OAuth is not used by this fixture");
  }

  exchangeAuthorizationCode(): Promise<AuthorizationGrant> {
    throw new Error("OAuth is not used by this fixture");
  }

  verifyAmazonPrivate(input: AmazonPrivateAuthorizationInput, requestedScopes: readonly string[]): Promise<AuthorizationGrant> {
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

class FakeCapabilityGateway implements MarketplaceCapabilityGateway {
  calls = 0;
  error: Error | null = null;
  next: MarketplaceCapabilitySyncResult = capabilityResult();

  sync(): Promise<MarketplaceCapabilitySyncResult> {
    this.calls += 1;
    if (this.error) return Promise.reject(this.error);
    return Promise.resolve(this.next);
  }
}

describe("marketplace capability snapshots", () => {
  const database = connectDatabase();
  const vault = new SecretVault(randomBytes(32));
  const audit = new AuditService(database);
  const authorization = new MarketplaceAuthorizationService(database, vault, new PrivateAuthorizationGateway(), audit);
  const gateway = new FakeCapabilityGateway();
  const service = new MarketplaceCapabilityService(database, vault, gateway, authorization, audit);
  const accountService = new MarketplaceAccountService(database, audit);
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
  let accountId: string;

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, 'Capability tenant', $2), ($3, 'Other capability tenant', $4)`,
      [tenantId, `capability-${tenantId}`, otherTenantId, `other-capability-${otherTenantId}`],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1, $2, $3, 'Capability Admin')`,
      [userId, `capability-${userId}`, `${userId}@example.test`],
    );
    accountId = (await accountService.create(context, CreateMarketplaceAccountInputSchema.parse({
      platform: "amazon",
      displayName: "Amazon capability fixture",
      region: "NA",
      marketplaceIds: ["ATVPDKIKX0DER"],
      authorizationMode: "amazon_private",
      requestedScopes: ["product-listing"],
    }))).id;
    await authorization.authorizeAmazonPrivate(context, accountId, {
      sellingPartnerId: "A1SELLER",
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-secret",
    });
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("creates an immutable tenant-scoped snapshot and activates a healthy account", async () => {
    const snapshot = await service.sync(context, accountId, {
      amazonProductTypes: ["HOME"],
      etsyTaxonomyNodeIds: [],
      ttlHours: 24,
    });
    expect(snapshot).toMatchObject({
      accountId,
      version: 1,
      externalAccountId: "A1SELLER",
      capabilities: expect.arrayContaining(["listing_write", "taxonomy_read"]),
      stale: false,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/client-secret|refresh-secret/);
    const [account] = await withTenant(database.db, context, (tx) =>
      tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, accountId)),
    );
    expect(account).toMatchObject({ status: "active", healthStatus: "healthy" });
    expect(account!.lastCapabilitySyncAt).toBeInstanceOf(Date);
    expect(account!.capabilityExpiresAt).toBeInstanceOf(Date);
    await expect(service.latest(otherContext, accountId)).rejects.toMatchObject({ status: 404 });
    await expect(withTenant(database.db, context, (tx) =>
      tx.update(marketplaceCapabilitySnapshots).set({ sourceVersion: "mutated" })
        .where(eq(marketplaceCapabilitySnapshots.id, snapshot.id)),
    )).rejects.toThrow();
  });

  it("increments snapshot and encrypted credential versions when Etsy-style refresh rotation is returned", async () => {
    gateway.next = {
      ...capabilityResult(),
      refreshedCredential: {
        kind: "amazon_private",
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "rotated-refresh-secret",
        sellingPartnerId: "A1SELLER",
      },
      refreshedCredentialExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000),
    };
    const snapshot = await service.sync(context, accountId, {
      amazonProductTypes: [],
      etsyTaxonomyNodeIds: [],
      ttlHours: 24,
    });
    expect(snapshot.version).toBe(2);
    const [stored] = await withTenant(database.db, context, (tx) =>
      tx.select().from(marketplaceCredentials).where(eq(marketplaceCredentials.accountId, accountId)),
    );
    expect(stored!.version).toBe(2);
    expect(stored!.encryptedEnvelope).not.toContain("rotated-refresh-secret");
    await expect(authorization.withCredential(context, accountId, async (credential) => credential.refreshToken))
      .resolves.toBe("rotated-refresh-secret");
    await expect(service.latest(context, accountId)).resolves.toMatchObject({ version: 2 });
  });

  it("persists degraded evidence without granting write capabilities", async () => {
    gateway.next = {
      ...capabilityResult(),
      capabilities: ["catalog_read", "listing_read"],
      healthStatus: "degraded",
      issues: [{ code: "MARKETPLACE_SUSPENDED", message: "Suspended", severity: "blocker" }],
      data: { participations: [], issues: [{ code: "MARKETPLACE_SUSPENDED" }] },
    };
    const snapshot = await service.sync(context, accountId, {
      amazonProductTypes: [],
      etsyTaxonomyNodeIds: [],
      ttlHours: 24,
    });
    expect(snapshot.version).toBe(3);
    expect(snapshot.capabilities).not.toContain("listing_write");
    const [account] = await withTenant(database.db, context, (tx) =>
      tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, accountId)),
    );
    expect(account).toMatchObject({ status: "degraded", lastErrorCode: "MARKETPLACE_SUSPENDED" });
  });

  it("rejects cross-platform input before connector invocation", async () => {
    const calls = gateway.calls;
    await expect(service.sync(context, accountId, {
      amazonProductTypes: [],
      etsyTaxonomyNodeIds: [42],
      ttlHours: 24,
    })).rejects.toMatchObject({ status: 400 });
    expect(gateway.calls).toBe(calls);
  });

  it("locks the account after an upstream authorization failure without recording another snapshot", async () => {
    gateway.error = new MarketplaceConnectorError("amazon", "authorization", "Expired credential");
    await expect(service.sync(context, accountId, {
      amazonProductTypes: [],
      etsyTaxonomyNodeIds: [],
      ttlHours: 24,
    })).rejects.toMatchObject({ status: 401 });
    const [account] = await withTenant(database.db, context, (tx) =>
      tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, accountId)),
    );
    expect(account).toMatchObject({ status: "revoked", credentialStatus: "revoked", healthStatus: "unauthorized" });
    const snapshots = await withTenant(database.db, context, (tx) =>
      tx.select().from(marketplaceCapabilitySnapshots).where(eq(marketplaceCapabilitySnapshots.accountId, accountId)),
    );
    expect(snapshots).toHaveLength(3);
    const events = await withTenant(database.db, context, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, accountId)),
    );
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "marketplace_capabilities.sync", result: "failure" }),
    ]));
    expect(JSON.stringify(events)).not.toMatch(/client-secret|refresh-secret/);
  });
});

function capabilityResult(): MarketplaceCapabilitySyncResult {
  const syncedAt = new Date();
  return {
    capabilities: ["catalog_read", "taxonomy_read", "listing_read", "listing_write"],
    data: { participations: [{ marketplaceId: "ATVPDKIKX0DER" }], productDefinitions: [] },
    expiresAt: new Date(syncedAt.getTime() + 24 * 60 * 60 * 1_000),
    externalAccountId: "A1SELLER",
    healthStatus: "healthy",
    issues: [],
    marketplaceIds: ["ATVPDKIKX0DER"],
    sourceChecksum: "fixture-checksum",
    sourceVersion: "fixture-v1",
    syncedAt,
  };
}
