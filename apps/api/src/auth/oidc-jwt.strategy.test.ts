import { generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { OidcJwtStrategy } from "./oidc-jwt.strategy.js";

describe("OIDC JWT strategy", () => {
  const issuer = "https://identity.example.test/realms/yummyai";
  const audience = "yummyai-api";
  let privateKey: CryptoKey;
  let strategy: OidcJwtStrategy;

  beforeAll(async () => {
    const keys = await generateKeyPair("RS256");
    privateKey = keys.privateKey;
    strategy = new OidcJwtStrategy({
      audience,
      issuer,
      verificationKey: keys.publicKey,
    });
  });

  async function token(overrides: { audience?: string; expiresIn?: string } = {}): Promise<string> {
    return new SignJWT({ tenant_id: "019b0000-0000-7000-8000-000000000001" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("keycloak-user")
      .setIssuer(issuer)
      .setAudience(overrides.audience ?? audience)
      .setIssuedAt()
      .setExpirationTime(overrides.expiresIn ?? "5m")
      .sign(privateKey);
  }

  it("accepts a signed token with the configured issuer and audience", async () => {
    await expect(strategy.verify(await token())).resolves.toMatchObject({
      sub: "keycloak-user",
      tenant_id: "019b0000-0000-7000-8000-000000000001",
    });
  });

  it("rejects an expired token", async () => {
    await expect(strategy.verify(await token({ expiresIn: "-1s" }))).rejects.toThrow();
  });

  it("rejects a token for another audience", async () => {
    await expect(strategy.verify(await token({ audience: "another-api" }))).rejects.toThrow();
  });
});
