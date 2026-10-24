export function studioRuntimeUrl(env: NodeJS.ProcessEnv = process.env, surface?: "settings"): string | null {
  if (env.NODE_ENV === "production" && !(env.WEB_AUTH_MODE === "personal" && (surface === "settings" || env.CANVAS_STUDIO_PRODUCTION_ENABLED === "1"))) return null;
  try {
    const url = new URL(env.CANVAS_STUDIO_URL || "http://127.0.0.1:4176");
    if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
}
