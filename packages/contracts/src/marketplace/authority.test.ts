import { describe, expect, it } from "vitest";
import { MarketplaceAuthorityWorkspaceSchema } from "./authority.js";
const id = "019f757a-8029-7e88-88d4-6af588594667";
const time = "2026-10-22T00:00:00.000Z";
const workspace = { version: "erp-store-authority-v1", account: { id, platform: "amazon", displayName: "Synthetic private store",
  externalAccountId: null, region: "NA", marketplaceIds: ["ATVPDKIKX0DER"], authorizationMode: "amazon_private",
  status: "pending_authorization", requestedScopes: [], grantedScopes: [], capabilities: [], credentialStatus: "missing",
  hasCredential: false, healthStatus: "not_checked", lastHealthAt: null, lastCapabilitySyncAt: null, capabilityExpiresAt: null,
  quota: null, lastErrorCode: null, createdAt: time, updatedAt: time },
  lifecycle: { authorizationGeneration: id, credentialVersion: null, useState: "idle", refreshState: "known",
    capabilityGeneration: null, capabilityCurrent: false, pendingOAuthStateDigest: null }, access: { authorize: true, manage: true, sync: false },
  context: { actorId: id, tenantId: id, authority: "a".repeat(64) }, observedAt: time };

describe("store authority transport", () => {
  it("keeps legacy history unverified rather than inventing a capability generation", () => {
    expect(MarketplaceAuthorityWorkspaceSchema.parse(workspace).lifecycle.capabilityCurrent).toBe(false);
  });
  it("rejects credential-bearing fields at every exposed boundary", () => {
    for (const extra of [{ ...workspace, refreshToken: "synthetic" },
      { ...workspace, account: { ...workspace.account, encryptedEnvelope: "synthetic" } },
      { ...workspace, lifecycle: { ...workspace.lifecycle, authorizationHeader: "synthetic" } },
      { ...workspace, context: { ...workspace.context, token: "synthetic" } }])
      expect(MarketplaceAuthorityWorkspaceSchema.safeParse(extra).success).toBe(false);
  });
  it("rejects unknown versions, malformed stamps and impossible credential versions", () => {
    for (const extra of [{ ...workspace, version: "unversioned" },
      { ...workspace, context: { ...workspace.context, authority: "synthetic-token" } },
      { ...workspace, lifecycle: { ...workspace.lifecycle, credentialVersion: 0 } }])
      expect(MarketplaceAuthorityWorkspaceSchema.safeParse(extra).success).toBe(false);
  });
});
