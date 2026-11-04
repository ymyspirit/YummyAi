import { and, isNotNull, lte, or, sql } from "drizzle-orm";
import { logisticsDocumentExports as exports, logisticsDocumentOrders as links, logisticsDocumentLabels as labels, orderPrivateSourceAvailable, type TenantTransaction } from "@yummyai/database";

/** Erase the private file when any of its original order sources is no longer readable. */
export async function purgeDocumentExports(tx: TenantTransaction, now = new Date()) {
  await tx.update(labels).set({ encryptedSnapshot: null }).where(and(isNotNull(labels.encryptedSnapshot), or(
    lte(labels.expiresAt, now), sql`not (${orderPrivateSourceAvailable(sql`${labels.orderId}`)})`,
  )));
  return tx.update(exports).set({ encryptedSnapshot: null }).where(and(isNotNull(exports.encryptedSnapshot), or(
    lte(exports.expiresAt, now),
    sql`exists (select 1 from ${links} where ${links.exportId}=${exports.id}
      and not (${orderPrivateSourceAvailable(sql`${links.orderId}`)}))`,
  ))).returning({ id: exports.id });
}
