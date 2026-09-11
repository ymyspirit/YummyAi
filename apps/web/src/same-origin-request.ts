/** Next's development server can normalize 127.0.0.1 to localhost in Request.url. */
export function isSameOriginRequest(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin === url.origin) return true;
  if (process.env.NODE_ENV === "production" || !origin) return false;
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  try {
    const client = new URL(origin);
    return loopback.has(url.hostname) && loopback.has(client.hostname)
      && client.protocol === url.protocol && client.port === url.port
      && client.origin === origin && request.headers.get("host") === client.host;
  } catch { return false; }
}
