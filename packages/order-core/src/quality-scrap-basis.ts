import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import type { TenantContext } from "@yummyai/contracts";
import { QualityScrapBasisSchema, type QualityScrapBasis } from "@yummyai/contracts/order/quality-scrap";
import type { TenantTransaction } from "@yummyai/database";
import { sql } from "drizzle-orm";

/** The database owns lot provenance, physical ancestry and remaining balances. */
export async function readQualityScrapBasis(tx: TenantTransaction, context: Pick<TenantContext, "tenantId">, productionOrderId: string): Promise<QualityScrapBasis> {
  const [row] = await tx.execute<{ basis: unknown }>(sql`select quality_scrap_basis(${context.tenantId}::uuid,${productionOrderId}::uuid) as basis`);
  if (row?.basis === null || row?.basis === undefined)
    throw new OriginalOwnerError(404, { code: "quality_scrap_not_found", message: "生产单不存在或无权访问" });
  return QualityScrapBasisSchema.parse(row.basis);
}
