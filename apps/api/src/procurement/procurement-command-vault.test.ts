import { describe, expect, it } from "vitest";
import { createEnvironmentSecretVault } from "@yummyai/ai-core";
import { createIncomingCommandVault } from "./incoming-command-vault.js";
import { createProcurementCommandVault } from "./procurement-command-vault.js";

describe("procurement original-input encryption domain", () => {
  it("requires its dedicated production key even when another command domain is configured", () => {
    expect(() => createProcurementCommandVault({ NODE_ENV: "production", LOCAL_OIDC_CLIENT_SECRET: "synthetic-development-only",
      INCOMING_COMMAND_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64url") })).toThrow("PROCUREMENT_COMMAND_ENCRYPTION_KEY is required");
    expect(() => createProcurementCommandVault({ PROCUREMENT_COMMAND_ENCRYPTION_KEY: Buffer.alloc(31).toString("base64url") })).toThrow("must encode exactly 32 bytes");
  });

  it("recovers production ciphertext across instances and rejects a different configured key", () => {
    const environment = { NODE_ENV: "production", PROCUREMENT_COMMAND_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64url") };
    const privateOriginal = "Synthetic private supplier quotation original", encrypted = createProcurementCommandVault(environment).encrypt(privateOriginal);
    expect(encrypted).not.toContain(privateOriginal);
    expect(createProcurementCommandVault(environment).withSecret(encrypted, text => text)).toBe(privateOriginal);
    expect(() => createProcurementCommandVault({ ...environment, PROCUREMENT_COMMAND_ENCRYPTION_KEY: Buffer.alloc(32, 6).toString("base64url") })
      .withSecret(encrypted, text => text)).toThrow();
  });

  it("derives local originals independently from incoming commands and unrelated provider secrets", () => {
    const environment = { LOCAL_OIDC_CLIENT_SECRET: "synthetic-development-only" };
    const encrypted = createProcurementCommandVault(environment).encrypt("Synthetic procurement original");
    expect(createProcurementCommandVault(environment).withSecret(encrypted, text => text)).toBe("Synthetic procurement original");
    expect(() => createIncomingCommandVault(environment).withSecret(encrypted, text => text)).toThrow();
    const providerVault = createEnvironmentSecretVault("SYNTHETIC_PROVIDER_KEY", "yummyai:synthetic-provider:v1", environment);
    expect(() => providerVault.withSecret(encrypted, text => text)).toThrow();
  });
});
