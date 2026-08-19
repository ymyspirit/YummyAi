import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

export const OIDC_JWT_CONFIGURATION = Symbol("OIDC_JWT_CONFIGURATION");
type VerificationKey = CryptoKey | JWTVerifyGetKey;

export interface OidcClaims extends JWTPayload {
  sub: string;
  tenant_id: string;
}

export interface OidcJwtConfiguration {
  audience: string;
  issuer: string;
  jwksUri?: string;
  verificationKey?: VerificationKey;
}

export abstract class TokenVerifier {
  abstract verify(token: string): Promise<OidcClaims>;
}

@Injectable()
export class OidcJwtStrategy extends TokenVerifier {
  readonly #audience: string;
  readonly #issuer: string;
  readonly #verificationKey: VerificationKey;

  constructor(
    @Optional()
    @Inject(OIDC_JWT_CONFIGURATION)
    configuration?: OidcJwtConfiguration,
  ) {
    super();
    const resolved = configuration ?? OidcJwtStrategy.fromEnvironment();
    this.#audience = resolved.audience;
    this.#issuer = resolved.issuer.replace(/\/$/, "");
    this.#verificationKey =
      resolved.verificationKey ??
      createRemoteJWKSet(
        new URL(resolved.jwksUri ?? `${this.#issuer}/protocol/openid-connect/certs`),
      );
  }

  async verify(token: string): Promise<OidcClaims> {
    const options = {
      audience: this.#audience,
      issuer: this.#issuer,
    };
    const { payload } =
      typeof this.#verificationKey === "function"
        ? await jwtVerify(token, this.#verificationKey, options)
        : await jwtVerify(token, this.#verificationKey, options);

    if (typeof payload.sub !== "string" || typeof payload.tenant_id !== "string") {
      throw new Error("OIDC token is missing required subject or tenant claims");
    }

    return payload as OidcClaims;
  }

  static fromEnvironment(): OidcJwtConfiguration {
    const issuer = process.env.OIDC_ISSUER;
    const audience = process.env.OIDC_AUDIENCE;

    if (!issuer || !audience) {
      throw new Error("OIDC_ISSUER and OIDC_AUDIENCE are required");
    }

    return { audience, issuer, jwksUri: process.env.OIDC_JWKS_URI };
  }
}
