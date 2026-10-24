import { readQualityScrapBasis as sharedreadQualityScrapBasis } from "@yummyai/order-core";
import { originalOwnerOperation } from "../shared/original-owner-error.js";

import type { TenantContext } from "@yummyai/contracts";
import { type QualityScrapBasis } from "@yummyai/contracts/order/quality-scrap";
import type { TenantTransaction } from "@yummyai/database";

/** The database owns lot provenance, physical ancestry and remaining balances. */
export async function readQualityScrapBasis(tx: TenantTransaction, context: Pick<TenantContext, "tenantId">, productionOrderId: string): Promise<QualityScrapBasis> { return originalOwnerOperation(() => sharedreadQualityScrapBasis(tx, context, productionOrderId)); }
