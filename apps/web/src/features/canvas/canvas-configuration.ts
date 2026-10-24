export function canvasWorkbenchUrl(): string | null {
  const configured = process.env.CANVAS_WORKBENCH_URL ?? (process.env.NODE_ENV === "production" ? undefined : "http://127.0.0.1:4175/canvas?mode=recent");
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) return null;
    return url.href;
  } catch { return null; }
}
