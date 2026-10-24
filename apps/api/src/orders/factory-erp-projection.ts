import { factoryErpProgress as sharedfactoryErpProgress } from "@yummyai/order-core";
import { originalOwnerOperation } from "../shared/original-owner-error.js";
import type { SecretVault } from "@yummyai/ai-core";
import { type TenantTransaction } from "@yummyai/database";

/** Call under current order/PII authority. Ordering is our observation sequence;
 * raw factory local dates never become UTC timestamps or ordering authority. */
export async function factoryErpProgress(tx: TenantTransaction, vault: SecretVault, deliveryItemId: string) { return originalOwnerOperation(() => sharedfactoryErpProgress(tx, vault, deliveryItemId)); }
