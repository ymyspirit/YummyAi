import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { fulfillmentRoutes, orderFulfillmentFlows, orderFlowDispatchTenants, type TenantTransaction } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";

/** Called in the same transaction as human approval. No network, no inferred
 * approval and no historical backfill. Restarting the API preserves the intent. */
export async function scheduleOrderFlow(tx: TenantTransaction, context: TenantContext, orderId: string) {
  const [enabled] = await tx.select({ id: fulfillmentRoutes.id }).from(fulfillmentRoutes)
    .where(sql`${fulfillmentRoutes.profile}->>'mode'<>'disabled'`).limit(1);
  if (!enabled) return;
  await tx.insert(orderFlowDispatchTenants).values({ tenantId: context.tenantId }).onConflictDoNothing();
  await tx.insert(orderFulfillmentFlows).values({
    id: createEntityId(), tenantId: context.tenantId, orderId, requestedBy: context.userId, authority: context,
  }).onConflictDoNothing();
  // An approval wakes a pending continuation, but never steals a live lease or
  // silently retries a payment whose result requires reconciliation.
  await tx.update(orderFulfillmentFlows).set({ nextRunAt: new Date() })
    .where(eq(orderFulfillmentFlows.orderId, orderId));
}
