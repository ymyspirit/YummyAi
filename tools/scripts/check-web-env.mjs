import process from "node:process";
import { URL } from "node:url";

const missing = [];

if (!process.env.API_BASE_URL?.trim()) missing.push("API_BASE_URL");

if (!process.env.API_ACCESS_TOKEN?.trim()) {
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

for (const name of ["API_BASE_URL", "OIDC_ISSUER"]) {
  const value = process.env[name];
  if (!value) continue;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported protocol");
  } catch {
    process.stderr.write(`Web startup blocked: ${name} must be a valid HTTP(S) URL.\n`);
    process.exit(1);
  }
}

process.stdout.write("Web environment preflight passed.\n");
