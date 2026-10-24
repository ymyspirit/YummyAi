import { orderProtectedDetails, orders } from "@yummyai/database";
import { and, eq, gt, isNull, ne, or, sql } from "drizzle-orm";

/** No private envelope is valid when none was supplied; an expired or anonymized envelope is never restored. */
export const nativeProductionOrderSourceAvailable = and(ne(orders.addressStatus, "anonymized"), or(
  and(eq(orders.addressStatus, "missing"), isNull(orderProtectedDetails.id)),
  and(eq(orderProtectedDetails.status, "protected"), gt(orderProtectedDetails.retentionExpiresAt, sql`clock_timestamp()`)),
));
