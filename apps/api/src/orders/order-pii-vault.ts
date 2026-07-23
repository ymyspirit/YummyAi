import { createHash } from "node:crypto";

import { SecretVault } from "@yummyai/ai-core";

export function createOrderPiiVault(environment: NodeJS.ProcessEnv = process.env): SecretVault {
  const configured = environment.ORDER_PII_ENCRYPTION_KEY?.trim();
  if (configured) {
    const key = Buffer.from(configured, "base64url");
    if (key.byteLength !== 32) throw new TypeError("ORDER_PII_ENCRYPTION_KEY must encode exactly 32 bytes");
    return new SecretVault(key);
  }
  if (environment.NODE_ENV !== "production" && environment.LOCAL_OIDC_CLIENT_SECRET) {
    return new SecretVault(createHash("sha256").update("yummyai-order-pii-v1\0").update(environment.LOCAL_OIDC_CLIENT_SECRET).digest());
  }
  throw new TypeError("ORDER_PII_ENCRYPTION_KEY is required");
}
