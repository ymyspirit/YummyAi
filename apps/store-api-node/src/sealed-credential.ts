import type { KeyObject } from "node:crypto";
import { createHash } from "node:crypto";
import { openStoreNodeSealedCredential, storeNodeAmazonApplication as readAmazonApplication, assertStoreNodeAmazonApplication,
  StoreNodeAmazonApplicationError, type StoreNodeAmazonApplication } from "@yummyai/marketplace-connectors";
import type { StoreNodeExecutionCredential, StoreNodeExecutionLease } from "@yummyai/contracts/marketplace/store-node-execution";
import { nodeCheck, StoreNodeError } from "./error.js";

export type { StoreNodeAmazonApplication } from "@yummyai/marketplace-connectors";
export function storeNodeAmazonApplication(env: NodeJS.ProcessEnv): StoreNodeAmazonApplication | null {
  try { return readAmazonApplication(env); }
  catch (error) { if (error instanceof StoreNodeAmazonApplicationError) throw new StoreNodeError(error.code); throw error; }
}

export interface StoreNodeEtsyApplication { keystring: string; sharedSecret: string }
export function storeNodeEtsyApplication(env: NodeJS.ProcessEnv): StoreNodeEtsyApplication | null {
  const keystring = env.STORE_NODE_ETSY_APP_KEYSTRING?.trim(), sharedSecret = env.STORE_NODE_ETSY_APP_SHARED_SECRET?.trim();
  if (!keystring && !sharedSecret) return null;
  nodeCheck(keystring && sharedSecret && keystring.length <= 16384 && sharedSecret.length <= 16384, "store_node_configuration_invalid");
  return { keystring, sharedSecret };
}
export function openStoreNodeExecutionSeed(lease: StoreNodeExecutionLease, privateKey: KeyObject, etsy: StoreNodeEtsyApplication | null,
  amazonApplication?: StoreNodeAmazonApplication | null): { seed: StoreNodeExecutionCredential; key: Buffer } {
  const opened = openStoreNodeSealedCredential(lease.sealedCredential, lease, privateKey);
  try {
    assertStoreNodeExecutionApplication(opened.payload, etsy, amazonApplication);
    return { seed: opened.payload, key: opened.key };
  } catch (error) { opened.key.fill(0); throw error; }
}
export function assertStoreNodeExecutionApplication(seed: StoreNodeExecutionCredential, etsy: StoreNodeEtsyApplication | null,
  amazonApplication?: StoreNodeAmazonApplication | null): void {
  nodeCheck(["amazon_private", "amazon_public", "etsy_oauth"].includes(seed.account.authorizationMode), "store_node_policy_rejected");
  try { assertStoreNodeAmazonApplication(seed, amazonApplication); }
  catch (error) { if (error instanceof StoreNodeAmazonApplicationError) throw new StoreNodeError(error.code); throw error; }
  if (seed.account.platform === "etsy") nodeCheck(etsy && seed.etsyAppKeySha256 === createHash("sha256").update(etsy.keystring).digest("hex"), "store_node_configuration_invalid");
}
