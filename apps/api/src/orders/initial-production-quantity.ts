import type { TenantTransaction } from "@yummyai/database";
import { productionRemainingQuantity } from "@yummyai/order-core";
import { sql } from "drizzle-orm";

/** Only reviewed, physically unstarted stops return ordered quantity coverage. */
export async function initialProductionAllocatedQuantity(tx: TenantTransaction, orderLineId: string) {
  const [used] = await tx.execute<{ quantity: number }>(sql`select coalesce(sum(${productionRemainingQuantity(sql`p.id`)}),0)::int as quantity
    from production_orders p join production_order_versions pv on pv.production_order_id=p.id and pv.version_number=p.current_version_number
    where p.order_line_id=${orderLineId} and p.source='initial'`);
  return Number(used?.quantity ?? 0);
}
