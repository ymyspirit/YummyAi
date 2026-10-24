/** Next can normalize a literal loopback host in Request.url. Production requires the configured browser origin. */
export function isSameOriginRequest(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin === url.origin) return true;
  if (!origin) return false;
  if (process.env.NODE_ENV === "production") {
    const configured = process.env.FACTORY_PORTAL_ONLY === "1"
      ? process.env.FACTORY_PORTAL_ORIGIN
      : process.env.WEB_ORIGIN;
    if (!configured || configured !== origin) return false;
  }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  try {
    const client = new URL(origin);
    return loopback.has(url.hostname) && loopback.has(client.hostname)
      && client.protocol === url.protocol && client.port === url.port
      && client.origin === origin && request.headers.get("host") === client.host;
  } catch { return false; }
}
