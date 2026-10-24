import { describe, expect, it } from "vitest";
import { createEnvironmentSecretVault } from "@yummyai/ai-core";
import { createIncomingCommandVault } from "./incoming-command-vault.js";

describe("incoming original-input encryption domain", () => {
  it("requires a dedicated production key and rejects invalid key lengths", () => {
    expect(() => createIncomingCommandVault({ NODE_ENV: "production", LOCAL_OIDC_CLIENT_SECRET: "synthetic-local-only" })).toThrow("INCOMING_COMMAND_ENCRYPTION_KEY is required");
    expect(() => createIncomingCommandVault({ INCOMING_COMMAND_ENCRYPTION_KEY: Buffer.alloc(31).toString("base64url") })).toThrow("must encode exactly 32 bytes");
  });
  it("recovers with the configured key and cannot use another local domain", () => {
    const environment = { LOCAL_OIDC_CLIENT_SECRET: "synthetic-development-only" };
    const encrypted = createIncomingCommandVault(environment).encrypt("synthetic original");
    expect(createIncomingCommandVault(environment).withSecret(encrypted, text => text)).toBe("synthetic original");
    const unrelated = createEnvironmentSecretVault("OTHER_KEY", "yummyai:unrelated-domain", environment);
    expect(() => unrelated.withSecret(encrypted, text => text)).toThrow();
    const production = { NODE_ENV: "production", INCOMING_COMMAND_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64url") };
    const original = createIncomingCommandVault(production).encrypt("synthetic production input");
    expect(createIncomingCommandVault(production).withSecret(original, text => text)).toBe("synthetic production input");
  });
});
