interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | undefined;

export async function getApiHeaders(): Promise<Record<string, string>> {
  if (process.env.API_ACCESS_TOKEN) {
    return { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}` };
  }

  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 30_000) {
    return { authorization: `Bearer ${cachedToken.accessToken}` };
  }

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
  cachedToken = {
    accessToken: payload.access_token,
    expiresAt: now + expiresIn * 1_000,
  };
  return { authorization: `Bearer ${cachedToken.accessToken}` };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
