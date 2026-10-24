import { readVerifiedManufacturingBasis as sharedReadVerifiedManufacturingBasis, readManufacturingDelivery as sharedReadManufacturingDelivery } from "@yummyai/order-core";
import { originalOwnerOperation } from "../shared/original-owner-error.js";

import { type TenantTransaction } from "@yummyai/database";

/** Internal order-owner read, called only after the enclosing order or assigned-factory scope is authorized. */
export async function readVerifiedManufacturingBasis(tx: TenantTransaction, productionVersionId: string) { return originalOwnerOperation(() => sharedReadVerifiedManufacturingBasis(tx, productionVersionId)); }

export async function readManufacturingDelivery(tx: TenantTransaction, productionVersionId: string) { return originalOwnerOperation(() => sharedReadManufacturingDelivery(tx, productionVersionId)); }

