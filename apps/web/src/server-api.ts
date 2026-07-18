interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | undefined;
let tokenRequest: Promise<CachedToken> | undefined;

export async function getApiHeaders(
  options: { forceRefresh?: boolean } = {},
): Promise<Record<string, string>> {
  if (process.env.API_ACCESS_TOKEN) {
    return { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}` };
  }

  const now = Date.now();
  if (!options.forceRefresh && cachedToken && cachedToken.expiresAt > now + 30_000) {
    return { authorization: `Bearer ${cachedToken.accessToken}` };
  }

  if (!tokenRequest) tokenRequest = requestApiToken(now);
  try {
    cachedToken = await tokenRequest;
  } finally {
    tokenRequest = undefined;
  }
  return { authorization: `Bearer ${cachedToken.accessToken}` };
}

export async function apiFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  let response = await fetchWithApiToken(url, init);
  if (response.status !== 401 || process.env.API_ACCESS_TOKEN) return response;

  cachedToken = undefined;
  response = await fetchWithApiToken(url, init, true);
  return response;
}

async function fetchWithApiToken(
  url: string | URL,
  init: RequestInit,
  forceRefresh = false,
): Promise<Response> {
  const headers = new Headers(init.headers);
  const authorization = await getApiHeaders({ forceRefresh });
  for (const [name, value] of Object.entries(authorization)) headers.set(name, value);
  return fetch(url, { ...init, headers });
}

async function requestApiToken(now: number): Promise<CachedToken> {
  const issuer = required("OIDC_ISSUER").replace(/\/$/, "");
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    body: new URLSearchParams({
      client_id: required("LOCAL_OIDC_CLIENT_ID"),
      client_secret: required("LOCAL_OIDC_CLIENT_SECRET"),
      grant_type: "client_credentials",
    }),
    cache: "no-store",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`OIDC token request failed (${response.status})`);
  }
  const payload = (await response.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof payload.access_token !== "string") {
    throw new Error("OIDC token response did not contain an access token");
  }

  const expiresIn =
    typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : 60;
  return {
    accessToken: payload.access_token,
    expiresAt: now + expiresIn * 1_000,
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
