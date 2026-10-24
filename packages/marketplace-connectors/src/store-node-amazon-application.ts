import { createHash } from "node:crypto";
import type { StoreNodeExecutionCredential } from "@yummyai/contracts/marketplace/store-node-execution";

/** Public application secrets belong to the node startup configuration, never the seed. */
export interface StoreNodeAmazonApplication { clientId: string; clientSecret: string }
export class StoreNodeAmazonApplicationError extends Error {
  constructor(readonly code: "store_node_configuration_invalid" | "store_node_application_reauthorization_required") {
    super(code);
    this.name = "StoreNodeAmazonApplicationError";
  }
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export function storeNodeAmazonApplication(env: Readonly<Record<string, string | undefined>>): StoreNodeAmazonApplication | null {
  const clientId = env.STORE_NODE_AMAZON_APP_CLIENT_ID?.trim(), clientSecret = env.STORE_NODE_AMAZON_APP_CLIENT_SECRET?.trim();
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret || clientId.length > 16384 || clientSecret.length > 16384)
    throw new StoreNodeAmazonApplicationError("store_node_configuration_invalid");
  return Object.freeze({ clientId, clientSecret });
}

/** An old token without its original OAuth application pin cannot gain one from today's env. */
export function assertStoreNodeAmazonCredentialBinding(seed: StoreNodeExecutionCredential): void {
  if (seed.account.authorizationMode !== "amazon_public") return;
  if (seed.account.platform !== "amazon" || seed.credential.kind !== "amazon_public" || !seed.credential.clientId
    || !seed.credential.refreshToken || !seed.credential.sellingPartnerId
    || seed.credential.sellingPartnerId !== seed.account.externalAccountId
    || !seed.amazonAppClientIdSha256 || !/^[a-f0-9]{64}$/.test(seed.amazonAppClientIdSha256)
    || sha(seed.credential.clientId) !== seed.amazonAppClientIdSha256)
    throw new StoreNodeAmazonApplicationError("store_node_application_reauthorization_required");
}

/** Only new provider I/O requires local application availability; receipt recovery does not. */
export function assertStoreNodeAmazonApplication(seed: StoreNodeExecutionCredential, amazonApplication?: StoreNodeAmazonApplication | null): void {
  if (seed.account.authorizationMode !== "amazon_public") return;
  assertStoreNodeAmazonCredentialBinding(seed);
  if (!amazonApplication?.clientId || !amazonApplication.clientSecret || amazonApplication.clientId.length > 16384
    || amazonApplication.clientSecret.length > 16384 || sha(amazonApplication.clientId) !== seed.amazonAppClientIdSha256)
    throw new StoreNodeAmazonApplicationError("store_node_configuration_invalid");
}

/** Explicit constructor injection into the original gateways; no process-wide fallback. */
export function storeNodeAmazonGatewayEnvironment(seed: StoreNodeExecutionCredential, amazonApplication?: StoreNodeAmazonApplication | null): Record<string, string> {
  if (seed.account.authorizationMode !== "amazon_public") return {};
  assertStoreNodeAmazonApplication(seed, amazonApplication);
  return { AMAZON_SPAPI_LWA_CLIENT_ID: amazonApplication!.clientId, AMAZON_SPAPI_LWA_CLIENT_SECRET: amazonApplication!.clientSecret };
}
