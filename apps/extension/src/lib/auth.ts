export interface ExtensionIdentityApi {
  getRedirectURL(path?: string): string;
  launchWebAuthFlow(details: { interactive: boolean; url: string }): Promise<string | undefined>;
}

export interface ExtensionAuthResult {
  code: string;
  codeVerifier: string;
  redirectUri: string;
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

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
