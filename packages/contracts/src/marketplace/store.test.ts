import { describe, expect, it } from "vitest";

import {
  AmazonPrivateAuthorizationInputSchema,
  CreateMarketplaceAccountInputSchema,
  MarketplaceAccountViewSchema,
  MarketplaceCapabilitySnapshotViewSchema,
  MarketplaceOAuthCompleteInputSchema,
  SyncMarketplaceCapabilitiesInputSchema,
} from "./store.js";

describe("marketplace account contracts", () => {
  it("accepts platform-specific account metadata without credentials", () => {
    const account = CreateMarketplaceAccountInputSchema.parse({
      platform: "etsy",
      displayName: "US Etsy Shop",
      region: "GLOBAL",
      marketplaceIds: ["etsy"],
      authorizationMode: "etsy_oauth",
      requestedScopes: ["listings_r", "listings_w", "shops_r"],
    });
    expect(account.requestedScopes).toContain("listings_w");
  });

  it("rejects mismatched authorization modes and credential-shaped input", () => {
    expect(CreateMarketplaceAccountInputSchema.safeParse({
      platform: "amazon",
      displayName: "Amazon NA",
      region: "NA",
      marketplaceIds: ["ATVPDKIKX0DER"],
      authorizationMode: "etsy_oauth",
    }).success).toBe(false);
    expect(CreateMarketplaceAccountInputSchema.safeParse({
      platform: "etsy",
      displayName: "Etsy",
      region: "GLOBAL",
      marketplaceIds: ["etsy"],
      authorizationMode: "etsy_oauth",
      accessToken: "must-not-enter-metadata",
    }).success).toBe(false);
  });

  it("defines a redacted public account view", () => {
    const view = MarketplaceAccountViewSchema.parse({
      id: "019f757a-8029-7e88-88d4-6af588594667",
      platform: "amazon",
      displayName: "Amazon NA",
      externalAccountId: null,
      region: "NA",
      marketplaceIds: ["ATVPDKIKX0DER"],
      authorizationMode: "amazon_private",
      status: "pending_authorization",
      requestedScopes: [],
      grantedScopes: [],
      capabilities: [],
      credentialStatus: "missing",
      hasCredential: false,
      healthStatus: "not_checked",
      lastHealthAt: null,
      lastCapabilitySyncAt: null,
      capabilityExpiresAt: null,
      lastErrorCode: null,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
    });
    expect(view).not.toHaveProperty("credential");
  });

  it("accepts secrets only through the dedicated Amazon private authorization contract", () => {
    expect(AmazonPrivateAuthorizationInputSchema.parse({
      sellingPartnerId: "A1SELLER",
      clientId: "lwa-client",
      clientSecret: "lwa-secret",
      refreshToken: "Atzr|refresh",
    })).toMatchObject({ sellingPartnerId: "A1SELLER" });
    expect(() => AmazonPrivateAuthorizationInputSchema.parse({
      sellingPartnerId: "A1SELLER",
      clientId: "lwa-client",
      clientSecret: "lwa-secret",
      refreshToken: "Atzr|refresh",
      accessToken: "must-be-rejected",
    })).toThrow();
  });

  it("requires a high-entropy OAuth state and rejects platform token fields", () => {
    expect(MarketplaceOAuthCompleteInputSchema.parse({
      state: "state-value-that-is-longer-than-32-characters",
      code: "one-time-code",
    })).toMatchObject({ code: "one-time-code" });
    expect(() => MarketplaceOAuthCompleteInputSchema.parse({ state: "short", code: "code" })).toThrow();
    expect(() => MarketplaceOAuthCompleteInputSchema.parse({
      state: "state-value-that-is-longer-than-32-characters",
      code: "one-time-code",
      refreshToken: "must-be-rejected",
    })).toThrow();
  });

  it("bounds capability sync fan-out and defines immutable snapshot views", () => {
    expect(SyncMarketplaceCapabilitiesInputSchema.parse({ amazonProductTypes: ["HOME"] })).toEqual({
      amazonProductTypes: ["HOME"],
      etsyTaxonomyNodeIds: [],
      ttlHours: 24,
    });
    expect(() => SyncMarketplaceCapabilitiesInputSchema.parse({
      amazonProductTypes: Array.from({ length: 11 }, (_, index) => `TYPE_${index}`),
    })).toThrow();
    expect(MarketplaceCapabilitySnapshotViewSchema.parse({
      id: "019f757a-8029-7e88-88d4-6af588594667",
      accountId: "019f757a-8029-7e88-88d4-6af588594668",
      version: 1,
      platform: "etsy",
      externalAccountId: "123",
      marketplaceIds: ["etsy"],
      capabilities: ["shop_read", "taxonomy_read"],
      sourceVersion: "etsy-v3",
      sourceChecksum: "sha256-checksum",
      data: { shop: { shop_id: 123 } },
      syncedAt: "2026-07-19T00:00:00.000Z",
      expiresAt: "2026-07-20T00:00:00.000Z",
      stale: false,
    })).toMatchObject({ version: 1, stale: false });
  });
});
