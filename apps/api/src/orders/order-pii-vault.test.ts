import { describe, expect, it } from "vitest";

import { createOrderPiiVault } from "./order-pii-vault.js";

describe("order PII vault", () => {
  it("accepts a dedicated 32-byte production key", () => {
    const vault = createOrderPiiVault({ NODE_ENV: "production", ORDER_PII_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64url") });
    const encrypted = vault.encrypt("buyer@example.test");
    expect(encrypted).not.toContain("buyer@example.test");
    expect(vault.withSecret(encrypted, (value) => value)).toBe("buyer@example.test");
  });

  it("fails closed in production without the dedicated key", () => {
    expect(() => createOrderPiiVault({ NODE_ENV: "production" })).toThrow("ORDER_PII_ENCRYPTION_KEY is required");
  });

  it("uses a stable domain-separated local key", () => {
    const first = createOrderPiiVault({ NODE_ENV: "development", LOCAL_OIDC_CLIENT_SECRET: "local-only" });
    const second = createOrderPiiVault({ NODE_ENV: "development", LOCAL_OIDC_CLIENT_SECRET: "local-only" });
    const encrypted = first.encrypt("protected");
    expect(second.withSecret(encrypted, (value) => value)).toBe("protected");
  });
});
