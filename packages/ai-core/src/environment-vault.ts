import { createHash } from "node:crypto";

import { SecretVault } from "./secrets.js";

export function createEnvironmentSecretVault(
  environmentVariable: string,
  localDomain: string,
  environment: NodeJS.ProcessEnv = process.env,
): SecretVault {
  const configured = environment[environmentVariable]?.trim();
  if (configured) {
    const key = Buffer.from(configured, "base64url");
    if (key.byteLength !== 32) throw new TypeError(`${environmentVariable} must encode exactly 32 bytes`);
    return new SecretVault(key);
  }
  if (environment.NODE_ENV !== "production" && environment.LOCAL_OIDC_CLIENT_SECRET) {
    return new SecretVault(createHash("sha256").update(`${localDomain}\0`).update(environment.LOCAL_OIDC_CLIENT_SECRET).digest());
  }
  throw new TypeError(`${environmentVariable} is required`);
}
