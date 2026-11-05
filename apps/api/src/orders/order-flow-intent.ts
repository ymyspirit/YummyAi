import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { orderFulfillmentFlows, orderFlowDispatchTenants, type TenantTransaction } from "@yummyai/database";
import { eq } from "drizzle-orm";

/** Called in the same transaction as human approval. No network, no inferred
 * approval and no historical backfill. Restarting the API preserves the intent. */
export async function scheduleOrderFlow(tx: TenantTransaction, context: TenantContext, orderId: string) {
  // Record new human approvals even when configuration is incomplete. Missing
  // setup becomes visible work, rather than silently dropping the continuation.
  await tx.insert(orderFlowDispatchTenants).values({ tenantId: context.tenantId }).onConflictDoNothing();
  await tx.insert(orderFulfillmentFlows).values({
    id: createEntityId(), tenantId: context.tenantId, orderId, requestedBy: context.userId, authority: context,
  }).onConflictDoNothing();
  const [flow] = await tx.select().from(orderFulfillmentFlows).where(eq(orderFulfillmentFlows.orderId,orderId)).for("update");
  const mayRestart = flow && ["exception","paused"].includes(flow.stage) && !flow.pendingCommand
    && !flow.productionOrderIds.length && !flow.logisticsTaskId && !flow.deliveryPackageIds.length
    && (!flow.leaseUntil || flow.leaseUntil <= new Date());
  // An approval wakes a pending continuation, but never steals a live lease or
  // silently retries a payment whose result requires reconciliation.
  await tx.update(orderFulfillmentFlows).set({ nextRunAt: new Date(),...(mayRestart ? {
    stage:"waiting_artwork" as const,reasons:[],retryCount:0,routeId:null,routeVersion:null,routeSnapshot:null,
    requestedBy:context.userId,authority:context,
  } : {}) })
    .where(eq(orderFulfillmentFlows.orderId, orderId));
}
