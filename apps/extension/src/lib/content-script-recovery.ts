const AMAZON_MARKETPLACES = [
  "amazon.com",
  "amazon.co.uk",
  "amazon.ca",
  "amazon.de",
  "amazon.fr",
  "amazon.it",
  "amazon.es",
  "amazon.co.jp",
] as const;

export function contentScriptFileForUrl(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;

  const hostname = url.hostname.toLowerCase();
  if (
    AMAZON_MARKETPLACES.some(
      (marketplace) => hostname === marketplace || hostname.endsWith(`.${marketplace}`),
    )
  ) {
    return "content-scripts/amazon.js";
  }
  if (
    (hostname === "etsy.com" || hostname.endsWith(".etsy.com")) &&
    /^\/(listing|shop)(\/|$)/.test(url.pathname)
  ) {
    return "content-scripts/etsy.js";
  }
  return null;
}

export function isMissingContentScriptConnection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.toLowerCase().includes("could not establish connection") ||
    message.toLowerCase().includes("receiving end does not exist")
  );
}
