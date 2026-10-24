import { readProductionQuantityBasis as sharedreadProductionQuantityBasis } from "@yummyai/order-core";
import { originalOwnerOperation } from "../shared/original-owner-error.js";

import type { TenantContext } from "@yummyai/contracts";
import { type ProductionQuantityBasis } from "@yummyai/contracts/order/production-quantity";
import type { TenantTransaction } from "@yummyai/database";

/** The SQL owner supplies the same authoritative projection used by its guards. */
export async function readProductionQuantityBasis(
  tx: TenantTransaction,
  context: TenantContext,
  productionOrderId: string,
): Promise<ProductionQuantityBasis> { return originalOwnerOperation(() => sharedreadProductionQuantityBasis(tx, context, productionOrderId)); }
