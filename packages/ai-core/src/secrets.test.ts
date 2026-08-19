import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SecretVault, redactSecrets } from "./secrets.js";

describe("SecretVault", () => {
  it("encrypts authenticated secret envelopes and only reveals plaintext inside a callback", () => {
    const vault = new SecretVault(randomBytes(32));
    const encrypted = vault.encrypt("sk-private-value");
    expect(encrypted).not.toContain("sk-private-value");
    expect(vault.withSecret(encrypted, (secret) => secret)).toBe("sk-private-value");
  });

  it("redacts nested credentials", () => {
    expect(redactSecrets({ provider: "openai", nested: { apiKey: "secret" }, authorization: "Bearer secret" })).toEqual({
      provider: "openai",
      nested: { apiKey: "[REDACTED]" },
      authorization: "[REDACTED]",
    });
  });
});
