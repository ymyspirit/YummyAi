import process from "node:process";
import { URL, URLSearchParams } from "node:url";

const apiBase = requiredUrl("API_BASE_URL");
const webBase = new URL(process.env.WEB_BASE_URL ?? "http://127.0.0.1:3000");
const authorization = await getAuthorization();

await requireOk(new URL("/health", apiBase), {});

const [research, accounts, competitors] = await Promise.all([
  getJson(new URL("/v1/research-items", apiBase), authorization),
  getJson(new URL("/v1/marketplace-accounts", apiBase), authorization),
  getJson(new URL("/v1/competitor-shops", apiBase), authorization),
]);

const pages = await Promise.all(
  ["/research", "/stores", "/competitors"].map(async (path) => ({
    html: await requireOk(new URL(path, webBase), {}),
    path,
  })),
);

const forbidden = [
  "API_BASE_URL is not configured",
  "尚未配置研究 API",
  "尚未配置店铺 API",
  "尚未配置竞争店铺 API",
];
for (const page of pages) {
  const marker = forbidden.find((entry) => page.html.includes(entry));
  if (marker) throw new Error(`${page.path} rendered a configuration failure: ${marker}`);
}

const researchTotal = numberValue(research.total, "research total");
const researchHtml = pageHtml(pages, "/research");
if (
  researchTotal > 0 &&
  !withoutReactStreamingMarkers(researchHtml).includes(`${researchTotal} RESULTS`)
) {
  throw new Error(
    `/research did not render the API total (${researchTotal}); the Web/API data path is inconsistent`,
  );
}

const accountItems = arrayValue(accounts, "marketplace accounts");
assertSampleRendered(pageHtml(pages, "/stores"), accountItems[0]?.displayName, "/stores");

const competitorItems = arrayValue(competitors.items, "competitor shops");
assertSampleRendered(pageHtml(pages, "/competitors"), competitorItems[0]?.shopName, "/competitors");

process.stdout.write(
  `Local runtime check passed: research=${researchTotal}, stores=${accountItems.length}, ` +
    `competitorShops=${competitorItems.length}.\n`,
);

async function getAuthorization() {
  if (process.env.API_ACCESS_TOKEN?.trim()) {
    return { authorization: `Bearer ${process.env.API_ACCESS_TOKEN.trim()}` };
  }

  const issuer = requiredUrl("OIDC_ISSUER");
  const clientId = required("LOCAL_OIDC_CLIENT_ID");
  const clientSecret = required("LOCAL_OIDC_CLIENT_SECRET");
  const response = await globalThis.fetch(
    new URL("protocol/openid-connect/token", withTrailingSlash(issuer)),
    {
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal: globalThis.AbortSignal.timeout(8_000),
    },
  );
  if (!response.ok) throw new Error(`Local OIDC token request failed (${response.status})`);
  const payload = await response.json();
  if (typeof payload.access_token !== "string") {
    throw new Error("Local OIDC token response did not include an access token");
  }
  return { authorization: `Bearer ${payload.access_token}` };
}

async function getJson(url, headers) {
  const body = await requireOk(url, { headers });
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${url.pathname} did not return valid JSON`);
  }
}

async function requireOk(url, init) {
  let response;
  try {
    response = await globalThis.fetch(url, {
      ...init,
      signal: globalThis.AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw new Error(
      `${url.origin}${url.pathname} is unavailable: ${
        error instanceof Error ? error.message : "request failed"
      }`,
    );
  }
  if (!response.ok) throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  return response.text();
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredUrl(name) {
  const value = required(name);
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

function withTrailingSlash(url) {
  const value = new URL(url);
  if (!value.pathname.endsWith("/")) value.pathname += "/";
  return value;
}

function numberValue(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${label} in API response`);
  }
  return value;
}

function arrayValue(value, label) {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label} API response`);
  return value;
}

function pageHtml(pages, path) {
  const page = pages.find((entry) => entry.path === path);
  if (!page) throw new Error(`Missing page result for ${path}`);
  return page.html;
}

function withoutReactStreamingMarkers(html) {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

function assertSampleRendered(html, value, path) {
  if (value === undefined) return;
  if (typeof value !== "string" || !value) {
    throw new Error(`Invalid sample label returned for ${path}`);
  }
  if (!html.includes(escapeHtml(value))) {
    throw new Error(`${path} did not render an item returned by its API`);
  }
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}
