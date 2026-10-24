import { describe, expect, it } from "vitest";
import { createEnvironmentSecretVault } from "@yummyai/ai-core";
import { createProcurementCommandVault } from "../procurement/procurement-command-vault.js";
import { createAdvertisingCommandVault } from "./advertising-command-vault.js";
import { createFinanceCommandVault } from "../finance/finance-command-vault.js";

describe("dedicated retained advertising-original encryption", () => {
  it("requires its production key and cannot substitute an existing procurement, model or local secret", () => {
    expect(() => createAdvertisingCommandVault({ NODE_ENV: "production", LOCAL_OIDC_CLIENT_SECRET: "synthetic-local",
      PROCUREMENT_COMMAND_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64url"), MODEL_PROVIDER_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64url") }))
      .toThrow("ADVERTISING_COMMAND_ENCRYPTION_KEY is required");
    for (const length of [0, 1, 31, 33]) expect(() => createAdvertisingCommandVault({ NODE_ENV: "production",
      ADVERTISING_COMMAND_ENCRYPTION_KEY: Buffer.alloc(length).toString("base64url") })).toThrow();
  });
  it("recovers the exact private UTF8 original across instances while authenticating ciphertext, key and envelope", () => {
    const env = { NODE_ENV: "production", ADVERTISING_COMMAND_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64url") };
    const plaintext = JSON.stringify({ document: "合成广告原文 \"amount\"", amountMinor: Number.MAX_SAFE_INTEGER, optionalFxUnit: null });
    const encrypted = createAdvertisingCommandVault(env).encrypt(plaintext);
    expect(encrypted).not.toContain("合成广告原文"); expect(encrypted).not.toContain(String(Number.MAX_SAFE_INTEGER));
    expect(createAdvertisingCommandVault(env).withSecret(encrypted, value => value)).toBe(plaintext);
    expect(() => createAdvertisingCommandVault({ ...env, ADVERTISING_COMMAND_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64url") }).withSecret(encrypted, value => value)).toThrow();
    const parts = encrypted.split("."), ciphertext = Buffer.from(parts[3]!, "base64url"); ciphertext[0] = ciphertext[0]! ^ 1; parts[3] = ciphertext.toString("base64url");
    expect(() => createAdvertisingCommandVault(env).withSecret(parts.join("."), value => value)).toThrow();
    expect(createAdvertisingCommandVault(env).withSecret(encrypted, value => value)).toBe(plaintext);
  });
  it("derives development advertising keys independently from other domains and never rejects a legal report merely for exceeding one MiB", () => {
    const env = { LOCAL_OIDC_CLIENT_SECRET: "synthetic-local-development-only" }, privateBody = "合成原行".repeat(100_000);
    expect(Buffer.byteLength(privateBody, "utf8")).toBeGreaterThan(1024 * 1024);
    const encrypted = createAdvertisingCommandVault(env).encrypt(privateBody);
    expect(createAdvertisingCommandVault(env).withSecret(encrypted, value => value)).toBe(privateBody);
    expect(() => createProcurementCommandVault(env).withSecret(encrypted, value => value)).toThrow();
    expect(() => createFinanceCommandVault(env).withSecret(encrypted, value => value)).toThrow();
    const unrelated = createEnvironmentSecretVault("SYNTHETIC_PROVIDER_KEY", "yummyai:synthetic-provider:v1", env);
    expect(() => unrelated.withSecret(encrypted, value => value)).toThrow();
  });
  it("rejects reusing the same explicit key from another production encryption domain even with different base64 spelling",()=>{
    const key=Buffer.alloc(32,9);
    for(const name of["FINANCE_COMMAND_ENCRYPTION_KEY","PROCUREMENT_COMMAND_ENCRYPTION_KEY","ORDER_PII_ENCRYPTION_KEY","MODEL_PROVIDER_ENCRYPTION_KEY","INTEGRATION_SECRET_ENCRYPTION_KEY"])
      expect(()=>createAdvertisingCommandVault({NODE_ENV:"production",ADVERTISING_COMMAND_ENCRYPTION_KEY:key.toString("base64url"),[name]:key.toString("base64")})).toThrow("must be independent");
  });
});
