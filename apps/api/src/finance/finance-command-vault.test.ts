import { describe, expect, it } from "vitest";
import { createEnvironmentSecretVault } from "@yummyai/ai-core";
import { createProcurementCommandVault } from "../procurement/procurement-command-vault.js";
import { createFinanceCommandVault } from "./finance-command-vault.js";

describe("dedicated retained finance-original encryption", () => {
  it("requires its production key and cannot substitute an existing procurement, model or local secret", () => {
    expect(() => createFinanceCommandVault({ NODE_ENV: "production", LOCAL_OIDC_CLIENT_SECRET: "synthetic-local",
      PROCUREMENT_COMMAND_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64url"), MODEL_PROVIDER_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64url") }))
      .toThrow("FINANCE_COMMAND_ENCRYPTION_KEY is required");
    for (const length of [0, 1, 31, 33]) expect(() => createFinanceCommandVault({ NODE_ENV: "production",
      FINANCE_COMMAND_ENCRYPTION_KEY: Buffer.alloc(length).toString("base64url") })).toThrow();
  });
  it("recovers the exact private UTF8 original across instances while authenticating ciphertext, key and envelope", () => {
    const env = { NODE_ENV: "production", FINANCE_COMMAND_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64url") };
    const plaintext = JSON.stringify({ document: "合成财务原文 \"amount\"", amountMinor: Number.MAX_SAFE_INTEGER, optionalFxUnit: null });
    const encrypted = createFinanceCommandVault(env).encrypt(plaintext);
    expect(encrypted).not.toContain("合成财务原文"); expect(encrypted).not.toContain(String(Number.MAX_SAFE_INTEGER));
    expect(createFinanceCommandVault(env).withSecret(encrypted, value => value)).toBe(plaintext);
    expect(() => createFinanceCommandVault({ ...env, FINANCE_COMMAND_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64url") }).withSecret(encrypted, value => value)).toThrow();
    const parts = encrypted.split("."), ciphertext = Buffer.from(parts[3]!, "base64url"); ciphertext[0] = ciphertext[0]! ^ 1; parts[3] = ciphertext.toString("base64url");
    expect(() => createFinanceCommandVault(env).withSecret(parts.join("."), value => value)).toThrow();
    expect(createFinanceCommandVault(env).withSecret(encrypted, value => value)).toBe(plaintext);
  });
  it("derives development finance keys independently from other domains and never rejects a legal report merely for exceeding one MiB", () => {
    const env = { LOCAL_OIDC_CLIENT_SECRET: "synthetic-local-development-only" }, privateBody = "合成原行".repeat(100_000);
    expect(Buffer.byteLength(privateBody, "utf8")).toBeGreaterThan(1024 * 1024);
    const encrypted = createFinanceCommandVault(env).encrypt(privateBody);
    expect(createFinanceCommandVault(env).withSecret(encrypted, value => value)).toBe(privateBody);
    expect(() => createProcurementCommandVault(env).withSecret(encrypted, value => value)).toThrow();
    const unrelated = createEnvironmentSecretVault("SYNTHETIC_PROVIDER_KEY", "yummyai:synthetic-provider:v1", env);
    expect(() => unrelated.withSecret(encrypted, value => value)).toThrow();
  });
});
