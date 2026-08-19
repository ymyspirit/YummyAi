import type {
  AmazonPrivateAuthorizationInput,
  MarketplaceAuthorizationMode,
  MarketplacePlatform,
  MarketplaceRegion,
} from "@yummyai/contracts";
import { z } from "zod";

export interface AuthorizationAccountContext {
  authorizationMode: MarketplaceAuthorizationMode;
  platform: MarketplacePlatform;
  region: MarketplaceRegion;
  requestedScopes: readonly string[];
}

export interface AuthorizationGrant {
  credential: Readonly<Record<string, string>>;
  externalAccountId: string;
  expiresAt: Date | null;
  grantedScopes: readonly string[];
}

export interface OAuthExchangeInput {
  code: string;
  pkceVerifier: string | null;
  redirectUri: string;
  sellingPartnerId?: string;
}

export interface AuthorizationRequest {
  authorizationUrl: string;
  redirectUri: string;
}

export interface MarketplaceAuthorizationGateway {
  createAuthorizationRequest(
    account: AuthorizationAccountContext,
    state: string,
    pkceChallenge: string | null,
  ): AuthorizationRequest;
  exchangeAuthorizationCode(
    account: AuthorizationAccountContext,
    input: OAuthExchangeInput,
  ): Promise<AuthorizationGrant>;
  verifyAmazonPrivate(input: AmazonPrivateAuthorizationInput, requestedScopes: readonly string[]): Promise<AuthorizationGrant>;
}

export class MarketplaceAuthorizationError extends Error {
  constructor(
    readonly code: "configuration" | "rejected" | "upstream",
    message: string,
  ) {
    super(message);
    this.name = "MarketplaceAuthorizationError";
  }
}

export class HttpMarketplaceAuthorizationGateway implements MarketplaceAuthorizationGateway {
  createAuthorizationRequest(
    account: AuthorizationAccountContext,
    state: string,
    pkceChallenge: string | null,
  ): AuthorizationRequest {
    return account.platform === "etsy"
      ? this.createEtsyRequest(account, state, requireValue(pkceChallenge, "Etsy PKCE challenge"))
      : this.createAmazonRequest(account, state);
  }

  async exchangeAuthorizationCode(
    account: AuthorizationAccountContext,
    input: OAuthExchangeInput,
  ): Promise<AuthorizationGrant> {
    return account.platform === "etsy"
      ? this.exchangeEtsy(account, input)
      : this.exchangeAmazon(account, input);
  }

  async verifyAmazonPrivate(
    input: AmazonPrivateAuthorizationInput,
    requestedScopes: readonly string[],
  ): Promise<AuthorizationGrant> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    });
    await requestToken("https://api.amazon.com/auth/o2/token", body, AmazonTokenResponseSchema);
    return {
      credential: {
        kind: "amazon_private",
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        refreshToken: input.refreshToken,
        sellingPartnerId: input.sellingPartnerId,
      },
      externalAccountId: input.sellingPartnerId,
      expiresAt: null,
      grantedScopes: requestedScopes,
    };
  }

  private createEtsyRequest(
    account: AuthorizationAccountContext,
    state: string,
    pkceChallenge: string,
  ): AuthorizationRequest {
    const clientId = requiredEnvironment("ETSY_APP_KEYSTRING");
    requiredEnvironment("ETSY_APP_SHARED_SECRET");
    const redirectUri = requireHttpsUrl("ETSY_OAUTH_REDIRECT_URI");
    const url = new URL("https://www.etsy.com/oauth/connect");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: account.requestedScopes.join(" "),
      state,
      code_challenge: pkceChallenge,
      code_challenge_method: "S256",
    }).toString();
    return { authorizationUrl: url.toString(), redirectUri };
  }

  private createAmazonRequest(account: AuthorizationAccountContext, state: string): AuthorizationRequest {
    const applicationId = requiredEnvironment("AMAZON_SPAPI_APPLICATION_ID");
    requiredEnvironment("AMAZON_SPAPI_LWA_CLIENT_ID");
    requiredEnvironment("AMAZON_SPAPI_LWA_CLIENT_SECRET");
    const redirectUri = requireHttpsUrl("AMAZON_SPAPI_OAUTH_REDIRECT_URI");
    const base = requireHttpsUrl(`AMAZON_SPAPI_AUTH_BASE_URL_${account.region}`);
    const url = new URL("/apps/authorize/consent", `${base}/`);
    url.searchParams.set("application_id", applicationId);
    url.searchParams.set("state", state);
    if (process.env.AMAZON_SPAPI_APP_DRAFT === "1") url.searchParams.set("version", "beta");
    return { authorizationUrl: url.toString(), redirectUri };
  }

  private async exchangeEtsy(
    account: AuthorizationAccountContext,
    input: OAuthExchangeInput,
  ): Promise<AuthorizationGrant> {
    const clientId = requiredEnvironment("ETSY_APP_KEYSTRING");
    const verifier = requireValue(input.pkceVerifier, "Etsy PKCE verifier");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: input.redirectUri,
      code: input.code,
      code_verifier: verifier,
    });
    const token = await requestToken("https://api.etsy.com/v3/public/oauth/token", body, EtsyTokenResponseSchema);
    const userId = token.access_token.split(".", 1)[0];
    if (!userId || !/^\d+$/.test(userId)) throw new MarketplaceAuthorizationError("upstream", "Etsy token identity is invalid");
    return {
      credential: { kind: "etsy_oauth", refreshToken: token.refresh_token, userId },
      externalAccountId: userId,
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000),
      grantedScopes: account.requestedScopes,
    };
  }

  private async exchangeAmazon(
    account: AuthorizationAccountContext,
    input: OAuthExchangeInput,
  ): Promise<AuthorizationGrant> {
    const sellingPartnerId = requireValue(input.sellingPartnerId, "Amazon selling partner ID");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: requiredEnvironment("AMAZON_SPAPI_LWA_CLIENT_ID"),
      client_secret: requiredEnvironment("AMAZON_SPAPI_LWA_CLIENT_SECRET"),
    });
    const token = await requestToken("https://api.amazon.com/auth/o2/token", body, AmazonTokenResponseSchema);
    if (!token.refresh_token) throw new MarketplaceAuthorizationError("upstream", "Amazon did not return a refresh token");
    return {
      credential: { kind: "amazon_public", refreshToken: token.refresh_token, sellingPartnerId },
      externalAccountId: sellingPartnerId,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000),
      grantedScopes: account.requestedScopes,
    };
  }
}

const AmazonTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().min(1),
}).passthrough();

const EtsyTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1),
  token_type: z.string().min(1),
}).passthrough();

async function requestToken<T>(url: string, body: URLSearchParams, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new MarketplaceAuthorizationError("upstream", "Marketplace authorization server is unavailable");
  }
  if (!response.ok) {
    throw new MarketplaceAuthorizationError(
      response.status === 400 || response.status === 401 || response.status === 403 ? "rejected" : "upstream",
      "Marketplace authorization was rejected",
    );
  }
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new MarketplaceAuthorizationError("upstream", "Marketplace token response is invalid");
  return parsed.data;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new MarketplaceAuthorizationError("configuration", `${name} is not configured`);
  return value;
}

function requireHttpsUrl(name: string): string {
  const value = requiredEnvironment(name);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MarketplaceAuthorizationError("configuration", `${name} must be a valid URL`);
  }
  if (url.protocol !== "https:") throw new MarketplaceAuthorizationError("configuration", `${name} must use HTTPS`);
  return url.toString().replace(/\/$/, "");
}

function requireValue(value: string | null | undefined, label: string): string {
  if (!value) throw new MarketplaceAuthorizationError("configuration", `${label} is required`);
  return value;
}
