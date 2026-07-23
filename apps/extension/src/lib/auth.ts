export interface ExtensionIdentityApi {
  getRedirectURL(path?: string): string;
  launchWebAuthFlow(details: { interactive: boolean; url: string }): Promise<string | undefined>;
}

export interface ExtensionAuthResult {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface ExtensionAccessToken {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
}

export async function authenticateExtension(
  identity: ExtensionIdentityApi,
  options: { authorizationEndpoint: string; clientId?: string },
): Promise<ExtensionAuthResult> {
  const redirectUri = identity.getRedirectURL("oidc");
  const codeVerifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
  const challengeBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  const authorizationUrl = new URL(options.authorizationEndpoint);
  authorizationUrl.search = new URLSearchParams({
    client_id: options.clientId ?? "yummyai-extension",
    code_challenge: base64Url(new Uint8Array(challengeBytes)),
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email",
    state,
  }).toString();

  const callback = await identity.launchWebAuthFlow({ interactive: true, url: authorizationUrl.href });
  if (!callback) throw new Error("OIDC authorization was cancelled");
  const callbackUrl = new URL(callback);
  if (callbackUrl.searchParams.get("state") !== state) throw new Error("OIDC state mismatch");
  const code = callbackUrl.searchParams.get("code");
  if (!code) throw new Error(callbackUrl.searchParams.get("error") ?? "OIDC code is missing");

  return { code, codeVerifier, redirectUri };
}

export async function exchangeExtensionCode(
  result: ExtensionAuthResult,
  options: { tokenEndpoint: string; clientId?: string },
): Promise<ExtensionAccessToken> {
  const response = await fetch(options.tokenEndpoint, {
    body: new URLSearchParams({
      client_id: options.clientId ?? "yummyai-extension",
      code: result.code,
      code_verifier: result.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: result.redirectUri,
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return parseTokenResponse(response);
}

export async function refreshExtensionAccessToken(
  refreshToken: string,
  options: { tokenEndpoint: string; clientId?: string },
): Promise<ExtensionAccessToken> {
  const response = await fetch(options.tokenEndpoint, {
    body: new URLSearchParams({
      client_id: options.clientId ?? "yummyai-extension",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return parseTokenResponse(response);
}

async function parseTokenResponse(response: Response): Promise<ExtensionAccessToken> {
  const payload = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    expires_in?: unknown;
    refresh_token?: unknown;
    error_description?: unknown;
  } | null;
  if (!response.ok || typeof payload?.access_token !== "string") {
    const detail =
      typeof payload?.error_description === "string" ? `：${payload.error_description}` : "";
    throw new Error(`扩展登录失败 (${response.status})${detail}`);
  }
  const expiresIn =
    typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : 60;
  return {
    accessToken: payload.access_token,
    expiresAt: Date.now() + expiresIn * 1_000,
    ...(typeof payload.refresh_token === "string" ? { refreshToken: payload.refresh_token } : {}),
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
