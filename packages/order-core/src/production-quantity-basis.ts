import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import type { TenantContext } from "@yummyai/contracts";
import { ProductionQuantityBasisSchema, type ProductionQuantityBasis } from "@yummyai/contracts/order/production-quantity";
import type { TenantTransaction } from "@yummyai/database";
import { sql } from "drizzle-orm";

/** The SQL owner supplies the same authoritative projection used by its guards. */
export async function readProductionQuantityBasis(
  tx: TenantTransaction,
  context: TenantContext,
  productionOrderId: string,
): Promise<ProductionQuantityBasis> {
  const [row] = await tx.execute<{ basis: unknown }>(sql`
    select production_quantity_basis(${context.tenantId}::uuid, ${productionOrderId}::uuid) as basis`);
  if (row?.basis === null || row?.basis === undefined)
    throw new OriginalOwnerError(404, { code: "production_quantity_not_found", message: "生产单不存在或无权访问" });
  return ProductionQuantityBasisSchema.parse(row.basis);
}
