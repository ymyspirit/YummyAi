import { randomBytes } from "node:crypto";

export interface WebOidcConfiguration {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  tokenEndpoint: string;
}

export interface AuthorizationRequest {
  codeVerifier: string;
  state: string;
  url: URL;
}

export function webOidcConfiguration(): WebOidcConfiguration {
  const issuer = required("OIDC_ISSUER").replace(/\/$/, "");
  return {
    authorizationEndpoint: `${issuer}/protocol/openid-connect/auth`,
    clientId: process.env.OIDC_WEB_CLIENT_ID ?? "yummyai-web",
    redirectUri: process.env.OIDC_WEB_REDIRECT_URI ?? "http://localhost:3000/auth/callback",
    scope: "openid profile email",
    tokenEndpoint: `${issuer}/protocol/openid-connect/token`,
  };
}

export async function createAuthorizationRequest(
  configuration = webOidcConfiguration(),
): Promise<AuthorizationRequest> {
  const codeVerifier = randomBytes(32).toString("base64url");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const codeChallenge = Buffer.from(digest).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const url = new URL(configuration.authorizationEndpoint);
  url.search = new URLSearchParams({
    client_id: configuration.clientId,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: configuration.redirectUri,
    response_type: "code",
    scope: configuration.scope,
    state,
  }).toString();
  return { codeVerifier, state, url };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
