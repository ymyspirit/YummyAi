import process from "node:process";
import { URL } from "node:url";

const missing = [];

if (!process.env.API_BASE_URL?.trim()) missing.push("API_BASE_URL");
const factory = process.env.FACTORY_PORTAL_ONLY === "1",
  mode = process.env.WEB_AUTH_MODE ?? "personal",
  production = process.argv.includes("--production") || process.env.NODE_ENV === "production";
if (
  !factory &&
  (!["personal", "local-service"].includes(mode) || (mode === "local-service" && production))
) {
  process.stderr.write(
    "Web startup blocked: production requires personal authentication; invalid development mode.\n",
  );
  process.exit(1);
}
if (factory || mode === "personal") {
  for (const name of [
    "OIDC_ISSUER",
    "OIDC_AUDIENCE",
    "REDIS_URL",
    ...(factory
      ? ["FACTORY_PORTAL_ORIGIN", "FACTORY_OIDC_CLIENT_ID", "FACTORY_SESSION_ENCRYPTION_KEY"]
      : ["WEB_ORIGIN", "OIDC_WEB_CLIENT_ID", "ERP_SESSION_ENCRYPTION_KEY"]),
  ])
    if (!process.env[name]?.trim()) missing.push(name);
  const keyName = factory ? "FACTORY_SESSION_ENCRYPTION_KEY" : "ERP_SESSION_ENCRYPTION_KEY",
    key = process.env[keyName];
  if (key && !/^[A-Za-z0-9_-]{43}$/.test(key)) {
    process.stderr.write(
      `Web startup blocked: ${keyName} must be an independent 32-byte base64url value.\n`,
    );
    process.exit(1);
  }
  if (
    process.env.ERP_SESSION_ENCRYPTION_KEY &&
    process.env.ERP_SESSION_ENCRYPTION_KEY === process.env.FACTORY_SESSION_ENCRYPTION_KEY
  ) {
    process.stderr.write("Web startup blocked: ERP and factory session keys must differ.\n");
    process.exit(1);
  }
} else if (!process.env.API_ACCESS_TOKEN?.trim()) {
  for (const name of ["OIDC_ISSUER", "LOCAL_OIDC_CLIENT_ID", "LOCAL_OIDC_CLIENT_SECRET"]) {
    if (!process.env[name]?.trim()) missing.push(name);
  }
}

if (missing.length > 0) {
  process.stderr.write(
    `Web startup blocked: missing server environment variable(s): ${missing.join(", ")}. ` +
      "Start from the workspace root with pnpm dev or pnpm dev:web.\n",
  );
  process.exit(1);
}

for (const name of [
  "API_BASE_URL",
  "OIDC_ISSUER",
  ...(factory || mode === "personal" ? [factory ? "FACTORY_PORTAL_ORIGIN" : "WEB_ORIGIN"] : []),
]) {
  const value = process.env[name];
  if (!value) continue;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error("unsupported URL");
    if (
      name !== "API_BASE_URL" &&
      (factory || mode === "personal") &&
      url.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw Error("Untrusted identity URL");
    if (name.endsWith("ORIGIN") && url.pathname !== "/") throw Error("Origin must not have a path");
  } catch {
    process.stderr.write(`Web startup blocked: ${name} must be a valid HTTP(S) URL.\n`);
    process.exit(1);
  }
}

process.stdout.write("Web environment preflight passed.\n");
