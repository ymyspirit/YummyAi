import { describe, expect, it } from "vitest";

import { createMarketplaceSecretVault } from "./marketplace-secret-vault.js";

describe("marketplace secret vault configuration", () => {
  it("accepts an explicit 32-byte base64url key", () => {
    const vault = createMarketplaceSecretVault({
      NODE_ENV: "production",
      MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
    });
    const encrypted = vault.encrypt("marketplace-secret");
    expect(encrypted).not.toContain("marketplace-secret");
    expect(vault.withSecret(encrypted, (secret) => secret)).toBe("marketplace-secret");
  });

  it("fails closed in production without a dedicated encryption key", () => {
    expect(() => createMarketplaceSecretVault({ NODE_ENV: "production" })).toThrow(
      "MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY is required",
    );
  });

  it("derives a stable local-only key from the existing local client secret", () => {
    const first = createMarketplaceSecretVault({ NODE_ENV: "development", LOCAL_OIDC_CLIENT_SECRET: "local-only" });
    const second = createMarketplaceSecretVault({ NODE_ENV: "development", LOCAL_OIDC_CLIENT_SECRET: "local-only" });
    const encrypted = first.encrypt("local-marketplace-secret");
    expect(second.withSecret(encrypted, (secret) => secret)).toBe("local-marketplace-secret");
  });
});
